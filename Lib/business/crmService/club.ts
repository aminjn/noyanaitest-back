import crypto from "crypto";
import mongoose from "mongoose";
import BizClubSettings, { BizClubTierKey, defaultClubTiers, IBizClubSettings, IBizClubTier } from "../../../Models/BizClubSettings";
import BizClubReward, { IBizClubReward } from "../../../Models/BizClubReward";
import BizClubRedemption, { IBizClubRedemption } from "../../../Models/BizClubRedemption";
import BizClubAdjustment from "../../../Models/BizClubAdjustment";
import BizContact, { IBizContact } from "../../../Models/BizContact";
import BizInvoice, { IBizInvoice } from "../../../Models/BizInvoice";
import AppError, { NotFoundError } from "../../AppError";
import { BizOwner } from "../coa";
import { updateInvoice } from "../invoices";
import { DAY, oid, own } from "./common";

// The patient loyalty club (2026-10), nexxacrm's «باشگاه مشتریان»
// (src/lib/club.ts, crm/club/actions.ts) made to mean something at the
// desk:
//   - a point for every `pointUnit` toman the patient paid: their visits
//     and orders on Noyan (the contact's `spent`, kept by the CRM sync) and
//     what they paid on the centre's own invoices;
//   - the tier from the total paid, each with its discount percent;
//   - rewards bought with points: a code the desk applies to the patient's
//     draft invoice, which becomes a real line discount (Lib/business/
//     invoices.ts updateInvoice), so the books show it when it is issued.
// Points are held from the moment a reward is taken; cancelling it, or the
// invoice being voided, gives them back.

// ---------------------------------------------------------------- pure

export const TIER_ORDER: BizClubTierKey[] = ["platinum", "gold", "silver", "bronze", "basic"];

// tiers from the highest down (whatever order they were saved in)
export const sortedTiers = (tiers: IBizClubTier[]) =>
  [...(tiers?.length ? tiers : defaultClubTiers())].sort((a, b) => TIER_ORDER.indexOf(a.key) - TIER_ORDER.indexOf(b.key));

export const tierOf = (tiers: IBizClubTier[], total: number): IBizClubTier => {
  const list = sortedTiers(tiers);
  return list.find((t) => total >= t.min) || list[list.length - 1];
};

// the next tier up, or null at the top (nexxacrm nextTier)
export const nextTierOf = (tiers: IBizClubTier[], tier: IBizClubTier): IBizClubTier | null => {
  const list = sortedTiers(tiers);
  const i = list.findIndex((t) => t.key === tier.key);
  return i > 0 ? list[i - 1] : null;
};

export const progressOf = (tiers: IBizClubTier[], total: number) => {
  const t = tierOf(tiers, total);
  const n = nextTierOf(tiers, t);
  return n ? Math.max(0, Math.min(100, Math.round(((total - t.min) / Math.max(1, n.min - t.min)) * 100))) : 100;
};

export const pointsOf = (total: number, unit: number) => (unit > 0 ? Math.floor(Math.max(0, total) / unit) : 0);

// what a contact earned: the amount rule plus the per-visit / per-order rule
export const earnedOf = (total: number, count: number, s: { pointUnit: number; perVisit?: number }) =>
  pointsOf(total, s.pointUnit) + Math.max(0, Math.round(s.perVisit || 0)) * Math.max(0, Math.round(count || 0));

// the toman a reward takes off `base`: a percent (capped) or an amount (at
// most the base)
export const rewardAmount = (r: { kind: string; value: number; maxDiscount?: number }, base: number) => {
  const b = Math.max(0, Math.round(base));
  const raw = r.kind === "amount" ? r.value : Math.round((b * Math.min(100, Math.max(0, r.value))) / 100);
  const capped = r.maxDiscount && r.maxDiscount > 0 ? Math.min(raw, r.maxDiscount) : raw;
  return Math.max(0, Math.min(b, Math.round(capped)));
};

