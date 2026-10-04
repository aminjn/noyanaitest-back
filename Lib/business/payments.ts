import mongoose from "mongoose";
import moment from "moment-jalaali";
import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import BizPayment, { BizChequeStatus, BizPayMethod, IBizPayment } from "../../Models/BizPayment";
import BizInvoice, { IBizInvoice } from "../../Models/BizInvoice";
import BizExpense, { IBizExpense } from "../../Models/BizExpense";
import BizClaim, { IBizClaim } from "../../Models/BizClaim";
import Notification from "../../Models/Notification";
import AppError from "../AppError";
import { BizOwner, ownerFilter } from "./coa";
import { PostLine, nextDocNumber } from "./voucher";
import { assertOpen, docRefs, moneyAccountOf, oid, ownerDoc, postDoc, reverseRef, toman } from "./finance";
import { orgInfo } from "./campaign";
import { PartyInput } from "./parties";

// the تفصیلی of a payment's receivable / payable side (2026-10): the
// patient of an invoice, the insurer of a claim, the vendor of an expense
const partyOf = (p: Pick<IBizPayment, "against" | "party" | "direction">): PartyInput | undefined => {
  const name = (p.party || "").trim();
  if (!name) return undefined;
  if (p.against === "claim") return { kind: "insurer", name };
  if (p.against === "expense") return { kind: "supplier", name };
  if (p.against === "invoice") return { kind: "patient", name };
  return { kind: p.direction === "in" ? "patient" : "supplier", name };
};

// Receipts and payments (2026-10, «دریافت و پرداخت»): a patient paying an
// invoice, an insurer paying a claim, a vendor paid for an expense, or any
// other money in or out. Each posts one voucher; a cheque (چک) - still the
// way much of Iran pays rent, distributors and settles with insurers - goes
// through «اسناد دریافتنی / پرداختنی» until it clears, and back to the party
// when it bounces:
//
//   received, pending   Dr 1415 cheques receivable   Cr the party
//   received, cleared   Dr the bank                  Cr 1415
//   received, bounced   Dr the party                 Cr 1415
//   issued, pending     Dr the party                 Cr 3202 cheques payable
//   issued, cleared     Dr 3202                      Cr the bank
//   issued, bounced     Dr 3202                      Cr the party
//
// "The party" is the patient's receivable for an invoice, the insurer's for
// a claim, the vendor's payable for an expense, or the account picked for a
// free receipt or payment.

export type PaymentInput = {
  direction: "in" | "out";
  date: Date;
  amount: number;
  method: BizPayMethod;
  money?: string;
  against: IBizPayment["against"];
  invoice?: string;
  claim?: string;
  expense?: string;
  account?: string;
  party?: string;
  description?: string;
  reference?: string;
  center?: string;
  cheque?: { number: string; bank: string; branch?: string; sayad?: string; dueDate: Date; checkbook?: string };
  // the تفصیلی to book the party side on, when the caller knows it
  partyRef?: string | PartyInput;
};

const DESCRIPTION = {
  invoice: "دریافت از بیمار",
  claim: "دریافت از بیمه",
  expense: "پرداخت هزینه",
  in: "دریافت وجه",
  out: "پرداخت وجه",
};

// what a payment counts for on its document: a cheque that bounced or was
// given back counts for nothing
export const effective = (p: Pick<IBizPayment, "amount" | "isVoid" | "cheque">) =>
  p.isVoid || (p.cheque && (p.cheque.status === "bounced" || p.cheque.status === "returned")) ? 0 : p.amount;

const partyLine = (p: Pick<IBizPayment, "against" | "account">, debit: number, credit: number, label?: string): PostLine => {
  if (p.against === "invoice") return { role: "receivable", debit, credit, label };
  if (p.against === "claim") return { role: "insuranceReceivable", debit, credit, label };
  if (p.against === "expense") return { role: "payable", debit, credit, label };
  return { accountId: p.account, debit, credit, label };
};

const moneyLine = async (owner: BizOwner, money: unknown, debit: number, credit: number, label?: string): Promise<PostLine> => {
  const row = await moneyAccountOf(owner, money);
  return { accountId: row.account, debit, credit, label };
};

