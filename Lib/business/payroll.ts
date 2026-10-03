import mongoose from "mongoose";
import moment from "moment-jalaali";
import PayrollYear, { IPayrollYear, ITaxBracket } from "../../Models/PayrollYear";
import BizEmployee, { IBizEmployee } from "../../Models/BizEmployee";
import BizPayrun, { IBizPayrun, IBizPayslip } from "../../Models/BizPayrun";
import BizAccount from "../../Models/BizAccount";
import BizVoucher, { IBizVoucher } from "../../Models/BizVoucher";
import AppError from "../AppError";
import { BizOwner, ownerFilter } from "./coa";
import { postVoucher, PostLine } from "./voucher";

// Noyan Business payroll (2026-10, docs/business-suite.md phase 3), after
// nexxacrm's lib/payroll.ts: the Iranian payslip - base pay for the days
// worked, the legal housing, food and child allowances, overtime at 1.4x,
// social security (7% employee, 23% employer, between the minimum wage and
// its 7x ceiling), salary tax by the year's brackets after the employee's
// insurance (article 137) - and the books: one voucher per month, then the
// salaries paid and the insurance and tax paid. The year's figures are the
// super admin's (Models/PayrollYear.ts), the same for every provider.
// Amounts in toman.

const oid = (v: unknown) => new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));
const own = (o: BizOwner) => ({ ownerKind: o.kind, ownerId: oid(o.id) });
const round = (n: number) => Math.round(Number(n) || 0);
export const STANDARD_DAYS = 30;

// The 1405 figures (Supreme Labour Council and the 1405 budget law); the
// super admin adds the next year and corrects these in «تنظیمات مالی».
const DEFAULT_YEARS: Omit<IPayrollYear, "_id" | "createdAt" | "updatedAt">[] = [
  {
    year: 1405,
    minWage: 16_625_550,
    housing: 3_000_000,
    food: 2_200_000,
    childAllowance: 1_662_555,
    employeeInsuranceRate: 7,
    employerInsuranceRate: 23,
    insuranceCeilingMultiplier: 7,
    overtimeMultiplier: 1.4,
    monthHours: 220,
    taxExemption: 40_000_000,
    brackets: [
      { upTo: 80_000_000, rate: 10 },
      { upTo: 100_000_000, rate: 15 },
      { upTo: 120_000_000, rate: 20 },
      { upTo: 140_000_000, rate: 25 },
      { upTo: null, rate: 30 },
    ],
  },
];

// boot: the known years exist (never overwrites what the admin changed)
export const seedPayrollYears = async () => {
  for (const y of DEFAULT_YEARS)
    await PayrollYear.updateOne({ year: y.year }, { $setOnInsert: y }, { upsert: true });
};

// ---------------------------------------------------------------- calendar

export const jalaliToday = () => {
  const m = moment();
  return { year: m.jYear(), month: m.jMonth() + 1 };
};

export const jalaliPeriod = (year: number, month: number) => {
  const start = moment(`${year}/${month}/1`, "jYYYY/jM/jD").startOf("day");
  const end = start.clone().endOf("jMonth");
  return { start: start.toDate(), end: end.toDate(), days: moment.jDaysInMonth(year, month - 1) };
};

// ---------------------------------------------------------------- engine

// nexxacrm progressiveTax: each slice of the month's taxable pay at its own
// rate; the exemption is tax-free
export const progressiveTax = (taxable: number, exemption: number, brackets: ITaxBracket[]) => {
  if (taxable <= exemption) return 0;
  let tax = 0;
  let lower = exemption;
  for (const b of [...brackets].sort((a, c) => (a.upTo ?? Infinity) - (c.upTo ?? Infinity))) {
    const upper = b.upTo ?? Infinity;
    if (upper <= lower) continue;
    const slice = Math.min(taxable, upper) - lower;
    if (slice > 0) tax += (slice * b.rate) / 100;
    lower = upper;
    if (taxable <= upper) break;
  }
  return round(tax);
};

export type SlipInput = Pick<IBizPayslip, "workedDays" | "overtimeHours" | "otherEarnings" | "deductions">;

