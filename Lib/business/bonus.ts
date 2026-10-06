import { jalaliYearRange } from "../tehranTime";
import mongoose from "mongoose";
import moment from "moment-jalaali";
import BizEmployee, { IBizEmployee } from "../../Models/BizEmployee";
import BizPayrun, { IBizPayrun } from "../../Models/BizPayrun";
import BizBonusRun, { IBizBonusRun, IBizBonusSlip } from "../../Models/BizBonusRun";
import BizAccount from "../../Models/BizAccount";
import BizVoucher, { IBizVoucher } from "../../Models/BizVoucher";
import { IPayrollYear } from "../../Models/PayrollYear";
import AppError from "../AppError";
import { BizOwner, ownerFilter } from "./coa";
import { postVoucher, PostLine } from "./voucher";
import { perEmployee, salaryPayLines, yearRules } from "./payroll";

// عیدی و سنوات (2026-10, docs/business-suite.md phase 3 follow-up), the
// Labour Law way:
//   - Eid (article 1 of the 1370 Eid law): two months of the last daily
//     wage, at most three months of the minimum wage, for the share of the
//     year worked;
//   - severance (article 24): one month of the last wage for each year,
//     paid every Esfand with the Eid (the owner's choice), or at the
//     settlement of one who leaves;
//   - neither is insured; severance is tax-free (article 91) and Eid is
//     taxed above one twelfth of the annual exemption (the month's
//     exemption) at the first bracket's rate.
// Days worked come from the year's posted payslips, or the employment
// dates when the year has none. Amounts in toman.

const oid = (v: unknown) => new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));
const own = (o: BizOwner) => ({ ownerKind: o.kind, ownerId: oid(o.id) });
const round = (n: number) => Math.round(Number(n) || 0);
const MONTH = 30;

const yearBounds = (year: number) => {
  // 1 Farvardin to the end of Esfand at Tehran midnights (Lib/tehranTime.ts)
  const r = jalaliYearRange(year);
  const end = new Date(r.end.getTime() - 1);
  return { start: r.start, end, days: Math.round((r.end.getTime() - r.start.getTime()) / 864e5) };
};

const daysBetween = (a: Date, b: Date) => Math.max(0, Math.floor((b.getTime() - a.getTime()) / 864e5) + 1);

// how many days of `year` the employee worked
const workedDays = async (owner: BizOwner, emp: IBizEmployee, year: number, b: ReturnType<typeof yearBounds>) => {
  const runs = await BizPayrun.find({ ...own(owner), year, status: "posted", "slips.employee": emp._id })
    .select("slips.employee slips.workedDays")
    .lean<IBizPayrun[]>();
  if (runs.length)
    return Math.min(b.days, runs.reduce((s, r) => s + (r.slips.find((x) => String(x.employee) === String(emp._id))?.workedDays || 0), 0));
  const from = emp.hireDate && emp.hireDate > b.start ? emp.hireDate : b.start;
  const to = emp.endDate && emp.endDate < b.end ? emp.endDate : b.end > new Date() ? new Date() : b.end;
  return Math.min(b.days, daysBetween(from, to));
};

export const computeBonus = (
  emp: Pick<IBizEmployee, "_id" | "name" | "nationalId" | "baseSalary" | "taxable">,
  days: number,
  deductions: number,
  y: IPayrollYear,
  yearDays: number,
): IBizBonusSlip => {
  const share = Math.max(0, Math.min(1, days / yearDays));
  const daily = emp.baseSalary / MONTH;
  const eidFull = Math.min(60 * daily, 3 * y.minWage);
  const eid = round(eidFull * share);
  const severance = round(MONTH * daily * share);
  // the month's exemption; above it at the first bracket's rate
  const firstRate = [...(y.brackets || [])].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity))[0]?.rate || 0;
  const tax = emp.taxable ? round((Math.max(0, eid - (y.taxExemption || 0)) * firstRate) / 100) : 0;
  const ded = round(Math.max(0, deductions || 0));
  return {
    employee: oid(emp._id),
    name: emp.name,
    nationalId: emp.nationalId,
    days: Math.round(days),
    baseSalary: emp.baseSalary,
    eid,
    severance,
    tax,
    deductions: ded,
    net: eid + severance - tax - ded,
  };
};

const totalsOf = (slips: IBizBonusSlip[]) => ({
  eid: slips.reduce((s, x) => s + x.eid, 0),
  severance: slips.reduce((s, x) => s + x.severance, 0),
  tax: slips.reduce((s, x) => s + x.tax, 0),
  deductions: slips.reduce((s, x) => s + x.deductions, 0),
  net: slips.reduce((s, x) => s + x.net, 0),
});