// the open amount of the document a payment settles
const openOf = async (owner: BizOwner, input: PaymentInput) => {
  const own = ownerDoc(owner);
  if (input.against === "invoice") {
    const inv = await BizInvoice.findOne({ ...own, _id: input.invoice }).lean<IBizInvoice>();
    if (!inv) throw new AppError("صورتحساب پیدا نشد", 404);
    if (inv.origin !== "manual" || !["issued", "partial"].includes(inv.status))
      throw new AppError("این صورتحساب دریافت تازه نمی‌گیرد", 400);
    return { open: inv.patientShare - inv.paid, party: inv.party?.name, label: `#${inv.number}` };
  }
  if (input.against === "claim") {
    const c = await BizClaim.findOne({ ...own, _id: input.claim }).lean<IBizClaim>();
    if (!c) throw new AppError("لیست بیمه پیدا نشد", 404);
    if (c.status === "draft") throw new AppError("لیست بیمه هنوز ارسال نشده است", 400);
    return { open: c.claimed - c.paid - c.deducted, party: c.insurer?.name, label: `#${c.number}` };
  }
  if (input.against === "expense") {
    const e = await BizExpense.findOne({ ...own, _id: input.expense, recurring: { $exists: false } }).lean<IBizExpense>();
    if (!e || e.isVoid) throw new AppError("هزینه پیدا نشد", 404);
    return { open: e.total - e.paid, party: e.vendor, label: `#${e.number}` };
  }
  return null;
};

// keeps the paid amount and status of the document a payment settles
export const syncDoc = async (owner: BizOwner, p: Pick<IBizPayment, "against" | "invoice" | "claim" | "expense">) => {
  const own = ownerDoc(owner);
  const sum = async (field: "invoice" | "claim" | "expense", id: unknown) => {
    const rows = await BizPayment.find({ ...own, [field]: id, isVoid: false }).select("amount isVoid cheque").lean<IBizPayment[]>();
    return rows.reduce((s, r) => s + effective(r), 0);
  };
  if (p.against === "invoice" && p.invoice) {
    const inv = await BizInvoice.findOne({ ...own, _id: p.invoice });
    if (!inv || inv.origin !== "manual" || inv.status === "void" || inv.status === "draft") return;
    inv.paid = await sum("invoice", inv._id);
    inv.status = inv.paid <= 0 ? "issued" : inv.paid >= inv.patientShare ? "paid" : "partial";
    await inv.save();
  }
  if (p.against === "claim" && p.claim) {
    const c = await BizClaim.findOne({ ...own, _id: p.claim });
    if (!c) return;
    c.paid = await sum("claim", c._id);
    c.status = claimStatus(c);
    await c.save();
  }
  if (p.against === "expense" && p.expense) {
    const e = await BizExpense.findOne({ ...own, _id: p.expense });
    if (!e) return;
    e.paid = await sum("expense", e._id);
    await e.save();
  }
};

export const claimStatus = (c: Pick<IBizClaim, "status" | "claimed" | "paid" | "deducted">): IBizClaim["status"] => {
  if (c.status === "draft") return "draft";
  const open = c.claimed - c.paid - c.deducted;
  if (open > 0.5) return c.paid > 0 || c.deducted > 0 ? "partial" : "submitted";
  return c.paid > 0 ? "paid" : "rejected";
};