export const computeSlip = (
  emp: Pick<IBizEmployee, "_id" | "name" | "nationalId" | "insuranceNo" | "position" | "baseSalary" | "housing" | "food" | "children" | "insured" | "taxable">,
  input: SlipInput,
  y: IPayrollYear,
): IBizPayslip => {
  const days = Math.max(0, Math.min(31, Number(input.workedDays) || 0));
  // base pay is daily wage x days (a 31-day month pays 31 days, as on the
  // Tamin list); the monthly allowances stop at a full month
  const ratio = days / STANDARD_DAYS;
  const capped = Math.min(1, ratio);
  const base = round(emp.baseSalary * ratio);
  const housing = emp.housing ? round(y.housing * capped) : 0;
  const food = emp.food ? round(y.food * capped) : 0;
  // child allowance is per child, not per day; it is neither insured nor taxed
  const child = round(y.childAllowance * Math.max(0, emp.children || 0) * (days > 0 ? 1 : 0));
  const overtime = round((emp.baseSalary / (y.monthHours || 220)) * y.overtimeMultiplier * Math.max(0, input.overtimeHours || 0));
  const other = round(Math.max(0, input.otherEarnings || 0));
  const gross = base + housing + food + child + overtime + other;

  const insurable = base + housing + food + overtime + other;
  const floor = round(y.minWage * ratio);
  const ceiling = round(y.minWage * y.insuranceCeilingMultiplier * ratio);
  const insuranceBase = emp.insured && days > 0 ? Math.min(ceiling, Math.max(floor, insurable)) : 0;
  const insuranceEmployee = round((insuranceBase * y.employeeInsuranceRate) / 100);
  const insuranceEmployer = round((insuranceBase * y.employerInsuranceRate) / 100);

  const taxableBase = emp.taxable ? Math.max(0, insurable - insuranceEmployee) : 0;
  const tax = emp.taxable ? progressiveTax(taxableBase, y.taxExemption, y.brackets) : 0;
  const deductions = round(Math.max(0, input.deductions || 0));
  const net = gross - insuranceEmployee - tax - deductions;

  return {
    employee: oid(emp._id),
    name: emp.name,
    nationalId: emp.nationalId,
    insuranceNo: emp.insuranceNo,
    position: emp.position,
    workedDays: days,
    overtimeHours: Math.max(0, input.overtimeHours || 0),
    otherEarnings: other,
    deductions,
    baseSalary: emp.baseSalary,
    base,
    housing,
    food,
    child,
    overtime,
    gross,
    insuranceBase,
    insuranceEmployee,
    insuranceEmployer,
    taxableBase,
    tax,
    net,
  };
};

const totalsOf = (slips: IBizPayslip[]) => ({
  gross: slips.reduce((s, x) => s + x.gross, 0),
  insuranceEmployee: slips.reduce((s, x) => s + x.insuranceEmployee, 0),
  insuranceEmployer: slips.reduce((s, x) => s + x.insuranceEmployer, 0),
  tax: slips.reduce((s, x) => s + x.tax, 0),
  deductions: slips.reduce((s, x) => s + x.deductions, 0),
  net: slips.reduce((s, x) => s + x.net, 0),
});

export const yearRules = async (year: number) => {
  const y = await PayrollYear.findOne({ year }).lean<IPayrollYear>();
  if (!y) throw new AppError("قوانین حقوق و دستمزد این سال هنوز در سوپر ادمین ثبت نشده است", 400);
  return y;
};

// ---------------------------------------------------------------- runs

// A month's run, its slips taken from the active employees (worked days =
// days of the month). One run per month.
export const createPayrun = async (owner: BizOwner, year: number, month: number, userId?: unknown) => {
  const rules = await yearRules(year);
  const exists = await BizPayrun.findOne({ ...own(owner), year, month }).select("_id").lean();
  if (exists) throw new AppError("حقوق این ماه قبلاً ساخته شده است", 400);
  const period = jalaliPeriod(year, month);
  const emps = await BizEmployee.find({
    ...own(owner),
    isActive: true,
    $and: [
      { $or: [{ hireDate: { $exists: false } }, { hireDate: null }, { hireDate: { $lte: period.end } }] },
      { $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gte: period.start } }] },
    ],
  })
    .sort({ name: 1 })
    .lean<IBizEmployee[]>();
  if (!emps.length) throw new AppError("اول کارکنان را اضافه کنید", 400);
  const slips = emps.map((e) =>
    computeSlip(e, { workedDays: period.days, overtimeHours: 0, otherEarnings: 0, deductions: 0 }, rules),
  );
  return BizPayrun.create({
    ...own(owner),
    year,
    month,
    periodStart: period.start,
    periodEnd: period.end,
    slips,
    totals: totalsOf(slips),
    createdBy: userId,
  });
};

