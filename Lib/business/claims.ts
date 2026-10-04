import mongoose from "mongoose";
import BizClaim, { IBizClaim, IBizClaimItem } from "../../Models/BizClaim";
import BizInvoice, { BizInsurerKind, IBizInvoice } from "../../Models/BizInvoice";
import BizPayment from "../../Models/BizPayment";
import AppError from "../AppError";
import { BizOwner } from "./coa";
import { nextDocNumber } from "./voucher";
import { assertOpen, defaultIncomeRole, docRefs, oid, ownerDoc, postDoc, reverseRef, toman } from "./finance";
import { claimStatus } from "./payments";

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
};

// invoices with an insurer share not yet on a claim
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
  return BizInvoice.find(filter).sort({ date: 1 }).limit(1000).select("number date party insurer total lines.title").lean();
};

const itemsOf = async (owner: BizOwner, input: ClaimInput, claimId?: unknown) => {
  const ids = (input.invoices || []).filter((i) => mongoose.isValidObjectId(i)).map((i) => oid(i));
  const invoices = ids.length
    ? await BizInvoice.find({
        ...ownerDoc(owner),
        _id: { $in: ids },
        "insurer.share": { $gt: 0 },
        status: { $nin: ["draft", "void"] },
        $or: [{ claim: { $exists: false } }, ...(claimId ? [{ claim: claimId }] : [])],
      }).lean<IBizInvoice[]>()
    : [];
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
  return { items: [...fromInvoices, ...typed], invoiceIds: invoices.map((i) => i._id) };
};

export const createClaim = async (owner: BizOwner, input: ClaimInput, by?: unknown) => {
  if (owner.kind === "insurance") throw new AppError("این بخش برای این حساب نیست", 400);
  if (!input.insurer?.name?.trim()) throw new AppError("نام بیمه را بنویسید", 400);
  const { items, invoiceIds } = await itemsOf(owner, input);
  if (!items.length) throw new AppError("دست‌کم یک ردیف به لیست بیمه اضافه کنید", 400);
  const claim = await BizClaim.create({
    ...ownerDoc(owner),
    number: await nextDocNumber("claim", owner),
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
  return claim.toObject();
};

export const updateClaim = async (owner: BizOwner, id: string, input: ClaimInput) => {
  const claim = await BizClaim.findOne({ ...ownerDoc(owner), _id: id });
  if (!claim) throw new AppError("لیست بیمه پیدا نشد", 404);
  if (claim.status !== "draft") throw new AppError("لیست ارسال‌شده تغییر نمی‌کند", 400);
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
  await claim.save();
  return claim.toObject();
};

export const deleteClaim = async (owner: BizOwner, id: string) => {
  const claim = await BizClaim.findOne({ ...ownerDoc(owner), _id: id });
  if (!claim) throw new AppError("لیست بیمه پیدا نشد", 404);
  if (claim.status !== "draft") throw new AppError("لیست ارسال‌شده حذف نمی‌شود", 400);
  await BizInvoice.updateMany({ claim: claim._id }, { $unset: { claim: 1 } });
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
  const typed = claim.items.filter((i) => !i.invoice).reduce((s, i) => s + i.share, 0);
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
  await claim.save();
  return claim.toObject();
};

// A deduction (کسورات) or, with all = true, the rejection of what is still
// open, with its reason.
export const deductClaim = async (owner: BizOwner, id: string, d: { amount?: number; reason: string; all?: boolean; date?: Date }, by?: unknown) => {
  const claim = await BizClaim.findOne({ ...ownerDoc(owner), _id: id });
  if (!claim) throw new AppError("لیست بیمه پیدا نشد", 404);
  if (claim.status === "draft") throw new AppError("لیست بیمه هنوز ارسال نشده است", 400);
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
  if (await BizPayment.exists({ ...ownerDoc(owner), claim: claim._id, isVoid: false }))
    throw new AppError("ابتدا دریافت‌های این لیست را باطل کنید", 400);
  await assertOpen(owner, new Date());
  for (const ref of await docRefs(owner, `claim:${claim._id}:${claim.round || 0}`)) await reverseRef(owner, ref, "بازگشایی لیست بیمه");
  claim.status = "draft";
  claim.deducted = 0;
  claim.deductions = [];
  claim.rejectReason = undefined;
  claim.submittedAt = undefined;
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
  return { items, aging: buckets, unclaimed: { amount: unclaimed[0]?.sum || 0, count: unclaimed[0]?.n || 0 } };
};

export const getClaim = async (owner: BizOwner, id: string) => {
  const claim = await BizClaim.findOne({ ...ownerDoc(owner), _id: id }).lean();
  if (!claim) throw new AppError("لیست بیمه پیدا نشد", 404);
  const payments = await BizPayment.find({ ...ownerDoc(owner), claim: claim._id }).sort({ date: 1 }).populate({ path: "money", select: "name kind" }).lean();
  return { ...claim, payments };
};
