import mongoose from "mongoose";
import BizClaim, { IBizClaim, IBizClaimItem } from "../../Models/BizClaim";
import BizInvoice, { BizInsurerKind, IBizInvoice } from "../../Models/BizInvoice";
import BizPayment from "../../Models/BizPayment";
import Insurance from "../../Models/Insurance";
import Notification from "../../Models/Notification";
import Reservation, { IReservation } from "../../Models/Reservation";
import AppError from "../AppError";
import { BizOwner } from "./coa";
import { nextDocNumber } from "./voucher";
import { assertOpen, defaultIncomeRole, docRefs, oid, ownerDoc, postDoc, reverseRef, toman } from "./finance";
import { claimStatus } from "./payments";
import { orgInfo } from "./campaign";

// Insurance claims (2026-10, «مطالبات بیمه»): what an Iranian practice
// actually lives on - the monthly list (لیست) of the insurer's share sent to
// Tamin, Salamat, the armed forces' insurer or a supplementary insurer,
// paid months later and seldom in full (کسورات). A claim gathers the
// insurer shares of the period's invoices (already booked to 1412 when the
// invoice was issued) and any line typed into it (booked when the claim is
// submitted). Payments come through «دریافت و پرداخت» against the claim; a
// deduction or a rejection writes the rest off:
//
//   submitted, typed lines   Dr 1412 insurers           Cr income
//   deduction / rejection    Dr 7211 insurance deductions Cr 1412 insurers

export type ClaimInput = {
  insurer: { kind: BizInsurerKind; name: string };
  from?: Date | null;
  to?: Date | null;
  invoices?: string[];
  items?: { date: Date; patient: string; service: string; total: number; share: number }[];
  note?: string;
  // (2026-10) the insurer's Noyan profile, when the insurer reviews and
  // pays its lists on Noyan (Lib/business/insurerClaims.ts)
  insurerProfile?: string | null;
};

// the insurer's Noyan profile a list is sent to: active, with its own
// panel (a user), else none
const insurerProfileOf = async (id?: string | null) => {
  if (!id) return null;
  if (!mongoose.isValidObjectId(id)) throw new AppError("بیمه‌ی انتخاب‌شده در نویان پیدا نشد", 400);
  const ins = await Insurance.findOne({ _id: id, active: true, user: { $exists: true, $ne: null } }).select("name").lean<{ _id: mongoose.Types.ObjectId; name?: string }>();
  if (!ins) throw new AppError("بیمه‌ی انتخاب‌شده در نویان پیدا نشد", 400);
  return ins;
};

// a list the insurer reviews on Noyan: its deductions and receipts come
// from the insurer's decisions, not typed by the centre
export const insurerHandles = (c: Pick<IBizClaim, "insurerProfile" | "review">) => !!(c.insurerProfile && c.review);

// (2026-10) The insurers' shares of a doctor's visits paid on Noyan
// (Lib/business/reservationInsurance.ts): booked when the visit took place,
// not on a list yet. Each is one candidate «res:<reservation>:<line>», in
// the invoice candidates' shape.
const RES_ID = /^res:([0-9a-fA-F]{24}):(\d{1,2})$/;
const resCandidateId = (reservation: unknown, line: number) => `res:${String(reservation)}:${line}`;

const SESSION_TITLES: Record<string, string> = {
  inPerson: "ویزیت حضوری",
  textChat: "مشاوره‌ی پزشکی متنی",
  sipCall: "مشاوره‌ی پزشکی تلفنی",
  voiceCall: "مشاوره‌ی پزشکی صوتی",
  videoCall: "مشاوره‌ی پزشکی تصویری",
  phone: "مشاوره‌ی پزشکی تلفنی",
};

type ResLine = { reservation: mongoose.Types.ObjectId; line: number; date: Date; patient: string; service: string; total: number; share: number; kind: string; name: string };

