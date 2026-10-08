import { startOfTehranDay } from "../tehranTime";
import mongoose from "mongoose";
import BizClaim, { BizClaimLineDecision, IBizClaim } from "../../Models/BizClaim";
import BizMoneyAccount, { IBizMoneyAccount } from "../../Models/BizMoneyAccount";
import Insurance from "../../Models/Insurance";
import Notification from "../../Models/Notification";
import AppError from "../AppError";
import { BizOwner, ownerFilter } from "./coa";
import { assertOpen, ensureMoneyAccounts, oid, reverseRef, toman } from "./finance";
import { postVoucher } from "./voucher";
import { deductClaim } from "./claims";
import { createPayment } from "./payments";
import { orgInfo } from "./campaign";
import { PartyInput } from "./parties";

// «مطالبات دریافتی از مراکز» (2026-10): the insurer's side of a list a
// centre sends to an insurer that has its own panel on Noyan. Modelled on
// how the Salamat and Tamin portals return a list (رسیدگی اسناد): every line
// is accepted, deducted with a reason (کسورات) or rejected; the result is
// registered once with its date; then the accepted amount is paid, often
// in several payments (علی‌الحساب, then the rest). Every step posts on both
// books, so neither side types the other's figures:
//
//   result      insurer  Dr 7227 claims expense (claimed)
//                        Cr 3308 claims payable (accepted, the centre)
//                        Cr 7229 deductions (deducted and rejected)
//               centre   Dr 7211 insurance deductions / Cr 1412 insurers
//                        (the existing deduction of Lib/business/claims.ts)
//                        and, for a visit split with its doctor, the
//                        doctor's percentage of the line's deduction:
//                        Dr 3305 / Cr 7105 at the centre, Dr visit income /
//                        Cr 1411 at the doctor (doctorShareDeductions.ts)
//   payment     insurer  Dr 3308 claims payable (the centre) / Cr bank
//               centre   Dr bank / Cr 1412 insurers (the existing receipt
//                        against the claim, Lib/business/payments.ts)
//
// One-way: a registered result is not changed and a payment is not undone
// here. Idempotent: the result is claimed atomically (pending → decided),
// a payment by its client key and the amount already paid.

const insurerOwner = (c: Pick<IBizClaim, "insurerProfile">): BizOwner => ({ kind: "insurance", id: String(c.insurerProfile) });
const centreOwner = (c: Pick<IBizClaim, "ownerKind" | "ownerId">): BizOwner => ({ kind: c.ownerKind, id: String(c.ownerId) });

// the centre as a تفصیلی of the insurer: one per centre, whatever its name
const centreParty = (c: Pick<IBizClaim, "ownerKind" | "ownerId" | "centreName">): PartyInput => ({
  kind: "custom",
  name: c.centreName || "—",
  ref: { type: c.ownerKind, id: c.ownerId },
});

// the panel path of a centre's claims page, for its notification
const PANEL: Record<string, string> = {
  doctor: "/doctorpanel",
  clinic: "/clinicpanel",
  hospital: "/hospitalpanel",
  pharmacy: "/pharmacypanel",
  paraClinic: "/paraClinicPanel",
};

const notifyCentre = async (c: IBizClaim, title: string, message: string) => {
  const org = await orgInfo(centreOwner(c)).catch(() => null);
  if (!org?.user) return;
  await Notification.create({
    user: org.user,
    source: "System",
    title,
    message,
    link: `${PANEL[c.ownerKind] || ""}/finance/insurance?claim=${c._id}`,
  }).catch(() => undefined);
};

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

// --------------------------------------------------------- the centre

// the insurers a centre can send its lists to on Noyan: active, with a panel
export const noyanInsurers = async () =>
  Insurance.find({ active: true, user: { $exists: true, $ne: null } })
    .select("name isBasic")
    .sort({ isBasic: -1, order: 1, name: 1 })
    .limit(200)
    .lean<{ _id: mongoose.Types.ObjectId; name?: string; isBasic?: boolean }[]>();

// --------------------------------------------------------- the insurer

const mine = (owner: BizOwner) => {
  if (owner.kind !== "insurance" || !owner.id) throw new AppError("این بخش برای این حساب نیست", 400);
  return { insurerProfile: oid(owner.id), review: { $exists: true } };
};

const openOf = (c: Pick<IBizClaim, "review">) => Math.max(0, (c.review?.approved || 0) - (c.review?.paid || 0));

