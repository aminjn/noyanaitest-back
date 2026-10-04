import mongoose from "mongoose";
import moment from "moment-jalaali";
import BizExpense, { IBizExpense } from "../../Models/BizExpense";
import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import BizPayment from "../../Models/BizPayment";
import AppError from "../AppError";
import { BizOwner, ownerFilter } from "./coa";
import { nextDocNumber, PostLine } from "./voucher";
import { assertOpen, docRefs, moneyAccountOf, oid, ownerDoc, postDoc, reverseRef, toman } from "./finance";
import { createPayment } from "./payments";

// Expenses (2026-10, «هزینه‌ها»), the way QuickBooks or Xero take a bill and
// Sepidar a «سند هزینه»: an expense account, the vendor, the amount and its
// VAT, a cost centre and the receipt's photo. Booking it:
//
//   Dr the expense account + 1510 input VAT     Cr 3201 payable (the vendor)
//
// and paying it (now, or later from the list) clears the payable from the
// till or bank (Lib/business/payments.ts). Salaries are not typed here:
// payroll books them with insurance and tax. A recurring expense is a
// template that writes itself every month, quarter or year.

// accounts payroll books by itself - never picked for a typed expense
const PAYROLL_ROLES = new Set(["salaryExpense", "employerInsurance", "eidExpense", "severanceExpense", "cogs", "platformFee", "subscriptionExpense"]);

export type ExpenseInput = {
  date: Date;
  dueDate?: Date | null;
  account: string;
  vendor?: string;
  supplier?: string;
  description?: string;
  amount: number;
  tax?: number;
  center?: string;
  attachment?: string;
  // paid at once from this till / bank
  payFrom?: string;
  method?: "cash" | "card" | "transfer" | "wallet";
  recurring?: { interval: "monthly" | "quarterly" | "yearly"; until?: Date | null } | null;
};

export const expenseAccounts = async (owner: BizOwner) =>
  (await BizAccount.find({ ...ownerFilter(owner), type: "expense", level: "detail" }).sort({ code: 1 }).lean<IBizAccount[]>()).filter(
    (a) => !PAYROLL_ROLES.has(a.role || ""),
  );

const checkAccount = async (owner: BizOwner, id: string) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError("نوع هزینه را انتخاب کنید", 400);
  const acc = await BizAccount.findOne({ ...ownerFilter(owner), _id: id, type: "expense", level: "detail" }).lean<IBizAccount>();
  if (!acc) throw new AppError("نوع هزینه را انتخاب کنید", 400);
  if (PAYROLL_ROLES.has(acc.role || "")) throw new AppError("حقوق و دستمزد از بخش حقوق ثبت می‌شود", 400);
  return acc;
};

const book = async (owner: BizOwner, e: IBizExpense, by?: unknown) => {
  const label = [e.vendor, e.description, `#${e.number}`].filter(Boolean).join(" · ").slice(0, 300);
  const lines: PostLine[] = [
    { accountId: e.account, debit: e.amount, credit: 0, label },
    { role: "vatReceivable", debit: e.tax, credit: 0, label },
    { role: "payable", debit: 0, credit: e.total, label },
  ].filter((l) => l.debit || l.credit);
  await postDoc(owner, {
    ref: `exp:${e._id}`,
    date: e.date,
    description: "ثبت هزینه",
    lines,
    source: { type: "expense", id: e._id },
    center: e.center,
    createdBy: by,
    // the vendor's own ledger (تفصیلی)
    party: e.supplier
      ? { kind: "supplier", name: e.vendor || "—", ref: { type: "supplier", id: e.supplier } }
      : e.vendor
        ? { kind: "supplier", name: e.vendor }
        : undefined,
  });
};

const nextOf = (d: Date, interval: "monthly" | "quarterly" | "yearly") =>
  // the same Jalali day of the next month / quarter / year, Tehran time
  moment(d)
    .utcOffset(210)
    .add(interval === "monthly" ? 1 : interval === "quarterly" ? 3 : 0, "jMonth")
    .add(interval === "yearly" ? 1 : 0, "jYear")
    .toDate();