const reservationLines = async (
  owner: BizOwner,
  q: { kind?: BizInsurerKind; name?: string; from?: Date | null; to?: Date | null; ids?: { reservation: string; line: number }[]; claimId?: unknown },
): Promise<ResLine[]> => {
  if (owner.kind !== "doctor" || !owner.id) return [];
  const filter: Record<string, unknown> = { doctor: oid(owner.id), "insuranceQuote.lines.status": "booked" };
  if (q.ids) filter._id = { $in: q.ids.map((i) => oid(i.reservation)) };
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const rows = await Reservation.find(filter)
    .sort({ date: 1 })
    .limit(1000)
    .select("date sessionType patient insuranceQuote")
    .populate({ path: "patient", select: "givenName lastName" })
    .lean<IReservation[]>();
  const want = q.ids ? new Set(q.ids.map((i) => `${i.reservation}:${i.line}`)) : null;
  const out: ResLine[] = [];
  for (const r of rows)
    (r.insuranceQuote?.lines || []).forEach((l, i) => {
      if (l.status !== "booked" || !(l.share > 0)) return;
      if (l.claim && !(q.claimId && String(l.claim) === String(q.claimId))) return;
      if (want && !want.has(`${String(r._id)}:${i}`)) return;
      if (q.kind && l.kind !== q.kind) return;
      if (q.name && l.name !== q.name) return;
      const p = (r.patient || {}) as { givenName?: string; lastName?: string };
      out.push({
        reservation: r._id as unknown as mongoose.Types.ObjectId,
        line: i,
        date: r.date,
        patient: `${p.givenName || ""} ${p.lastName || ""}`.trim(),
        service: SESSION_TITLES[r.sessionType] || "ویزیت پزشک",
        total: r.insuranceQuote?.price || 0,
        share: l.share,
        kind: l.kind,
        name: l.name,
      });
    });
  return out;
};

// the reservation lines of a list point back at it (or are let go)
const markReservationLines = async (claimId: unknown, items: Pick<IBizClaimItem, "reservation" | "line">[]) => {
  for (const it of items)
    if (it.reservation && typeof it.line === "number")
      await Reservation.updateOne({ _id: it.reservation }, { $set: { [`insuranceQuote.lines.${it.line}.claim`]: claimId } });
};
const releaseReservationLines = async (claimId: unknown, keep: Pick<IBizClaimItem, "reservation" | "line">[] = []) => {
  const kept = new Set(keep.filter((k) => k.reservation).map((k) => `${String(k.reservation)}:${k.line}`));
  const rows = await Reservation.find({ "insuranceQuote.lines.claim": claimId }).select("insuranceQuote.lines").lean<IReservation[]>();
  for (const r of rows)
    for (const [i, l] of (r.insuranceQuote?.lines || []).entries())
      if (String(l.claim || "") === String(claimId) && !kept.has(`${String(r._id)}:${i}`))
        await Reservation.updateOne({ _id: r._id }, { $unset: { [`insuranceQuote.lines.${i}.claim`]: 1 } });
};

// invoices with an insurer share not yet on a claim (and, for a doctor,
// the insurers' shares of visits paid on Noyan)
export const claimCandidates = async (owner: BizOwner, q: { kind?: BizInsurerKind; name?: string; from?: Date | null; to?: Date | null }) => {
  const filter: Record<string, unknown> = {
    ...ownerDoc(owner),
    origin: "manual",
    status: { $in: ["issued", "partial", "paid"] },
    "insurer.share": { $gt: 0 },
    claim: { $exists: false },
  };
  if (q.kind) filter["insurer.kind"] = q.kind;
  if (q.name) filter["insurer.name"] = q.name;
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const invoices = await BizInvoice.find(filter).sort({ date: 1 }).limit(1000).select("number date party insurer total lines.title").lean();
  const visits = (await reservationLines(owner, q)).map((l) => ({
    _id: resCandidateId(l.reservation, l.line),
    source: "reservation",
    number: 0,
    date: l.date,
    party: { name: l.patient },
    insurer: { kind: l.kind, name: l.name, share: l.share },
    total: l.total,
    lines: [{ title: l.service }],
  }));
  return [...invoices, ...visits].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
};