// the lists received, newest first, with the totals of the queue
export const listReceived = async (owner: BizOwner, q: { status?: string; q?: string }) => {
  const base = mine(owner);
  const filter: Record<string, unknown> = { ...base };
  if (q.status === "pending" || q.status === "decided" || q.status === "paid") filter["review.status"] = q.status;
  if (q.q) {
    const rx = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ centreName: rx }, { trackingCode: rx }];
  }
  const items = await BizClaim.find(filter)
    .sort({ submittedAt: -1 })
    .limit(300)
    .select("number ownerKind centreName insurer from to claimed submittedAt trackingCode review.status review.receivedAt review.decidedAt review.approved review.deducted review.paid items.share")
    .lean<IBizClaim[]>();
  const all = await BizClaim.find(base).select("claimed review.status review.approved review.paid").lean<IBizClaim[]>();
  const sum = (rows: IBizClaim[], f: (c: IBizClaim) => number) => rows.reduce((s, c) => s + f(c), 0);
  const pending = all.filter((c) => c.review?.status === "pending");
  // waiting for payment: decided with something accepted still unpaid (a
  // list rejected in full is decided with nothing to pay and is not owed)
  const decided = all.filter((c) => c.review?.status === "decided" && openOf(c) > 0);
  return {
    items: items.map((c) => ({ ...c, lines: c.items?.length || 0, items: undefined, open: openOf(c) })),
    totals: {
      pending: { count: pending.length, amount: sum(pending, (c) => c.claimed) },
      payable: { count: decided.length, amount: sum(decided, openOf) },
      paid: sum(all, (c) => c.review?.paid || 0),
    },
  };
};

export const getReceived = async (owner: BizOwner, id: string) => {
  const c = await BizClaim.findOne({ ...mine(owner), _id: id }).lean<IBizClaim>();
  if (!c) throw new AppError("لیست بیمه پیدا نشد", 404);
  const money = await BizMoneyAccount.find({ _id: { $in: (c.review?.payments || []).map((p) => p.money) } })
    .select("name kind")
    .lean<IBizMoneyAccount[]>();
  const names = new Map(money.map((m) => [String(m._id), m.name]));
  return {
    ...c,
    open: openOf(c),
    review: c.review ? { ...c.review, payments: c.review.payments.map((p) => ({ ...p, moneyName: names.get(String(p.money)) || "" })) } : undefined,
  };
};

export type LineDecisionInput = { index: number; status: BizClaimLineDecision; amount?: number; reason?: string };

// what one decision means in money: accepted = the whole share, deducted =
// the share less the deduction (a reason required), rejected = nothing
const decisionOf = (share: number, d: LineDecisionInput) => {
  const reason = (d.reason || "").trim().slice(0, 300);
  if (d.status === "accepted") return { status: d.status, approved: share, deducted: 0 };
  if (!reason) throw new AppError("دلیل کسر یا رد هر ردیف را بنویسید", 400);
  if (d.status === "rejected") return { status: d.status, approved: 0, deducted: share, reason };
  const cut = toman(d.amount);
  if (!(cut > 0) || cut >= share) throw new AppError("مبلغ کسر هر ردیف باید بیشتر از صفر و کمتر از سهم بیمه‌ی آن باشد؛ برای کسر همه، ردیف را رد کنید", 400);
  return { status: d.status, approved: share - cut, deducted: cut, reason };
};

// The insurer's line decisions, saved while the list is under review
// (nothing posts yet). A line left undecided is accepted when the result is
// registered.
export const saveDecisions = async (owner: BizOwner, id: string, decisions: LineDecisionInput[], note?: string) => {
  const c = await BizClaim.findOne({ ...mine(owner), _id: id });
  if (!c?.review) throw new AppError("لیست بیمه پیدا نشد", 404);
  if (c.review.status !== "pending") throw new AppError("نتیجه‌ی رسیدگی این لیست ثبت شده و تغییر نمی‌کند", 400);
  for (const d of decisions) {
    const item = c.items[d.index];
    if (!item) throw new AppError("ردیف لیست پیدا نشد", 400);
    item.decision = decisionOf(item.share, d);
  }
  if (note !== undefined) c.review.note = note.trim().slice(0, 1000) || undefined;
  c.markModified("items");
  await c.save();
  return getReceived(owner, id);
};