export const createExpense = async (owner: BizOwner, input: ExpenseInput, by?: unknown) => {
  const own = ownerDoc(owner);
  const acc = await checkAccount(owner, input.account);
  const amount = toman(input.amount);
  const tax = toman(input.tax);
  if (!amount) throw new AppError("مبلغ را وارد کنید", 400);
  const base = {
    ...own,
    dueDate: input.dueDate || undefined,
    account: acc._id,
    vendor: input.vendor?.trim().slice(0, 200) || undefined,
    supplier: input.supplier && mongoose.isValidObjectId(input.supplier) ? oid(input.supplier) : undefined,
    description: (input.description || "").trim().slice(0, 500),
    amount,
    tax,
    total: amount + tax,
    center: input.center && mongoose.isValidObjectId(input.center) ? oid(input.center) : undefined,
    attachment: input.attachment?.slice(0, 300) || undefined,
    createdBy: by,
  };
  if (input.payFrom) await moneyAccountOf(owner, input.payFrom);
  if (input.recurring) {
    // the template itself books nothing; its first expense is written now
    // when its date has come
    const tpl = await BizExpense.create({
      ...base,
      number: await nextDocNumber("expense", owner),
      date: input.date,
      recurring: { interval: input.recurring.interval, nextDate: input.date, until: input.recurring.until || undefined, isActive: true, payFrom: input.payFrom ? oid(input.payFrom) : undefined },
    });
    await runRecurring(owner, by);
    return tpl.toObject();
  }
  await assertOpen(owner, input.date);
  const e = await BizExpense.create({ ...base, number: await nextDocNumber("expense", owner), date: input.date });
  try {
    await book(owner, e.toObject() as IBizExpense, by);
  } catch (err) {
    await BizExpense.deleteOne({ _id: e._id });
    throw err;
  }
  if (input.payFrom)
    await createPayment(
      owner,
      { direction: "out", date: input.date, amount: e.total, method: input.method || "cash", money: input.payFrom, against: "expense", expense: String(e._id), party: e.vendor },
      by,
    );
  return (await BizExpense.findById(e._id).lean())!;
};

// Writes every due occurrence of the owner's recurring expenses (all owners
// when none is given - the daily job), up to today.
export const runRecurring = async (owner?: BizOwner, by?: unknown) => {
  const now = new Date();
  const filter: Record<string, unknown> = { "recurring.isActive": true, "recurring.nextDate": { $lte: now } };
  if (owner) Object.assign(filter, ownerDoc(owner));
  const templates = await BizExpense.find(filter).limit(500);
  for (const tpl of templates) {
    const o = { kind: tpl.ownerKind, id: String(tpl.ownerId) } as BizOwner;
    let guard = 0;
    while (tpl.recurring && tpl.recurring.nextDate <= now && guard++ < 24) {
      const date = tpl.recurring.nextDate;
      if (tpl.recurring.until && date > tpl.recurring.until) {
        tpl.recurring.isActive = false;
        break;
      }
      try {
        await createExpense(
          o,
          {
            date,
            account: String(tpl.account),
            vendor: tpl.vendor,
            supplier: tpl.supplier ? String(tpl.supplier) : undefined,
            description: tpl.description,
            amount: tpl.amount,
            tax: tpl.tax,
            center: tpl.center ? String(tpl.center) : undefined,
            payFrom: tpl.recurring.payFrom ? String(tpl.recurring.payFrom) : undefined,
          },
          by || tpl.createdBy,
        ).then((e) => BizExpense.updateOne({ _id: (e as { _id: unknown })._id }, { $set: { template: tpl._id } }));
      } catch (err) {
        // a closed year or a removed account: stop this template, keep going
        console.log(`[finance] recurring expense ${tpl._id} failed:`, (err as Error)?.message);
        tpl.recurring.isActive = false;
        break;
      }
      tpl.recurring.nextDate = nextOf(date, tpl.recurring.interval);
    }
    tpl.markModified("recurring");
    await tpl.save();
  }
};