const itemsOf = async (owner: BizOwner, input: ClaimInput, claimId?: unknown) => {
  const ids = (input.invoices || []).filter((i) => mongoose.isValidObjectId(i)).map((i) => oid(i));
  // «res:<reservation>:<line>»: an insurer's share of a visit on Noyan
  const resIds = (input.invoices || [])
    .map((i) => RES_ID.exec(String(i)))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ reservation: m[1], line: Number(m[2]) }));
  const invoices = ids.length
    ? await BizInvoice.find({
        ...ownerDoc(owner),
        _id: { $in: ids },
        "insurer.share": { $gt: 0 },
        status: { $nin: ["draft", "void"] },
        $or: [{ claim: { $exists: false } }, ...(claimId ? [{ claim: claimId }] : [])],
      }).lean<IBizInvoice[]>()
    : [];
  // (2026-10) one list is one insurer: each invoice booked its share on
  // that insurer's own تفصیلی, and the list's receipts and deductions clear
  // the list's insurer - an invoice of another insurer (two supplementary
  // insurers share a kind) would never clear
  const norm = (n?: string) => (n || "").trim().replace(/\s+/g, " ");
  if (invoices.some((inv) => norm(inv.insurer?.name) !== norm(input.insurer?.name)))
    throw new AppError("صورتحساب‌های یک لیست باید سهم همین بیمه را داشته باشند", 400);
  const visits = resIds.length ? await reservationLines(owner, { ids: resIds, claimId }) : [];
  if (visits.some((v) => norm(v.name) !== norm(input.insurer?.name)))
    throw new AppError("صورتحساب‌های یک لیست باید سهم همین بیمه را داشته باشند", 400);
  const fromVisits: IBizClaimItem[] = visits.map((v) => ({
    reservation: v.reservation,
    line: v.line,
    date: v.date,
    patient: v.patient,
    service: v.service,
    total: v.total,
    share: v.share,
  }));
  const fromInvoices: IBizClaimItem[] = invoices.map((inv) => ({
    invoice: inv._id as unknown as mongoose.Types.ObjectId,
    date: inv.date,
    patient: inv.party?.name || "",
    service: inv.lines.map((l) => l.title).join("، ").slice(0, 300),
    total: inv.total,
    share: inv.insurer?.share || 0,
  }));
  const typed: IBizClaimItem[] = (input.items || [])
    .map((i) => ({
      date: i.date,
      patient: String(i.patient || "").trim().slice(0, 200),
      service: String(i.service || "").trim().slice(0, 300),
      total: toman(i.total),
      share: Math.min(toman(i.share), toman(i.total) || toman(i.share)),
    }))
    .filter((i) => i.share > 0 && i.date instanceof Date && !Number.isNaN(i.date.getTime()));
  return { items: [...fromInvoices, ...fromVisits, ...typed], invoiceIds: invoices.map((i) => i._id) };
};