// who is already in a run of this year
const takenIds = async (owner: BizOwner, year: number, except?: unknown) => {
  const runs = await BizBonusRun.find({ ...own(owner), year, ...(except ? { _id: { $ne: except } } : {}) })
    .select("slips.employee")
    .lean<IBizBonusRun[]>();
  return new Set(runs.flatMap((r) => r.slips.map((s) => String(s.employee))));
};

// A year's run: everyone who worked that year and is not in another run,
// or only the given employees (a settlement).
export const createBonusRun = async (owner: BizOwner, year: number, employeeIds: string[] | undefined, by?: unknown) => {
  const rules = await yearRules(year);
  const b = yearBounds(year);
  const taken = await takenIds(owner, year);
  const emps = await BizEmployee.find({
    ...own(owner),
    ...(employeeIds?.length ? { _id: { $in: employeeIds.map(oid) } } : { isActive: true }),
    $and: [
      { $or: [{ hireDate: { $exists: false } }, { hireDate: null }, { hireDate: { $lte: b.end } }] },
      { $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gte: b.start } }] },
    ],
  })
    .sort({ name: 1 })
    .lean<IBizEmployee[]>();
  const fresh = emps.filter((e) => !taken.has(String(e._id)));
  if (!fresh.length) throw new AppError("همه‌ی کارکنان این سال عیدی و سنوات گرفته‌اند", 400);
  const slips = [];
  for (const e of fresh) slips.push(computeBonus(e, await workedDays(owner, e, year, b), 0, rules, b.days));
  return BizBonusRun.create({ ...own(owner), year, yearDays: b.days, slips, totals: totalsOf(slips), createdBy: by });
};

export const updateBonusRun = async (owner: BizOwner, id: unknown, inputs: { employee: string; days: number; deductions: number }[]) => {
  const run = await BizBonusRun.findOne({ ...own(owner), _id: id }).lean<IBizBonusRun>();
  if (!run) throw new AppError("لیست عیدی و سنوات پیدا نشد", 404);
  if (run.status !== "draft") throw new AppError("فقط پیش‌نویس ویرایش می‌شود", 400);
  const rules = await yearRules(run.year);
  const ids = inputs.map((i) => i.employee);
  if (new Set(ids).size !== ids.length) throw new AppError("هر کارمند یک بار در لیست حقوق می‌آید", 400);
  const taken = await takenIds(owner, run.year, run._id);
  if (ids.some((i) => taken.has(String(i)))) throw new AppError("این کارمند در لیست دیگری از همین سال است", 400);
  const emps = await BizEmployee.find({ ...own(owner), _id: { $in: ids.map(oid) } }).lean<IBizEmployee[]>();
  const byId = new Map(emps.map((e) => [String(e._id), e]));
  const slips = inputs.map((i) => {
    const e = byId.get(String(i.employee));
    if (!e) throw new AppError("کارمند این ردیف پیدا نشد", 400);
    return computeBonus(e, Math.max(0, Math.min(run.yearDays, Number(i.days) || 0)), i.deductions, rules, run.yearDays);
  });
  if (!slips.length) throw new AppError("اول کارکنان را اضافه کنید", 400);
  await BizBonusRun.updateOne({ _id: run._id, status: "draft" }, { $set: { slips, totals: totalsOf(slips) } });
  return BizBonusRun.findById(run._id).lean();
};

const REF = (run: Pick<IBizBonusRun, "_id" | "postSeq">) => `bonus:${run._id}:${run.postSeq}`;

// Dr Eid + Dr severance / Cr net owed + tax owed + advances taken back.
// Dated on the last day of the year, or today for a settlement before it.
export const postBonusRun = async (owner: BizOwner, id: unknown) => {
  const run = await BizBonusRun.findOne({ ...own(owner), _id: id }).lean<IBizBonusRun>();
  if (!run) throw new AppError("لیست عیدی و سنوات پیدا نشد", 404);
  if (run.status !== "draft") throw new AppError("این لیست حقوق قبلاً ثبت شده است", 400);
  if (run.slips.some((s) => s.net < 0)) throw new AppError("خالص پرداختی یکی از کارکنان منفی شده است؛ کسورات را اصلاح کنید", 400);
  const b = yearBounds(run.year);
  const date = b.end < new Date() ? b.end : new Date();
  const seq = run.postSeq + 1;
  const claimed = await BizBonusRun.updateOne(
    { _id: run._id, status: "draft", postSeq: run.postSeq },
    { $set: { status: "posted", postSeq: seq, postedAt: new Date(), date } },
  );
  if (!claimed.modifiedCount) throw new AppError("این لیست حقوق هم‌زمان تغییر کرد؛ دوباره تلاش کنید", 409);
  const t = run.totals;
  const lines: PostLine[] = [
    { role: "eidExpense", debit: t.eid },
    { role: "severanceExpense", debit: t.severance },
    ...perEmployee(run.slips).net,
    { role: "payrollTaxPayable", credit: t.tax },
    ...perEmployee(run.slips).advances,
  ];
  try {
    await postVoucher(owner, {
      ref: REF({ _id: run._id, postSeq: seq }),
      date,
      description: "عیدی و سنوات کارکنان",
      source: { type: "bonusrun", id: run._id },
      lines,
    });
  } catch (err) {
    await BizBonusRun.updateOne({ _id: run._id }, { $set: { status: "draft", postSeq: run.postSeq }, $unset: { postedAt: 1, date: 1 } });
    throw err;
  }
  return BizBonusRun.findById(run._id).lean();
};