// The draft's inputs change: every slip is computed again from the
// employee's current contract and the year's rules.
export const updatePayrun = async (
  owner: BizOwner,
  id: unknown,
  inputs: ({ employee: string } & SlipInput)[],
) => {
  const run = await BizPayrun.findOne({ ...own(owner), _id: id }).lean<IBizPayrun>();
  if (!run) throw new AppError("لیست حقوق پیدا نشد", 404);
  if (run.status !== "draft") throw new AppError("فقط پیش‌نویس لیست حقوق ویرایش می‌شود", 400);
  const rules = await yearRules(run.year);
  const ids = inputs.map((i) => i.employee);
  if (new Set(ids).size !== ids.length) throw new AppError("هر کارمند یک بار در لیست حقوق می‌آید", 400);
  const emps = await BizEmployee.find({ ...own(owner), _id: { $in: ids } }).lean<IBizEmployee[]>();
  const byId = new Map(emps.map((e) => [String(e._id), e]));
  const slips = inputs.map((i) => {
    const e = byId.get(String(i.employee));
    if (!e) throw new AppError("کارمند این ردیف پیدا نشد", 400);
    return computeSlip(e, i, rules);
  });
  if (!slips.length) throw new AppError("اول کارکنان را اضافه کنید", 400);
  await BizPayrun.updateOne({ _id: run._id, status: "draft" }, { $set: { slips, totals: totalsOf(slips) } });
  return BizPayrun.findById(run._id).lean();
};

const MONTH_REF = (run: Pick<IBizPayrun, "_id" | "postSeq">) => `payrun:${run._id}:${run.postSeq}`;

// Into the books: Dr salary expense (gross) + Dr employer's insurance / Cr
// net pay owed + insurance and tax owed + what is kept back for advances.
export const postPayrun = async (owner: BizOwner, id: unknown) => {
  const run = await BizPayrun.findOne({ ...own(owner), _id: id }).lean<IBizPayrun>();
  if (!run) throw new AppError("لیست حقوق پیدا نشد", 404);
  if (run.status !== "draft") throw new AppError("این لیست حقوق قبلاً ثبت شده است", 400);
  if (!run.slips.length) throw new AppError("اول کارکنان را اضافه کنید", 400);
  if (run.slips.some((s) => s.net < 0)) throw new AppError("خالص پرداختی یکی از کارکنان منفی شده است؛ کسورات را اصلاح کنید", 400);
  const t = run.totals;
  const seq = run.postSeq + 1;
  const claimed = await BizPayrun.updateOne(
    { _id: run._id, status: "draft", postSeq: run.postSeq },
    { $set: { status: "posted", postSeq: seq, postedAt: new Date() } },
  );
  if (!claimed.modifiedCount) throw new AppError("این لیست حقوق هم‌زمان تغییر کرد؛ دوباره تلاش کنید", 409);
  const lines: PostLine[] = [
    { role: "salaryExpense", debit: t.gross },
    { role: "employerInsurance", debit: t.insuranceEmployer },
    { role: "salaryPayable", credit: t.net },
    { role: "payrollTaxPayable", credit: t.insuranceEmployee + t.insuranceEmployer + t.tax },
    { role: "employeeAdvances", credit: t.deductions },
  ];
  try {
    await postVoucher(owner, {
      ref: MONTH_REF({ _id: run._id, postSeq: seq }),
      date: run.periodEnd,
      description: "حقوق و دستمزد ماه",
      source: { type: "payrun", id: run._id },
      lines,
    });
  } catch (err) {
    await BizPayrun.updateOne({ _id: run._id }, { $set: { status: "draft", postSeq: run.postSeq }, $unset: { postedAt: 1 } });
    throw err;
  }
  return BizPayrun.findById(run._id).lean();
};

const payVia = async (owner: BizOwner, via: string) => {
  const acc = await BizAccount.findOne({ ...ownerFilter(owner), _id: via }).lean();
  if (!acc || acc.type !== "asset" || acc.level !== "detail")
    throw new AppError("پرداخت یا دریافت فقط از صندوق، بانک یا کیف پول ممکن است", 400);
  return acc;
};