// `amount` spread over lines in proportion to what each still costs; the
// rounding left over goes to the largest line, and no line goes below zero
export const splitDiscount = (room: number[], amount: number) => {
  const total = room.reduce((s, r) => s + Math.max(0, r), 0);
  const want = Math.min(Math.max(0, Math.round(amount)), total);
  if (!total || !want) return room.map(() => 0);
  const parts = room.map((r) => Math.floor((Math.max(0, r) * want) / total));
  let left = want - parts.reduce((s, p) => s + p, 0);
  const order = room.map((r, i) => [r, i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    const extra = Math.min(left, Math.max(0, room[i]) - parts[i]);
    parts[i] += extra;
    left -= extra;
  }
  return parts;
};

// ---------------------------------------------------------------- settings

export type ClubSettings = Pick<IBizClubSettings, "enabled" | "pointUnit" | "perVisit" | "tiers" | "codeDays">;

// a club not set up yet starts from its profile's rule: a pharmacy rewards
// what is spent on purchases, a practice or a lab each visit / test
const SPEND_PROFILES = ["pharmacy"];
export const defaultEarning = (kind: string) =>
  SPEND_PROFILES.includes(kind) ? { pointUnit: 10_000, perVisit: 0 } : { pointUnit: 0, perVisit: 10 };

export const clubSettings = async (owner: BizOwner): Promise<ClubSettings> => {
  const s = await BizClubSettings.findOne(own(owner)).lean<IBizClubSettings>();
  const d = defaultEarning(owner.kind);
  return {
    enabled: !!s?.enabled,
    // a saved 0 means "no points by amount"
    pointUnit: s ? (typeof s.pointUnit === "number" ? s.pointUnit : 10_000) : d.pointUnit,
    perVisit: s ? s.perVisit || 0 : d.perVisit,
    tiers: sortedTiers(s?.tiers || defaultClubTiers()),
    codeDays: s?.codeDays || 30,
  };
};

// ---------------------------------------------------------------- balances

const HOLDING = ["issued", "applied", "used"];

export type MemberRow = {
  contact: string;
  total: number;
  earned: number;
  adjusted: number;
  held: number;
  balance: number;
  tier: BizClubTierKey;
  next: BizClubTierKey | null;
  progress: number;
  discount: number;
};

// What each contact paid: their visits and orders on Noyan (`spent`), plus
// what they paid on the centre's manual invoices (matched by phone).
type ClubContact = Pick<IBizContact, "_id" | "phone" | "spent"> & Partial<Pick<IBizContact, "visits" | "orders">>;
const paidTotals = async (owner: BizOwner, contacts: ClubContact[]) => {
  const phones = contacts.map((c) => c.phone).filter(Boolean);
  const manual = phones.length
    ? await BizInvoice.aggregate([
        { $match: { ...own(owner), origin: "manual", status: { $in: ["issued", "partial", "paid"] }, "party.phone": { $in: phones } } },
        { $group: { _id: "$party.phone", paid: { $sum: "$paid" } } },
      ])
    : [];
  const byPhone = new Map(manual.map((m: { _id: string; paid: number }) => [m._id, m.paid || 0]));
  return new Map(contacts.map((c) => [String(c._id), Math.max(0, (c.spent || 0) + (byPhone.get(c.phone) || 0))]));
};

export const memberRows = async (owner: BizOwner, contacts: ClubContact[], s?: ClubSettings): Promise<MemberRow[]> => {
  if (!contacts.length) return [];
  const settings = s || (await clubSettings(owner));
  const ids = contacts.map((c) => c._id);
  const [totals, adj, held] = await Promise.all([
    paidTotals(owner, contacts),
    BizClubAdjustment.aggregate([{ $match: { ...own(owner), contact: { $in: ids } } }, { $group: { _id: "$contact", n: { $sum: "$points" } } }]),
    BizClubRedemption.aggregate([
      { $match: { ...own(owner), contact: { $in: ids }, status: { $in: HOLDING } } },
      { $group: { _id: "$contact", n: { $sum: "$points" } } },
    ]),
  ]);
  const adjBy = new Map(adj.map((a: { _id: unknown; n: number }) => [String(a._id), a.n]));
  const heldBy = new Map(held.map((a: { _id: unknown; n: number }) => [String(a._id), a.n]));
  return contacts.map((c) => {
    const id = String(c._id);
    const total = totals.get(id) || 0;
    const earned = earnedOf(total, (c.visits || 0) + (c.orders || 0), settings);
    const adjusted = adjBy.get(id) || 0;
    const h = heldBy.get(id) || 0;
    const tier = tierOf(settings.tiers, total);
    const next = nextTierOf(settings.tiers, tier);
    return {
      contact: id,
      total,
      earned,
      adjusted,
      held: h,
      balance: Math.max(0, earned + adjusted - h),
      tier: tier.key,
      next: next?.key || null,
      progress: progressOf(settings.tiers, total),
      discount: tier.discount,
    };
  });
};

// what a member row is worked out from
export const CLUB_FIELDS = "phone spent visits orders name user";

export const memberOf = async (owner: BizOwner, contactId: unknown) => {
  const c = await BizContact.findOne({ ...own(owner), _id: oid(contactId) }).select(CLUB_FIELDS).lean<IBizContact>();
  if (!c) throw new AppError("این بیمار پیدا نشد", 404);
  const [row] = await memberRows(owner, [c]);
  return { contact: c, row };
};

// ---------------------------------------------------------------- redemption

const newCode = () => {
  const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(8), (b) => ALNUM[b % ALNUM.length]).join("");
};