export const createPayment = async (owner: BizOwner, input: PaymentInput, by?: unknown) => {
  const own = ownerDoc(owner);
  const amount = toman(input.amount);
  if (!amount) throw new AppError("مبلغ را وارد کنید", 400);
  await assertOpen(owner, input.date);
  if ((input.against === "invoice" || input.against === "claim") && input.direction !== "in") throw new BadDirection();
  if (input.against === "expense" && input.direction !== "out") throw new BadDirection();
  const doc = await openOf(owner, input);
  if (doc && amount > doc.open + 0.5) throw new AppError("مبلغ بیشتر از مانده‌ی این سند است", 400);
  let counter: IBizAccount | null = null;
  if (input.against === "account") {
    if (!input.account || !mongoose.isValidObjectId(input.account)) throw new AppError("طرف حساب را انتخاب کنید", 400);
    counter = await BizAccount.findOne({ ...ownerFilter(owner), _id: input.account }).lean<IBizAccount>();
    if (!counter || counter.level !== "detail" || counter.parentCode === "11") throw new AppError("طرف حساب را انتخاب کنید", 400);
  }
  const isCheque = input.method === "cheque";
  if (isCheque && (!input.cheque?.number || !input.cheque?.bank || !input.cheque?.dueDate))
    throw new AppError("شماره، بانک و تاریخ سررسید چک را وارد کنید", 400);
  // a cheque needs no till yet (it clears into one later); the rest do
  const money = isCheque ? (input.money ? await moneyAccountOf(owner, input.money) : null) : await moneyAccountOf(owner, input.money);
  if (money && input.method === "wallet" && money.kind !== "wallet") throw new AppError("صندوق یا حساب بانکی را انتخاب کنید", 400);

  const number = await nextDocNumber("payment", owner);
  const p = await BizPayment.create({
    ...own,
    number,
    direction: input.direction,
    date: input.date,
    amount,
    method: input.method,
    money: money?._id,
    against: input.against,
    invoice: input.against === "invoice" ? oid(input.invoice) : undefined,
    claim: input.against === "claim" ? oid(input.claim) : undefined,
    expense: input.against === "expense" ? oid(input.expense) : undefined,
    account: counter?._id,
    party: (input.party || doc?.party || "").slice(0, 200) || undefined,
    description: input.description,
    reference: input.reference,
    center: input.center && mongoose.isValidObjectId(input.center) ? oid(input.center) : undefined,
    cheque: isCheque
      ? {
          ...input.cheque,
          checkbook: input.cheque?.checkbook && mongoose.isValidObjectId(input.cheque.checkbook) ? oid(input.cheque.checkbook) : undefined,
          status: "pending",
          statusAt: new Date(),
          history: [{ status: "pending", at: new Date() }],
        }
      : undefined,
    createdBy: by,
  });
  const label = [p.party, doc?.label, isCheque ? `چک ${input.cheque!.number}` : ""].filter(Boolean).join(" · ");
  const description = input.against === "account" ? DESCRIPTION[input.direction] : DESCRIPTION[input.against];
  try {
    const inLines = isCheque
      ? [{ role: "chequesReceivable", debit: amount, credit: 0, label }, partyLine(p, 0, amount, label)]
      : [await moneyLine(owner, money!._id, amount, 0, label), partyLine(p, 0, amount, label)];
    const outLines = isCheque
      ? [partyLine(p, amount, 0, label), { role: "chequesPayable", debit: 0, credit: amount, label }]
      : [partyLine(p, amount, 0, label), await moneyLine(owner, money!._id, 0, amount, label)];
    await postDoc(owner, {
      ref: `pay:${p._id}`,
      date: p.date,
      description,
      lines: p.direction === "in" ? inLines : outLines,
      source: { type: "payment", id: p._id },
      center: p.center,
      createdBy: by,
      party: input.partyRef ?? partyOf(p),
    });
  } catch (err) {
    await BizPayment.deleteOne({ _id: p._id });
    throw err;
  }
  await syncDoc(owner, p);
  return p.toObject();
};

class BadDirection extends AppError {
  constructor() {
    super("نوع دریافت یا پرداخت با سند آن جور نیست", 400);
  }
}

// ---------------------------------------------------------------- cheques

const CHEQUE_DESCRIPTION: Record<"in" | "out", Partial<Record<BizChequeStatus, string>>> = {
  in: { cleared: "وصول چک دریافتی", bounced: "برگشت چک دریافتی", returned: "عودت چک دریافتی" },
  out: { cleared: "پاس شدن چک پرداختی", bounced: "برگشت چک پرداختی", returned: "عودت چک پرداختی" },
};

// pending -> cleared | bounced | returned; bounced -> cleared (presented
// again and paid) | returned (given back to the drawer)
// (2026-10) deposited and endorsed come from Lib/business/treasury.ts: a
// deposited cheque moves on like a pending one, an endorsed one is gone
const MOVES: Record<BizChequeStatus, BizChequeStatus[]> = {
  pending: ["cleared", "bounced", "returned"],
  deposited: ["cleared", "bounced", "returned"],
  bounced: ["cleared", "returned"],
  cleared: [],
  returned: [],
  endorsed: [],
};