// Registers the result of the review (one-way, dated): the insurer's
// claims expense, payable and deductions, and the centre's deduction.
export const decideReceived = async (owner: BizOwner, id: string, d: { date?: Date }, by?: unknown) => {
  const c = await BizClaim.findOne({ ...mine(owner), _id: id }).lean<IBizClaim>();
  if (!c?.review) throw new AppError("لیست بیمه پیدا نشد", 404);
  if (c.review.status !== "pending") throw new AppError("نتیجه‌ی رسیدگی این لیست قبلاً ثبت شده است", 400);
  if (c.status === "draft") throw new AppError("لیست بیمه هنوز ارسال نشده است", 400);
  const date = d.date || new Date();
  if (c.submittedAt && date < startOfTehranDay(c.submittedAt))
    throw new AppError("تاریخ رسیدگی نمی‌تواند پیش از ارسال لیست باشد", 400);
  const centre = centreOwner(c);
  // both books must take the date before anything is claimed
  await assertOpen(owner, date);
  await assertOpen(centre, date);
  const decisions = c.items.map((i) => i.decision || { status: "accepted" as const, approved: i.share, deducted: 0 });
  const approved = decisions.reduce((s, x) => s + x.approved, 0);
  const deducted = decisions.reduce((s, x) => s + x.deducted, 0);
  const seq = (c.review.seq || 0) + 1;
  // claimed atomically: a second click finds it decided
  const claimed = await BizClaim.updateOne(
    { _id: c._id, "review.status": "pending", "review.seq": c.review.seq || 0 },
    {
      $set: {
        // a list rejected in full is decided with nothing left to pay
        "review.status": "decided",
        "review.decidedAt": date,
        "review.decidedBy": by,
        "review.seq": seq,
        "review.approved": approved,
        "review.deducted": deducted,
        items: c.items.map((i, n) => ({ ...i, decision: decisions[n] })),
      },
    },
  );
  if (!claimed.modifiedCount) throw new AppError("این لیست هم‌زمان تغییر کرد؛ دوباره تلاش کنید", 409);
  const ref = `iclaim:${c._id}:${c.round || 0}:${seq}`;
  const label = `${c.centreName || "—"} · #${c.number}`;
  try {
    await postVoucher(owner, {
      ref,
      date,
      description: "رسیدگی لیست مرکز درمانی",
      source: { type: "claimIn", id: c._id },
      lines: [
        { role: "claimsExpense", debit: c.claimed, label },
        { role: "claimsPayable", credit: approved, label, party: centreParty(c) },
        { role: "claimDeductions", credit: deducted, label },
      ],
      createdBy: by,
    });
    if (deducted > 0) {
      const reasons = [...new Set(decisions.map((x) => ("reason" in x ? x.reason : "") || "").filter(Boolean))].join("؛ ");
      // line by line: the doctor's part of each line's deduction comes off
      // their share (Lib/business/doctorShareDeductions.ts)
      await deductClaim(
        centre,
        String(c._id),
        {
          amount: deducted,
          all: approved <= 0,
          reason: (reasons || "کسورات بیمه").slice(0, 500),
          date,
          fromInsurer: true,
          perItem: decisions.map((x, index) => ({ index, deducted: x.deducted })),
        },
        by,
      );
    }
  } catch (err) {
    await reverseRef(owner, ref, "برگشت رسیدگی لیست مرکز درمانی").catch(() => undefined);
    await BizClaim.updateOne({ _id: c._id, "review.seq": seq }, { $set: { "review.status": "pending", "review.approved": 0, "review.deducted": 0 }, $unset: { "review.decidedAt": 1 } });
    throw err;
  }
  await notifyCentre(
    c,
    "نتیجه‌ی رسیدگی لیست بیمه",
    "${1} لیست شماره‌ی ${2} را رسیدگی کرد: پذیرفته ${3} تومان، کسورات و رد ${4} تومان."
      .replace("${1}", c.insurer?.name || "—")
      .replace("${2}", String(c.number))
      .replace("${3}", fmt(approved))
      .replace("${4}", fmt(deducted)),
  );
  return getReceived(owner, id);
};