// A reward taken with points (by the patient, or by the desk for them).
export const redeemReward = async (owner: BizOwner, contactId: unknown, rewardId: unknown, by: unknown, byPatient: boolean) => {
  const settings = await clubSettings(owner);
  if (!settings.enabled) throw new AppError("باشگاه این مرکز فعال نیست", 400);
  const reward = await BizClubReward.findOne({ ...own(owner), _id: oid(rewardId), active: true }).lean<IBizClubReward>();
  if (!reward) throw new AppError("این جایزه دیگر در دسترس نیست", 404);
  await reconcileRedemptions(owner);
  const { row } = await memberOf(owner, contactId);
  if (row.balance < reward.points) throw new AppError("امتیاز کافی برای این جایزه ندارید", 400);
  for (let i = 0; i < 5; i++) {
    const doc = await BizClubRedemption.create({
      ...own(owner),
      contact: oid(contactId),
      reward: reward._id,
      name: reward.name,
      kind: reward.kind,
      value: reward.value,
      maxDiscount: reward.maxDiscount || 0,
      points: reward.points,
      code: newCode(),
      status: "issued",
      expiresAt: new Date(Date.now() + settings.codeDays * DAY),
      byPatient,
      createdBy: by,
    }).catch((err) => ((err as { code?: number })?.code === 11000 ? null : Promise.reject(err)));
    if (doc) {
      // two redemptions at once may both have passed the check: the later
      // one is taken back if the balance went below zero
      const c = await BizContact.findById(oid(contactId)).select(CLUB_FIELDS).lean<IBizContact>();
      const [after] = c ? await memberRows(owner, [c], settings) : [];
      if (after && after.earned + after.adjusted - after.held < 0) {
        await BizClubRedemption.deleteOne({ _id: doc._id });
        throw new AppError("امتیاز کافی برای این جایزه ندارید", 400);
      }
      return doc.toObject() as IBizClubRedemption;
    }
  }
  throw new AppError("ساخت کد جایزه ناموفق بود؛ دوباره تلاش کنید", 500);
};

// The tier's own discount as a code (no points spent), made by the desk.
export const tierDiscountCode = async (owner: BizOwner, contactId: unknown, by: unknown) => {
  const settings = await clubSettings(owner);
  if (!settings.enabled) throw new AppError("باشگاه این مرکز فعال نیست", 400);
  const { row } = await memberOf(owner, contactId);
  if (!row.discount) throw new AppError("سطح این بیمار تخفیفی ندارد", 400);
  const open = await BizClubRedemption.findOne({ ...own(owner), contact: oid(contactId), kind: "tier", status: { $in: ["issued", "applied"] } }).lean();
  if (open) return open as IBizClubRedemption;
  const doc = await BizClubRedemption.create({
    ...own(owner),
    contact: oid(contactId),
    name: row.tier,
    kind: "tier",
    value: row.discount,
    maxDiscount: 0,
    points: 0,
    code: newCode(),
    status: "issued",
    expiresAt: new Date(Date.now() + settings.codeDays * DAY),
    byPatient: false,
    createdBy: by,
  });
  return doc.toObject() as IBizClubRedemption;
};

// the invoice's own input again, for updateInvoice
const inputOf = (inv: IBizInvoice, discounts: number[]) => ({
  date: inv.date,
  dueDate: inv.dueDate || null,
  party: { name: inv.party?.name || "", phone: inv.party?.phone, nationalId: inv.party?.nationalId },
  doctorName: inv.doctorName,
  lines: inv.lines.map((l, i) => ({
    title: l.title,
    qty: l.qty,
    unitPrice: l.unitPrice,
    discount: discounts[i] ?? l.discount,
    taxRate: l.taxRate,
    account: l.account ? String(l.account) : undefined,
  })),
  insurer: inv.insurer ? { kind: inv.insurer.kind, name: inv.insurer.name, share: inv.insurer.share } : null,
  note: inv.note,
  center: inv.center ? String(inv.center) : undefined,
});