export const createClaim = async (owner: BizOwner, input: ClaimInput, by?: unknown) => {
  if (owner.kind === "insurance") throw new AppError("این بخش برای این حساب نیست", 400);
  if (!input.insurer?.name?.trim()) throw new AppError("نام بیمه را بنویسید", 400);
  const profile = await insurerProfileOf(input.insurerProfile);
  // one name for the insurer on both sides: its تفصیلی here follows its profile
  if (profile?.name) input = { ...input, insurer: { ...input.insurer, name: profile.name } };
  const { items, invoiceIds } = await itemsOf(owner, input);
  if (!items.length) throw new AppError("دست‌کم یک ردیف به لیست بیمه اضافه کنید", 400);
  const claim = await BizClaim.create({
    ...ownerDoc(owner),
    number: await nextDocNumber("claim", owner),
    insurerProfile: profile?._id,
    insurer: { kind: input.insurer.kind, name: input.insurer.name.trim().slice(0, 120) },
    from: input.from || undefined,
    to: input.to || undefined,
    items,
    claimed: items.reduce((s, i) => s + i.share, 0),
    status: "draft",
    note: input.note?.trim().slice(0, 1000) || undefined,
    createdBy: by,
  });
  await BizInvoice.updateMany({ _id: { $in: invoiceIds } }, { $set: { claim: claim._id } });
  await markReservationLines(claim._id, items);
  return claim.toObject();
};

export const updateClaim = async (owner: BizOwner, id: string, input: ClaimInput) => {
  const claim = await BizClaim.findOne({ ...ownerDoc(owner), _id: id });
  if (!claim) throw new AppError("لیست بیمه پیدا نشد", 404);
  if (claim.status !== "draft") throw new AppError("لیست ارسال‌شده تغییر نمی‌کند", 400);
  const profile = await insurerProfileOf(input.insurerProfile);
  if (profile?.name) input = { ...input, insurer: { ...input.insurer, name: profile.name } };
  const { items, invoiceIds } = await itemsOf(owner, input, claim._id);
  if (!items.length) throw new AppError("دست‌کم یک ردیف به لیست بیمه اضافه کنید", 400);
  await BizInvoice.updateMany({ claim: claim._id, _id: { $nin: invoiceIds } }, { $unset: { claim: 1 } });
  await BizInvoice.updateMany({ _id: { $in: invoiceIds } }, { $set: { claim: claim._id } });
  claim.insurer = { kind: input.insurer.kind, name: input.insurer.name.trim().slice(0, 120) };
  claim.from = input.from || undefined;
  claim.to = input.to || undefined;
  claim.items = items;
  claim.claimed = items.reduce((s, i) => s + i.share, 0);
  claim.note = input.note?.trim().slice(0, 1000) || undefined;
  claim.insurerProfile = profile?._id;
  await claim.save();
  await releaseReservationLines(claim._id, items);
  await markReservationLines(claim._id, items);
  return claim.toObject();
};

export const deleteClaim = async (owner: BizOwner, id: string) => {
  const claim = await BizClaim.findOne({ ...ownerDoc(owner), _id: id });
  if (!claim) throw new AppError("لیست بیمه پیدا نشد", 404);
  if (claim.status !== "draft") throw new AppError("لیست ارسال‌شده حذف نمی‌شود", 400);
  await BizInvoice.updateMany({ claim: claim._id }, { $unset: { claim: 1 } });
  await releaseReservationLines(claim._id);
  await BizClaim.deleteOne({ _id: claim._id });
};