// The centre's till the insurer's transfer lands in: its first active bank
// account, else its cash.
const centreBank = async (centre: BizOwner) => {
  await ensureMoneyAccounts(centre);
  const rows = await BizMoneyAccount.find({ ...ownerFilter(centre), isActive: { $ne: false } }).sort({ createdAt: 1 }).lean<IBizMoneyAccount[]>();
  const row = rows.find((r) => r.kind === "bank") || rows.find((r) => r.kind === "cash");
  if (!row) throw new AppError("صندوق یا حساب بانکی را انتخاب کنید", 400);
  return row;
};

// A payment of what was accepted (all of it or a part, علی‌الحساب): the
// insurer's payable is settled from its bank, and the centre receives it
// against the list. A key sent twice (a retry, a double click) pays once.
export const payReceived = async (
  owner: BizOwner,
  id: string,
  d: { amount: number; money: string; date?: Date; reference?: string; key?: string },
  by?: unknown,
) => {
  const c = await BizClaim.findOne({ ...mine(owner), _id: id }).lean<IBizClaim>();
  if (!c?.review) throw new AppError("لیست بیمه پیدا نشد", 404);
  const key = (d.key || "").slice(0, 80);
  if (key && c.review.payments.some((p) => p.key === key)) return getReceived(owner, id);
  if (c.review.status !== "decided") throw new AppError("پرداخت پس از ثبت نتیجه‌ی رسیدگی و تا وقتی مانده دارد ممکن است", 400);
  const open = openOf(c);
  const amount = toman(d.amount);
  if (!(amount > 0) || amount > open + 0.5) throw new AppError("مبلغ پرداخت بیشتر از مانده‌ی پذیرفته‌شده‌ی این لیست است", 400);
  const date = d.date || new Date();
  const centre = centreOwner(c);
  await assertOpen(owner, date);
  await assertOpen(centre, date);
  const label = `${c.centreName || "—"} · #${c.number}`;
  const { treasuryCredit } = await import("./treasury");
  const credit = await treasuryCredit(owner, d.money, amount, label);
  const bank = await centreBank(centre);
  const payId = new mongoose.Types.ObjectId();
  const paid = (c.review.paid || 0) + amount;
  const res = await BizClaim.updateOne(
    { _id: c._id, "review.status": "decided", "review.paid": c.review.paid || 0, ...(key ? { "review.payments.key": { $ne: key } } : {}) },
    {
      $set: { "review.paid": paid, ...(paid >= c.review.approved - 0.5 ? { "review.status": "paid" } : {}) },
      $push: { "review.payments": { _id: payId, key: key || undefined, amount, date, money: oid(d.money), reference: d.reference?.slice(0, 80) || undefined, by } },
    },
  );
  if (!res.modifiedCount) {
    if (key && (await BizClaim.exists({ _id: c._id, "review.payments.key": key }))) return getReceived(owner, id);
    throw new AppError("این لیست هم‌زمان تغییر کرد؛ دوباره تلاش کنید", 409);
  }
  const ref = `iclaim:${c._id}:pay:${payId}`;
  try {
    await postVoucher(owner, {
      ref,
      date,
      description: "پرداخت خسارت به مرکز درمانی",
      source: { type: "claimIn", id: c._id },
      lines: [
        { role: "claimsPayable", debit: amount, label, party: centreParty(c) },
        { ...credit, label },
      ],
      createdBy: by,
    });
    const receipt = await createPayment(
      centre,
      {
        direction: "in",
        date,
        amount,
        method: "transfer",
        money: String(bank._id),
        against: "claim",
        claim: String(c._id),
        reference: d.reference?.slice(0, 80) || undefined,
        fromInsurer: true,
      },
      by,
    );
    await BizClaim.updateOne({ _id: c._id, "review.payments._id": payId }, { $set: { "review.payments.$.centrePayment": receipt._id } });
  } catch (err) {
    await reverseRef(owner, ref, "برگشت پرداخت خسارت به مرکز درمانی").catch(() => undefined);
    await BizClaim.updateOne(
      { _id: c._id },
      { $inc: { "review.paid": -amount }, $set: { "review.status": "decided" }, $pull: { "review.payments": { _id: payId } } },
    );
    throw err;
  }
  await notifyCentre(
    c,
    "پرداخت بیمه",
    "${1} مبلغ ${2} تومان بابت لیست شماره‌ی ${3} پرداخت کرد."
      .replace("${1}", c.insurer?.name || "—")
      .replace("${2}", fmt(amount))
      .replace("${3}", String(c.number)),
  );
  return getReceived(owner, id);
};