// A code on a draft invoice of the same patient: the discount spread over
// its lines. One code per invoice.
export const applyCode = async (owner: BizOwner, code: string, invoiceId: unknown) => {
  await reconcileRedemptions(owner);
  const r = await BizClubRedemption.findOne({ ...own(owner), code: String(code || "").trim().toUpperCase() }).lean<IBizClubRedemption>();
  if (!r) throw new AppError("این کد باشگاه پیدا نشد", 404);
  if (r.status !== "issued") throw new AppError("این کد قبلاً استفاده یا لغو شده است", 400);
  const inv = await BizInvoice.findOne({ ...own(owner), _id: oid(invoiceId) }).lean<IBizInvoice>();
  if (!inv) throw new AppError("صورتحساب پیدا نشد", 404);
  if (inv.status !== "draft" || inv.origin !== "manual") throw new AppError("کد باشگاه فقط روی پیش‌نویس صورتحساب اعمال می‌شود", 400);
  if (await BizClubRedemption.exists({ ...own(owner), invoice: inv._id, status: "applied" })) throw new AppError("روی این صورتحساب یک کد باشگاه اعمال شده است", 400);
  const c = await BizContact.findOne({ ...own(owner), _id: r.contact }).select("phone name").lean<IBizContact>();
  if (!c) throw new AppError("این بیمار پیدا نشد", 404);
  const phone = (inv.party?.phone || "").replace(/\D/g, "").replace(/^98/, "0");
  if (phone && phone !== c.phone) throw new AppError("این کد مال بیمار دیگری است", 400);
  const room = inv.lines.map((l) => Math.round(l.qty * l.unitPrice) - (l.discount || 0));
  const base = room.reduce((s, x) => s + Math.max(0, x), 0);
  const amount = rewardAmount(r, base);
  if (!amount) throw new AppError("مبلغی برای تخفیف روی این صورتحساب نیست", 400);
  const shares = splitDiscount(room, amount);
  const input = inputOf(inv, inv.lines.map((l, i) => (l.discount || 0) + shares[i]));
  if (!phone) input.party = { ...input.party, phone: c.phone, name: input.party.name || c.name };
  // claim the code first, so two desks can't spend it at once
  const claimed = await BizClubRedemption.updateOne(
    { _id: r._id, status: "issued" },
    { $set: { status: "applied", invoice: inv._id, discountAmount: amount, lineDiscounts: shares } },
  );
  if (!claimed.modifiedCount) throw new AppError("این کد قبلاً استفاده یا لغو شده است", 400);
  try {
    await updateInvoice(owner, String(inv._id), input as never);
  } catch (err) {
    await BizClubRedemption.updateOne({ _id: r._id }, { $set: { status: "issued", discountAmount: 0, lineDiscounts: [] }, $unset: { invoice: 1 } });
    throw err;
  }
  return { ...r, status: "applied", invoice: inv._id, discountAmount: amount };
};

// Takes an applied code off its (still draft) invoice: the line discounts
// it added come off, and the code can be used again.
export const unapplyCode = async (owner: BizOwner, redemptionId: unknown) => {
  const r = await BizClubRedemption.findOne({ ...own(owner), _id: oid(redemptionId) }).lean<IBizClubRedemption>();
  if (!r) throw new AppError("این کد باشگاه پیدا نشد", 404);
  if (r.status !== "applied") throw new AppError("این کد روی صورتحسابی نیست", 400);
  const inv = r.invoice ? await BizInvoice.findOne({ ...own(owner), _id: r.invoice }).lean<IBizInvoice>() : null;
  if (inv && inv.status !== "draft") throw new AppError("صورتحساب صادر شده است؛ برای برگرداندن تخفیف آن را باطل کنید", 400);
  if (inv) {
    const back = inv.lines.map((l, i) => Math.max(0, (l.discount || 0) - (r.lineDiscounts?.[i] || 0)));
    await updateInvoice(owner, String(inv._id), inputOf(inv, back) as never);
  }
  await BizClubRedemption.updateOne({ _id: r._id }, { $set: { status: "issued", discountAmount: 0, lineDiscounts: [] }, $unset: { invoice: 1 } });
};

export const cancelRedemption = async (owner: BizOwner, redemptionId: unknown, reason: string, contactId?: unknown) => {
  const r = await BizClubRedemption.findOne({
    ...own(owner),
    _id: oid(redemptionId),
    ...(contactId ? { contact: oid(contactId) } : {}),
  }).lean<IBizClubRedemption>();
  if (!r) throw new AppError("این کد باشگاه پیدا نشد", 404);
  if (r.status === "applied") await unapplyCode(owner, r._id);
  else if (r.status !== "issued") throw new AppError("فقط کد استفاده‌نشده لغو می‌شود", 400);
  await BizClubRedemption.updateOne(
    { _id: r._id, status: "issued" },
    { $set: { status: "cancelled", cancelledAt: new Date(), cancelReason: reason.slice(0, 300) } },
  );
};