export const payBonusRun = async (owner: BizOwner, id: unknown, what: "salaries" | "liabilities", via: string, date?: Date) => {
  const run = await BizBonusRun.findOne({ ...own(owner), _id: id }).lean<IBizBonusRun>();
  if (!run) throw new AppError("لیست عیدی و سنوات پیدا نشد", 404);
  if (run.status !== "posted") throw new AppError("پرداخت فقط برای لیست حقوق ثبت‌شده ممکن است", 400);
  const field = what === "salaries" ? "salariesPaidAt" : "liabilitiesPaidAt";
  if (run[field]) throw new AppError("این پرداخت قبلاً ثبت شده است", 400);
  const acc = await BizAccount.findOne({ ...ownerFilter(owner), _id: via }).lean();
  if (!acc || acc.type !== "asset" || acc.level !== "detail")
    throw new AppError("پرداخت یا دریافت فقط از صندوق، بانک یا کیف پول ممکن است", 400);
  const amount = what === "salaries" ? run.totals.net : run.totals.tax;
  const claimed = await BizBonusRun.updateOne(
    { _id: run._id, status: "posted", [field]: { $exists: false } },
    { $set: { [field]: date || new Date() } },
  );
  if (!claimed.modifiedCount) throw new AppError("این پرداخت قبلاً ثبت شده است", 400);
  if (amount > 0)
    await postVoucher(owner, {
      ref: `${REF(run)}:${what}`,
      date: date || new Date(),
      description: what === "salaries" ? "پرداخت عیدی و سنوات" : "پرداخت مالیات عیدی",
      source: { type: "bonusrun", id: run._id },
      lines: [
        ...(what === "salaries" ? await salaryPayLines(owner, REF(run), amount) : [{ role: "payrollTaxPayable", debit: amount }]),
        { accountId: acc._id, credit: amount },
      ],
    });
  return BizBonusRun.findById(run._id).lean();
};

// a draft is deleted; a posted run with nothing paid goes back to draft
export const reopenBonusRun = async (owner: BizOwner, id: unknown) => {
  const run = await BizBonusRun.findOne({ ...own(owner), _id: id }).lean<IBizBonusRun>();
  if (!run) throw new AppError("لیست عیدی و سنوات پیدا نشد", 404);
  if (run.status === "draft") {
    await BizBonusRun.deleteOne({ _id: run._id, status: "draft" });
    return null;
  }
  if (run.salariesPaidAt || run.liabilitiesPaidAt) throw new AppError("برای این لیست حقوق پرداخت ثبت شده و برنمی‌گردد", 400);
  const claimed = await BizBonusRun.updateOne(
    { _id: run._id, status: "posted", postSeq: run.postSeq, salariesPaidAt: { $exists: false }, liabilitiesPaidAt: { $exists: false } },
    { $set: { status: "draft" }, $unset: { postedAt: 1 } },
  );
  if (!claimed.modifiedCount) throw new AppError("این لیست حقوق هم‌زمان تغییر کرد؛ دوباره تلاش کنید", 409);
  const original = await BizVoucher.findOne({ ...ownerFilter(owner), ref: REF(run) }).lean<IBizVoucher>();
  if (original?.lines?.length)
    await postVoucher(owner, {
      ref: `${REF(run)}:rev`,
      date: new Date(),
      description: "برگشت سند عیدی و سنوات",
      source: { type: "bonusrun", id: run._id },
      lines: original.lines.map((l) => ({ accountId: String(l.account), party: l.party, label: l.label, debit: l.credit, credit: l.debit })),
    });
  return BizBonusRun.findById(run._id).lean();
};