export const submitClaim = async (owner: BizOwner, id: string, d: { date?: Date; trackingCode?: string }, by?: unknown) => {
  const claim = await BizClaim.findOne({ ...ownerDoc(owner), _id: id });
  if (!claim) throw new AppError("لیست بیمه پیدا نشد", 404);
  if (claim.status !== "draft") throw new AppError("این لیست قبلاً ارسال شده است", 400);
  const date = d.date || new Date();
  await assertOpen(owner, date);
  // each submission has its own vouchers (a claim opened again and sent
  // anew must not hit the old refs)
  claim.round = (claim.round || 0) + 1;
  // the typed lines were never booked: they are now
  // (a visit's insurer share on Noyan was booked when the visit took place)
  const typed = claim.items.filter((i) => !i.invoice && !i.reservation).reduce((s, i) => s + i.share, 0);
  if (typed > 0)
    await postDoc(owner, {
      ref: `claim:${claim._id}:${claim.round}`,
      date,
      description: "ارسال لیست بیمه",
      lines: [
        { role: "insuranceReceivable", debit: typed, credit: 0, label: `${claim.insurer.name} · #${claim.number}` },
        { role: defaultIncomeRole(owner.kind), debit: 0, credit: typed, label: `${claim.insurer.name} · #${claim.number}` },
      ],
      source: { type: "claim", id: claim._id },
      createdBy: by,
      party: claim.insurer?.name ? { kind: "insurer", name: claim.insurer.name } : undefined,
    });
  claim.status = "submitted";
  claim.submittedAt = date;
  if (d.trackingCode) claim.trackingCode = d.trackingCode.slice(0, 80);
  claim.status = claimStatus(claim);
  // (2026-10) to an insurer on Noyan: the list lands in its panel
  // («مطالبات دریافتی از مراکز»), every line undecided
  if (claim.insurerProfile) {
    const org = await orgInfo(owner).catch(() => null);
    claim.centreName = (org?.name || "").slice(0, 200) || undefined;
    claim.items.forEach((i) => (i.decision = undefined));
    claim.review = { status: "pending", receivedAt: new Date(), seq: 0, approved: 0, deducted: 0, paid: 0, payments: [] };
  }
  await claim.save();
  if (claim.insurerProfile) {
    const ins = await Insurance.findById(claim.insurerProfile).select("user").lean<{ user?: unknown }>();
    if (ins?.user)
      await Notification.create({
        user: ins.user,
        source: "System",
        title: "لیست بیمه‌ی تازه از مرکز درمانی",
        message: "${1} لیست شماره‌ی ${2} را با ${3} ردیف و مبلغ ${4} تومان برای رسیدگی فرستاد."
          .replace("${1}", claim.centreName || "—")
          .replace("${2}", String(claim.number))
          .replace("${3}", String(claim.items.length))
          .replace("${4}", Math.round(claim.claimed).toLocaleString("en-US")),
        link: `/insurancepanel/finance/claims?claim=${claim._id}`,
      }).catch(() => undefined);
  }
  return claim.toObject();
};

// A deduction (کسورات) or, with all = true, the rejection of what is still
// open, with its reason.
export const deductClaim = async (
  owner: BizOwner,
  id: string,
  d: { amount?: number; reason: string; all?: boolean; date?: Date; fromInsurer?: boolean },
  by?: unknown,
) => {
  const claim = await BizClaim.findOne({ ...ownerDoc(owner), _id: id });
  if (!claim) throw new AppError("لیست بیمه پیدا نشد", 404);
  if (claim.status === "draft") throw new AppError("لیست بیمه هنوز ارسال نشده است", 400);
  if (insurerHandles(claim) && !d.fromInsurer) throw new AppError("این لیست را بیمه در نویان رسیدگی می‌کند؛ کسورات و پرداخت از طرف بیمه ثبت می‌شود", 400);
  const open = claim.claimed - claim.paid - claim.deducted;
  const amount = d.all ? open : Math.min(open, toman(d.amount));
  if (amount <= 0) throw new AppError("مبلغ را وارد کنید", 400);
  if (!d.reason?.trim()) throw new AppError("دلیل کسر یا رد را بنویسید", 400);
  const date = d.date || new Date();
  await assertOpen(owner, date);
  const label = `${claim.insurer.name} · #${claim.number} · ${d.reason.trim()}`.slice(0, 300);
  await postDoc(owner, {
    ref: `claim:${claim._id}:${claim.round || 0}:ded:${claim.deductions.length}`,
    date,
    description: "کسورات بیمه",
    lines: [
      { role: "insuranceDeductions", debit: amount, credit: 0, label },
      { role: "insuranceReceivable", debit: 0, credit: amount, label },
    ],
    source: { type: "claim", id: claim._id },
    createdBy: by,
    party: claim.insurer?.name ? { kind: "insurer", name: claim.insurer.name } : undefined,
  });
  claim.deductions.push({ amount, reason: d.reason.trim().slice(0, 500), at: date });
  claim.deducted += amount;
  if (d.all) claim.rejectReason = d.reason.trim().slice(0, 500);
  claim.status = claimStatus(claim);
  await claim.save();
  return claim.toObject();
};