export const setRecurringActive = async (owner: BizOwner, id: string, isActive: boolean) => {
  const tpl = await BizExpense.findOne({ ...ownerDoc(owner), _id: id, recurring: { $exists: true } });
  if (!tpl || !tpl.recurring) throw new AppError("هزینه‌ی تکرارشونده پیدا نشد", 404);
  tpl.recurring.isActive = isActive;
  if (isActive && tpl.recurring.nextDate < new Date()) tpl.recurring.nextDate = new Date();
  tpl.markModified("recurring");
  await tpl.save();
  if (isActive) await runRecurring(owner);
  return tpl.toObject();
};

export const voidExpense = async (owner: BizOwner, id: string) => {
  const e = await BizExpense.findOne({ ...ownerDoc(owner), _id: id });
  if (!e || e.isVoid) throw new AppError("هزینه پیدا نشد", 404);
  if (e.recurring) {
    await BizExpense.deleteOne({ _id: e._id });
    return null;
  }
  if (await BizPayment.exists({ ...ownerDoc(owner), expense: e._id, isVoid: false }))
    throw new AppError("ابتدا پرداخت‌های این هزینه را باطل کنید", 400);
  await assertOpen(owner, e.date);
  for (const ref of await docRefs(owner, `exp:${e._id}`)) await reverseRef(owner, ref, "ابطال هزینه");
  e.isVoid = true;
  await e.save();
  return e.toObject();
};

export const listExpenses = async (
  owner: BizOwner,
  q: { account?: string; status?: "unpaid" | "paid" | "recurring"; from?: Date | null; to?: Date | null; search?: string; page: number; limit: number },
) => {
  await runRecurring(owner).catch(() => undefined);
  const filter: Record<string, unknown> = { ...ownerDoc(owner) };
  if (q.status === "recurring") filter.recurring = { $exists: true };
  else {
    filter.recurring = { $exists: false };
    filter.isVoid = false;
    if (q.status === "unpaid") filter.$expr = { $lt: ["$paid", "$total"] };
    if (q.status === "paid") filter.$expr = { $gte: ["$paid", "$total"] };
  }
  if (q.account && mongoose.isValidObjectId(q.account)) filter.account = oid(q.account);
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.search) {
    const rx = new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ vendor: rx }, { description: rx }];
  }
  const [items, total, sums, byAccount] = await Promise.all([
    BizExpense.find(filter)
      .sort({ date: -1, number: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate({ path: "account", select: "code name role" })
      .populate({ path: "center", select: "name" })
      .lean(),
    BizExpense.countDocuments(filter),
    BizExpense.aggregate([{ $match: filter }, { $group: { _id: null, total: { $sum: "$total" }, paid: { $sum: "$paid" } } }]),
    q.status === "recurring"
      ? Promise.resolve([])
      : BizExpense.aggregate([{ $match: filter }, { $group: { _id: "$account", total: { $sum: "$total" } } }, { $sort: { total: -1 } }, { $limit: 8 }]),
  ]);
  const names = new Map(
    (await BizAccount.find({ _id: { $in: byAccount.map((b) => b._id) } }).select("name code role").lean<IBizAccount[]>()).map((a) => [String(a._id), a]),
  );
  return {
    items,
    total,
    sums: { total: sums[0]?.total || 0, paid: sums[0]?.paid || 0, due: (sums[0]?.total || 0) - (sums[0]?.paid || 0) },
    byAccount: byAccount.map((b) => {
      const a = names.get(String(b._id));
      return { account: b._id, name: a?.name || "", code: a?.code || "", role: a?.role, total: b.total };
    }),
  };
};