export const setChequeStatus = async (
  owner: BizOwner,
  id: string,
  d: { status: BizChequeStatus; money?: string; date?: Date; note?: string },
  by?: unknown,
) => {
  const p = await BizPayment.findOne({ ...ownerDoc(owner), _id: id, method: "cheque" });
  if (!p || !p.cheque || p.isVoid) throw new AppError("چک پیدا نشد", 404);
  const from = p.cheque.status;
  if (!MOVES[from].includes(d.status)) throw new AppError("این تغییر وضعیت برای این چک ممکن نیست", 400);
  const date = d.date || new Date();
  await assertOpen(owner, date);
  const amount = p.amount;
  const label = [p.party, `چک ${p.cheque.number}`].filter(Boolean).join(" · ");
  let lines: PostLine[] | null = null;
  let clearedTo: unknown;
  if (d.status === "cleared") {
    const money = await moneyAccountOf(owner, d.money || p.money);
    clearedTo = money._id;
    const bank = await moneyLine(owner, money._id, 0, 0);
    // from pending it leaves 1415 / 3202; a bounced one was already moved
    // back to the party, so it settles the party directly
    const via: PostLine =
      from === "pending" || from === "deposited"
        ? { role: p.direction === "in" ? "chequesReceivable" : "chequesPayable", debit: 0, credit: 0 }
        : partyLine(p, 0, 0);
    lines =
      p.direction === "in"
        ? [{ ...bank, debit: amount, label }, { ...via, credit: amount, label }]
        : [{ ...via, debit: amount, label }, { ...bank, credit: amount, label }];
  } else if (from === "pending" || from === "deposited") {
    // bounced or returned: the cheque is no longer a claim on the bank
    lines =
      p.direction === "in"
        ? [partyLine(p, amount, 0, label), { role: "chequesReceivable", debit: 0, credit: amount, label }]
        : [{ role: "chequesPayable", debit: amount, credit: 0, label }, partyLine(p, 0, amount, label)];
  }
  if (lines)
    await postDoc(owner, {
      ref: `pay:${p._id}:${p.cheque.history.length}`,
      date,
      description: CHEQUE_DESCRIPTION[p.direction][d.status] || DESCRIPTION[p.direction],
      lines,
      source: { type: "payment", id: p._id },
      center: p.center,
      createdBy: by,
      party: partyOf(p),
    });
  p.cheque.status = d.status;
  p.cheque.statusAt = date;
  if (clearedTo) p.cheque.clearedTo = oid(clearedTo);
  p.cheque.history.push({ status: d.status, at: date, note: d.note?.slice(0, 300) });
  p.markModified("cheque");
  await p.save();
  await syncDoc(owner, p);
  return p.toObject();
};

// Voids a receipt or payment: every voucher it wrote is reversed.
export const voidPayment = async (owner: BizOwner, id: string) => {
  const p = await BizPayment.findOne({ ...ownerDoc(owner), _id: id });
  if (!p || p.isVoid) throw new AppError("دریافت یا پرداخت پیدا نشد", 404);
  await assertOpen(owner, p.date);
  for (const ref of await docRefs(owner, `pay:${p._id}`)) await reverseRef(owner, ref, "ابطال دریافت یا پرداخت");
  p.isVoid = true;
  p.voidedAt = new Date();
  await p.save();
  await syncDoc(owner, p);
  return p.toObject();
};