// Opens a submitted claim again (a mistake in the list): its typed lines'
// voucher and its deductions are reversed. Not once the insurer paid.
export const reopenClaim = async (owner: BizOwner, id: string) => {
  const claim = await BizClaim.findOne({ ...ownerDoc(owner), _id: id });
  if (!claim) throw new AppError("لیست بیمه پیدا نشد", 404);
  if (claim.status === "draft") return claim.toObject();
  // the insurer's result is one-way: once registered the list stays
  if (claim.review && claim.review.status !== "pending")
    throw new AppError("بیمه نتیجه‌ی رسیدگی این لیست را ثبت کرده است و بازگشایی نمی‌شود", 400);
  if (await BizPayment.exists({ ...ownerDoc(owner), claim: claim._id, isVoid: false }))
    throw new AppError("ابتدا دریافت‌های این لیست را باطل کنید", 400);
  await assertOpen(owner, new Date());
  for (const ref of await docRefs(owner, `claim:${claim._id}:${claim.round || 0}`)) await reverseRef(owner, ref, "بازگشایی لیست بیمه");
  claim.status = "draft";
  claim.deducted = 0;
  claim.deductions = [];
  claim.rejectReason = undefined;
  claim.submittedAt = undefined;
  // a pending list leaves the insurer's queue until it is sent again
  claim.review = undefined;
  claim.items.forEach((i) => (i.decision = undefined));
  await claim.save();
  return claim.toObject();
};

export const listClaims = async (owner: BizOwner, q: { status?: string; kind?: string }) => {
  const filter: Record<string, unknown> = { ...ownerDoc(owner) };
  if (q.status === "open") filter.status = { $in: ["submitted", "partial"] };
  else if (q.status) filter.status = q.status;
  if (q.kind) filter["insurer.kind"] = q.kind;
  const items = await BizClaim.find(filter).sort({ createdAt: -1 }).limit(300).select("-items").lean<IBizClaim[]>();
  const now = Date.now();
  // aging of what is still open, from the day it was sent
  const buckets = { d30: 0, d60: 0, d90: 0, older: 0 };
  for (const c of items) {
    const open = c.claimed - c.paid - c.deducted;
    if (c.status === "draft" || open <= 0 || !c.submittedAt) continue;
    const days = (now - new Date(c.submittedAt).getTime()) / 864e5;
    if (days <= 30) buckets.d30 += open;
    else if (days <= 60) buckets.d60 += open;
    else if (days <= 90) buckets.d90 += open;
    else buckets.older += open;
  }
  const unclaimed = await BizInvoice.aggregate([
    { $match: { ...ownerDoc(owner), origin: "manual", status: { $nin: ["draft", "void"] }, "insurer.share": { $gt: 0 }, claim: { $exists: false } } },
    { $group: { _id: null, sum: { $sum: "$insurer.share" }, n: { $sum: 1 } } },
  ]);
  const visits = await reservationLines(owner, {});
  return {
    items,
    aging: buckets,
    unclaimed: {
      amount: (unclaimed[0]?.sum || 0) + visits.reduce((s, v) => s + v.share, 0),
      count: (unclaimed[0]?.n || 0) + visits.length,
    },
  };
};

export const getClaim = async (owner: BizOwner, id: string) => {
  const claim = await BizClaim.findOne({ ...ownerDoc(owner), _id: id }).lean();
  if (!claim) throw new AppError("لیست بیمه پیدا نشد", 404);
  const payments = await BizPayment.find({ ...ownerDoc(owner), claim: claim._id }).sort({ date: 1 }).populate({ path: "money", select: "name kind" }).lean();
  return { ...claim, payments };
};