// Codes follow their invoice: issued -> used; voided -> cancelled (points
// back); a deleted draft frees the code; past its date -> expired (points
// back). Run before balances are read and by the job.
export const reconcileRedemptions = async (owner?: BizOwner) => {
  const scope = owner ? own(owner) : {};
  const now = new Date();
  await BizClubRedemption.updateMany({ ...scope, status: "issued", expiresAt: { $lt: now } }, { $set: { status: "expired" } });
  const applied = await BizClubRedemption.find({ ...scope, status: { $in: ["applied", "used"] } })
    .select("invoice status ownerKind ownerId")
    .limit(2000)
    .lean<IBizClubRedemption[]>();
  if (!applied.length) return;
  const invs = await BizInvoice.find({ _id: { $in: applied.map((a) => a.invoice).filter(Boolean) } })
    .select("status")
    .lean<{ _id: unknown; status: string }[]>();
  const statusOf = new Map(invs.map((i) => [String(i._id), i.status]));
  for (const a of applied) {
    const st = a.invoice ? statusOf.get(String(a.invoice)) : undefined;
    if (!st && a.status === "applied")
      await BizClubRedemption.updateOne({ _id: a._id, status: "applied" }, { $set: { status: "issued", discountAmount: 0, lineDiscounts: [] }, $unset: { invoice: 1 } });
    else if (st === "void")
      await BizClubRedemption.updateOne({ _id: a._id }, { $set: { status: "cancelled", cancelledAt: now, cancelReason: "void" } });
    else if (st && st !== "draft" && a.status === "applied")
      await BizClubRedemption.updateOne({ _id: a._id, status: "applied" }, { $set: { status: "used", usedAt: now } });
  }
};

// points given or taken by hand or by a workflow (once per dedupeKey)
// A deduction never takes more than the usable balance: a balance below
// zero would be shown as 0 and silently eat the points earned next.
export const adjustPoints = async (owner: BizOwner, contactId: unknown, points: number, reason: string, by?: unknown, dedupeKey?: string) => {
  if (!Number.isFinite(points) || !points) throw new AppError("تعداد امتیاز را بنویسید", 400);
  if (!(await BizContact.exists({ ...own(owner), _id: oid(contactId) }))) throw new AppError("این بیمار پیدا نشد", 404);
  let pts = Math.round(points);
  if (pts < 0) {
    await reconcileRedemptions(owner);
    const { row } = await memberOf(owner, contactId);
    if (row.balance + pts < 0) {
      // a workflow's deduction takes what is there; a person is told
      if (!dedupeKey) throw new AppError("کسر امتیاز بیش از امتیاز قابل‌استفاده‌ی این بیمار است", 400);
      if (row.balance <= 0) return null;
      pts = -row.balance;
    }
  }
  const doc = await BizClubAdjustment.create({ ...own(owner), contact: oid(contactId), points: pts, reason: reason.slice(0, 200), createdBy: by, ...(dedupeKey ? { dedupeKey } : {}) }).catch(
    (err) => ((err as { code?: number })?.code === 11000 ? null : Promise.reject(err)),
  );
  // two deductions at once may both have passed the check: the later one is
  // taken back (the same guard redeemReward uses)
  if (doc && pts < 0) {
    const { row } = await memberOf(owner, contactId);
    if (row.earned + row.adjusted - row.held < 0) {
      await BizClubAdjustment.deleteOne({ _id: doc._id });
      if (dedupeKey) return null;
      throw new AppError("کسر امتیاز بیش از امتیاز قابل‌استفاده‌ی این بیمار است", 400);
    }
  }
  return doc;
};

// A hand-given bonus taken back - only while its points are still unspent.
export const removeAdjustment = async (owner: BizOwner, adjustmentId: unknown) => {
  const a = await BizClubAdjustment.findOne({ ...own(owner), _id: oid(adjustmentId), dedupeKey: { $exists: false } }).lean<{ _id: unknown; contact: unknown; points: number }>();
  if (!a) throw new NotFoundError();
  if (a.points > 0) {
    await reconcileRedemptions(owner);
    const { row } = await memberOf(owner, a.contact);
    if (row.balance < a.points) throw new AppError("امتیاز این مورد خرج جایزه شده است و برنمی‌گردد", 400);
  }
  const r = await BizClubAdjustment.deleteOne({ _id: a._id });
  if (!r.deletedCount) throw new NotFoundError();
};

export const isObjectId = (v: unknown) => mongoose.isValidObjectId(v);