export const listPayments = async (
  owner: BizOwner,
  q: { direction?: "in" | "out"; method?: string; from?: Date | null; to?: Date | null; search?: string; page: number; limit: number },
) => {
  const filter: Record<string, unknown> = { ...ownerDoc(owner) };
  if (q.direction) filter.direction = q.direction;
  if (q.method) filter.method = q.method;
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.search) {
    const rx = new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ party: rx }, { description: rx }, { reference: rx }, { "cheque.number": rx }];
  }
  const [items, total, sums] = await Promise.all([
    BizPayment.find(filter)
      .sort({ date: -1, number: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate({ path: "money", select: "name kind" })
      .populate({ path: "invoice", select: "number" })
      .populate({ path: "claim", select: "number insurer" })
      .populate({ path: "expense", select: "number" })
      .populate({ path: "account", select: "code name" })
      .lean(),
    BizPayment.countDocuments(filter),
    BizPayment.aggregate([
      { $match: { ...filter, isVoid: false } },
      { $group: { _id: "$direction", sum: { $sum: "$amount" } } },
    ]),
  ]);
  return {
    items,
    total,
    in: sums.find((s) => s._id === "in")?.sum || 0,
    out: sums.find((s) => s._id === "out")?.sum || 0,
  };
};

// the cheque register: received and issued cheques by status and due date
export const listCheques = async (owner: BizOwner, q: { direction?: "in" | "out"; status?: BizChequeStatus }) => {
  const filter: Record<string, unknown> = { ...ownerDoc(owner), method: "cheque", isVoid: false };
  if (q.direction) filter.direction = q.direction;
  if (q.status) filter["cheque.status"] = q.status;
  const items = await BizPayment.find(filter)
    .sort({ "cheque.dueDate": 1 })
    .limit(500)
    .populate({ path: "money", select: "name kind" })
    .lean<IBizPayment[]>();
  // the tiles count every cheque, whatever the list is filtered by
  const all = await BizPayment.find({ ...ownerDoc(owner), method: "cheque", isVoid: false, "cheque.status": { $in: ["pending", "deposited", "bounced"] } })
    .select("direction amount cheque.status cheque.dueDate")
    .lean<IBizPayment[]>();
  const now = Date.now();
  const sum = (dir: "in" | "out", pred: (p: IBizPayment) => boolean) =>
    all.filter((p) => p.direction === dir && pred(p)).reduce((s, p) => s + p.amount, 0);
  const pending = (p: IBizPayment) => p.cheque?.status === "pending" || p.cheque?.status === "deposited";
  return {
    items,
    pendingIn: sum("in", pending),
    pendingOut: sum("out", pending),
    overdueIn: sum("in", (p) => pending(p) && new Date(p.cheque!.dueDate).getTime() < now),
    bouncedIn: sum("in", (p) => p.cheque?.status === "bounced"),
  };
};

// Due-date reminders: a cheque received or issued that falls due within
// three days tells its owner once (in-app notification).
export const remindCheques = async () => {
  const soon = new Date(Date.now() + 3 * 864e5);
  const due = await BizPayment.find({
    method: "cheque",
    isVoid: false,
    "cheque.status": "pending",
    "cheque.dueDate": { $lte: soon },
    "cheque.remindedAt": { $exists: false },
  })
    .limit(500)
    .lean<IBizPayment[]>();
  for (const p of due) {
    const info = await orgInfo({ kind: p.ownerKind, id: String(p.ownerId) }).catch(() => null);
    if (info?.user) {
      await Notification.create({
        user: info.user,
        source: "System",
        title: p.direction === "in" ? "سررسید چک دریافتی" : "سررسید چک پرداختی",
        // the Jalali date as Tehran sees it; the text is translated with its
        // values kept (Lib/i18n/notificationMessages.ts)
        message: `چک ${p.cheque!.number} به مبلغ ${toman(p.amount).toLocaleString("en-US")} تومان (${p.party || "—"}) در ${moment(p.cheque!.dueDate).utcOffset(210).format("jYYYY/jMM/jDD")} سررسید می‌شود.`,
        link: `/${panelPath(p.ownerKind)}/finance/payments?tab=cheques`,
      }).catch(() => {});
    }
    await BizPayment.updateOne({ _id: p._id }, { $set: { "cheque.remindedAt": new Date() } });
  }
};

export const panelPath = (kind: string) =>
  ({
    doctor: "doctorpanel",
    clinic: "clinicpanel",
    hospital: "hospitalpanel",
    pharmacy: "pharmacypanel",
    paraClinic: "paraClinicPanel",
    insurance: "insurancepanel",
  })[kind] || "dashboard";
