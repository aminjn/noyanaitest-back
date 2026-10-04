import BizReturn, { IBizReturn } from "../../../Models/BizReturn";
import BizInvoice, { IBizInvoice } from "../../../Models/BizInvoice";
import BizContact from "../../../Models/BizContact";
import BizItem, { IBizItem } from "../../../Models/BizItem";
import BizStockMove, { IBizStockMove } from "../../../Models/BizStockMove";
import AppError from "../../AppError";
import { BizOwner } from "../coa";
import { nextDocNumber, PostLine } from "../voucher";
import { assertOpen, postDoc, reverseRef } from "../finance";
import { consume, postMoveVoucher, receive } from "../inventory";
import { cancelChainTasks, createLevelTask } from "./approvalChain";
import { oid, own, team } from "./common";
import { fireFlows } from "./flow";

// Returns and refunds (2026-10), nexxacrm's crm/service-returns and
// crm/after-sales-returns with lib/return-post.ts and lib/after-sales.ts:
// a request goes through its approvers (the inbox); "process" books it -
//   refund (cash back)   Dr 6201 income returns   / Cr 1101 till | 1102 bank
//   credit note           Dr 6201 income returns   / Cr 1411 receivable
//   repair                Dr 7207 maintenance      / Cr 1101 till | 1102 bank
//   replace               one unit out of stock (consume) + Dr 7301 COGS / Cr stock
// and "void" books the reverse (stock comes back). A visit or an order paid
// with the Noyan wallet is refunded through Noyan's dispute flow instead.

export const STOCK_KINDS = ["pharmacy", "paraClinic", "clinic", "hospital"];
const ACTIONS: Record<string, string[]> = { service: ["refund", "credit"], goods: ["refund", "repair", "replace"] };

export type ReturnInput = {
  kind: "service" | "goods";
  action: "refund" | "credit" | "repair" | "replace";
  contact?: string | null;
  invoice?: string | null;
  item?: string | null;
  amount?: number;
  payFrom?: "cash" | "bank";
  reason?: string;
  approvers?: string[];
};

export const createReturn = async (owner: BizOwner, input: ReturnInput, by: unknown) => {
  if (!ACTIONS[input.kind]?.includes(input.action)) throw new AppError("نوع مرجوعی معتبر نیست", 400);
  if (input.kind === "goods" && !STOCK_KINDS.includes(owner.kind)) throw new AppError("مرجوعی کالا برای مرکزی است که کالا می‌فروشد", 400);
  const amount = Math.max(0, Math.round(Number(input.amount) || 0));
  if (input.action !== "replace" && amount <= 0) throw new AppError("مبلغ را بنویسید", 400);
  if (!input.contact && !input.invoice) throw new AppError("بیمار یا صورتحساب را انتخاب کنید", 400);
  let contact = input.contact || null;
  if (input.invoice) {
    const inv = await BizInvoice.findOne({ ...own(owner), _id: oid(input.invoice) }).lean<IBizInvoice>();
    if (!inv) throw new AppError("صورتحساب پیدا نشد", 404);
    if (inv.origin === "platform")
      throw new AppError("نوبت یا سفارشی که با کیف پول نویان پرداخت شده، از راه اعتراض در نویان برگشت می‌خورد", 400);
    if (inv.status === "void" || inv.status === "draft") throw new AppError("این صورتحساب صادر نشده است", 400);
    if (amount > inv.total) throw new AppError("مبلغ مرجوعی از مبلغ صورتحساب بیشتر است", 400);
    if (!contact && inv.party?.phone) {
      const c = await BizContact.findOne({ ...own(owner), phone: inv.party.phone.replace(/\D/g, "").replace(/^98/, "0") }).select("_id").lean();
      contact = c ? String(c._id) : null;
    }
  }
  if (contact && !(await BizContact.exists({ ...own(owner), _id: oid(contact) }))) throw new AppError("این بیمار پیدا نشد", 404);
  if (input.action === "replace") {
    if (!input.item) throw new AppError("کالای جایگزین را انتخاب کنید", 400);
    if (!(await BizItem.exists({ ...own(owner), _id: oid(input.item) }))) throw new AppError("کالا پیدا نشد", 404);
  }
  const members = new Set((await team(owner)).map((m) => m._id));
  const approvers = Array.from(new Set((input.approvers || []).map(String))).slice(0, 5);
  if (approvers.some((a) => !members.has(a))) throw new AppError("این شخص عضو تیم این بخش نیست", 400);
  const number = await nextDocNumber("bizReturn", owner);
  const row = await BizReturn.create({
    ...own(owner),
    number,
    kind: input.kind,
    action: input.action,
    ...(contact ? { contact: oid(contact) } : {}),
    ...(input.invoice ? { invoice: oid(input.invoice) } : {}),
    ...(input.item ? { item: oid(input.item) } : {}),
    amount,
    payFrom: input.payFrom === "bank" ? "bank" : "cash",
    reason: input.reason?.trim().slice(0, 1000) || undefined,
    approverChain: approvers.map(oid),
    currentLevel: 0,
    status: approvers.length ? "pending" : "approved",
    requester: by,
  });
  if (approvers.length) await createLevelTask("return", row.toObject() as never);
  if (contact) await fireFlows(owner, "return.created", { type: "return", id: String(row._id), contact });
  return row.toObject() as IBizReturn;
};