// The salaries are paid (Dr net pay owed / Cr cash or bank), or insurance
// and tax are paid to Tamin and the tax office (Dr insurance and tax owed /
// Cr cash or bank).
export const payPayrun = async (
  owner: BizOwner,
  id: unknown,
  what: "salaries" | "liabilities",
  via: string,
  date?: Date,
) => {
  const run = await BizPayrun.findOne({ ...own(owner), _id: id }).lean<IBizPayrun>();
  if (!run) throw new AppError("لیست حقوق پیدا نشد", 404);
  if (run.status !== "posted") throw new AppError("پرداخت فقط برای لیست حقوق ثبت‌شده ممکن است", 400);
  const field = what === "salaries" ? "salariesPaidAt" : "liabilitiesPaidAt";
  if (run[field]) throw new AppError("این پرداخت قبلاً ثبت شده است", 400);
  const acc = await payVia(owner, via);
  const t = run.totals;
  const amount = what === "salaries" ? t.net : t.insuranceEmployee + t.insuranceEmployer + t.tax;
  const claimed = await BizPayrun.updateOne(
    { _id: run._id, status: "posted", [field]: { $exists: false } },
    { $set: { [field]: date || new Date(), [what === "salaries" ? "salariesVia" : "liabilitiesVia"]: acc._id } },
  );
  if (!claimed.modifiedCount) throw new AppError("این پرداخت قبلاً ثبت شده است", 400);
  if (amount > 0)
    await postVoucher(owner, {
      ref: `${MONTH_REF(run)}:${what}`,
      date: date || new Date(),
      description: what === "salaries" ? "پرداخت حقوق کارکنان" : "پرداخت بیمه و مالیات حقوق",
      source: { type: "payrun", id: run._id },
      lines: [
        { role: what === "salaries" ? "salaryPayable" : "payrollTaxPayable", debit: amount },
        { accountId: acc._id, credit: amount },
      ],
    });
  return BizPayrun.findById(run._id).lean();
};

// Back to draft: the month's voucher is reversed, only while nothing of the
// run was paid. A draft is deleted instead.
export const reopenPayrun = async (owner: BizOwner, id: unknown) => {
  const run = await BizPayrun.findOne({ ...own(owner), _id: id }).lean<IBizPayrun>();
  if (!run) throw new AppError("لیست حقوق پیدا نشد", 404);
  if (run.status === "draft") {
    await BizPayrun.deleteOne({ _id: run._id, status: "draft" });
    return null;
  }
  if (run.salariesPaidAt || run.liabilitiesPaidAt)
    throw new AppError("برای این لیست حقوق پرداخت ثبت شده و برنمی‌گردد", 400);
  const claimed = await BizPayrun.updateOne(
    { _id: run._id, status: "posted", postSeq: run.postSeq, salariesPaidAt: { $exists: false }, liabilitiesPaidAt: { $exists: false } },
    { $set: { status: "draft" }, $unset: { postedAt: 1 } },
  );
  if (!claimed.modifiedCount) throw new AppError("این لیست حقوق هم‌زمان تغییر کرد؛ دوباره تلاش کنید", 409);
  const original = await BizVoucher.findOne({ ...ownerFilter(owner), ref: MONTH_REF(run) }).lean<IBizVoucher>();
  if (original?.lines?.length)
    await postVoucher(owner, {
      ref: `${MONTH_REF(run)}:rev`,
      date: new Date(),
      description: "برگشت سند حقوق و دستمزد ماه",
      source: { type: "payrun", id: run._id },
      lines: original.lines.map((l) => ({ accountId: String(l.account), debit: l.credit, credit: l.debit })),
    });
  return BizPayrun.findById(run._id).lean();
};

// An advance (مساعده) or loan paid to an employee: Dr staff advances / Cr
// cash or bank. The month's payslip takes it back as a deduction, which
// credits the same account.
export const payAdvance = async (owner: BizOwner, employeeId: unknown, amount: number, via: string, date?: Date) => {
  const emp = await BizEmployee.findOne({ ...own(owner), _id: employeeId }).lean<IBizEmployee>();
  if (!emp) throw new AppError("کارمند این ردیف پیدا نشد", 404);
  const acc = await payVia(owner, via);
  const value = round(amount);
  if (!(value > 0)) throw new AppError("مبلغ و حساب پرداخت را مشخص کنید", 400);
  return postVoucher(owner, {
    date: date || new Date(),
    description: "پرداخت مساعده به کارمند",
    source: { type: "employee", id: emp._id },
    lines: [
      { role: "employeeAdvances", debit: value, label: emp.name },
      { accountId: acc._id, credit: value, label: emp.name },
    ],
  });
};