const labelOf = (r: IBizReturn) => `مرجوعی شماره‌ی ${r.number}${r.reason ? ` · ${r.reason.slice(0, 80)}` : ""}`;

// approved -> processed: the booking (and the stock) of its action
export const processReturn = async (owner: BizOwner, id: unknown, by: unknown) => {
  const r = await BizReturn.findOne({ ...own(owner), _id: oid(id) }).lean<IBizReturn>();
  if (!r) throw new AppError("این درخواست پیدا نشد", 404);
  if (r.status !== "approved") throw new AppError("فقط درخواست تأییدشده انجام می‌شود", 400);
  const date = new Date();
  await assertOpen(owner, date);
  const ref = `return:${r._id}`;
  const label = labelOf(r);
  const money = r.payFrom === "bank" ? "bank" : "cash";
  let stockRef: string | undefined;
  let lines: PostLine[] = [];
  if (r.action === "refund") lines = [{ role: "incomeReturns", debit: r.amount, label }, { role: money, credit: r.amount, label }];
  else if (r.action === "credit") lines = [{ role: "incomeReturns", debit: r.amount, label }, { role: "receivable", credit: r.amount, label }];
  else if (r.action === "repair") lines = [{ role: "maintenance", debit: r.amount, label }, { role: money, credit: r.amount, label }];
  else if (r.action === "replace") {
    const item = await BizItem.findOne({ ...own(owner), _id: r.item }).lean<IBizItem>();
    if (!item) throw new AppError("کالا پیدا نشد", 404);
    const move = await consume({ owner, item, qty: 1, kind: "use", ref, note: label, createdBy: by });
    await postMoveVoucher(owner, item, move, "cogs", label);
    stockRef = ref;
  }
  if (lines.length) await postDoc(owner, { ref, date, description: label, lines, source: { type: "return", id: r._id }, createdBy: by });
  const done = await BizReturn.findOneAndUpdate(
    { _id: r._id, status: "approved" },
    { $set: { status: "processed", processedAt: date, ...(lines.length ? { voucherRef: ref } : {}), ...(stockRef ? { stockRef } : {}) } },
    { new: true },
  ).lean<IBizReturn>();
  return done;
};

// processed -> voided: the reverse voucher, and the replaced unit back in stock
export const voidReturn = async (owner: BizOwner, id: unknown, by: unknown) => {
  const r = await BizReturn.findOne({ ...own(owner), _id: oid(id) }).lean<IBizReturn>();
  if (!r) throw new AppError("این درخواست پیدا نشد", 404);
  if (r.status !== "processed") throw new AppError("فقط درخواست انجام‌شده باطل می‌شود", 400);
  await assertOpen(owner, new Date());
  const label = `ابطال ${labelOf(r)}`;
  if (r.voucherRef) await reverseRef(owner, r.voucherRef, label);
  if (r.stockRef) {
    const out = await BizStockMove.findOne({ ...own(owner), ref: r.stockRef }).lean<IBizStockMove>();
    const item = r.item ? await BizItem.findOne({ ...own(owner), _id: r.item }).lean<IBizItem>() : null;
    if (out && item) {
      const back = await receive({ owner, item, qty: Math.abs(out.qty), unitCost: Math.abs(out.unitCost || 0), kind: "adjustIn", ref: `${r.stockRef}:void`, note: label, createdBy: by });
      await postMoveVoucher(owner, item, back, "cogs", label);
    }
  }
  return BizReturn.findOneAndUpdate({ _id: r._id, status: "processed" }, { $set: { status: "voided", voidedAt: new Date() } }, { new: true }).lean<IBizReturn>();
};

// pending | approved -> cancelled (its open approvals close)
export const cancelReturn = async (owner: BizOwner, id: unknown) => {
  const r = await BizReturn.findOneAndUpdate({ ...own(owner), _id: oid(id), status: { $in: ["pending", "approved"] } }, { $set: { status: "cancelled" } }, { new: true }).lean<IBizReturn>();
  if (!r) throw new AppError("این درخواست را دیگر نمی‌توان لغو کرد", 400);
  await cancelChainTasks("return", r._id);
  return r;
};
