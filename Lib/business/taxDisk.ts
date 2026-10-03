import mongoose from "mongoose";
import moment from "moment-jalaali";
import BizPayrun, { IBizPayrun } from "../../Models/BizPayrun";
import BizBonusRun, { IBizBonusRun } from "../../Models/BizBonusRun";
import BizEmployee, { IBizEmployee } from "../../Models/BizEmployee";
import AppError from "../AppError";
import { BizOwner } from "./coa";
import { encoders, getPayrollSettings, normalize, zip } from "./taminDisk";

// The month's salary tax list (فهرست مالیات حقوق) as the two text files the
// my.tax.gov.ir portal takes (2026-10): WP for the staff, one line per
// person, and WH for what each was paid that month and the tax withheld.
// Comma-separated, one line per row, amounts in rials, Jalali dates as
// YYYY/MM/DD. Windows-1256 by default (what the tax office's own software
// writes), UTF-8 if the workshop sets it. The columns are listed once below:
// if the portal rejects one, fix its place there.
//
// Esfand's file (or the month of a settlement) also carries the عیدی and
// سنوات of the bonus runs posted for that month.

const oid = (v: unknown) => new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));
const own = (o: BizOwner) => ({ ownerKind: o.kind, ownerId: oid(o.id) });
const rial = (toman: number) => Math.round((Number(toman) || 0) * 10);
const jdate = (d?: Date | null) => (d ? moment(d).utcOffset(210).format("jYYYY/jMM/jDD") : "");

// the tax office's codes
const EDUCATION: Record<string, number> = { belowDiploma: 1, diploma: 2, associate: 3, bachelor: 4, master: 5, doctorate: 6 };
const CONTRACT: Record<string, number> = { permanent: 1, temporary: 2, partTime: 3 };
const WORKPLACE: Record<string, number> = { normal: 1, lessDeveloped: 2, freeZone: 3 };

const isIranian = (e: Pick<IBizEmployee, "nationality">) => !e.nationality || /ایران|iran/i.test(normalize(e.nationality));

const splitName = (e: Pick<IBizEmployee, "name" | "firstName" | "lastName">) => {
  if (e.firstName || e.lastName) return { first: e.firstName || "", last: e.lastName || "" };
  const parts = (e.name || "").trim().split(/\s+/);
  return { first: parts.slice(0, -1).join(" ") || parts[0] || "", last: parts.length > 1 ? parts[parts.length - 1] : "" };
};

// a valid Iranian national code: 10 digits and its check digit
export const validNationalId = (v?: string) => {
  if (!v || !/^\d{10}$/.test(v) || /^(\d)\1{9}$/.test(v)) return false;
  const sum = [...v.slice(0, 9)].reduce((s, d, i) => s + Number(d) * (10 - i), 0) % 11;
  const check = Number(v[9]);
  return sum < 2 ? check === sum : check === 11 - sum;
};

type Row = {
  e: IBizEmployee;
  months: number;
  continuous: number; // حقوق و مزایای مستمر نقدی
  overtime: number;
  other: number; // سایر پرداخت‌های غیرمستمر نقدی
  eid: number;
  severance: number;
  insurance: number; // حق بیمه‌ی سهم کارمند (معاف)
  exempt: number; // حق اولاد و سنوات (معاف)
  tax: number;
};

// one column of a file: its name in the tax office's guide and its value
type Column<T> = { label: string; value: (r: T) => string | number };

const WP: Column<{ e: IBizEmployee; workplace: number }>[] = [
  { label: "نوع تابعیت", value: ({ e }) => (isIranian(e) ? 1 : 2) },
  { label: "کد ملی / کد فراگیر اتباع", value: ({ e }) => e.nationalId || "" },
  { label: "نام", value: ({ e }) => splitName(e).first },
  { label: "نام خانوادگی", value: ({ e }) => splitName(e).last },
  { label: "کشور", value: ({ e }) => (isIranian(e) ? "" : e.nationality || "") },
  { label: "شماره‌ی گذرنامه", value: () => "" },
  { label: "مدرک تحصیلی", value: ({ e }) => (e.education ? EDUCATION[e.education] : "") },
  { label: "سمت", value: ({ e }) => e.position || "" },
  { label: "نوع بیمه", value: ({ e }) => (e.insured ? 1 : 3) },
  { label: "نام بیمه", value: ({ e }) => (e.insured ? "تأمین اجتماعی" : "") },
  { label: "شماره‌ی بیمه", value: ({ e }) => e.insuranceNo || "" },
  { label: "کد پستی محل سکونت", value: ({ e }) => e.postalCode || "" },
  { label: "تاریخ استخدام", value: ({ e }) => jdate(e.hireDate) },
  { label: "نوع استخدام", value: () => 3 },
  { label: "وضعیت محل خدمت", value: ({ workplace }) => workplace },
  { label: "نوع قرارداد", value: ({ e }) => (e.contractType ? CONTRACT[e.contractType] : 2) },
  { label: "تاریخ پایان کار", value: ({ e }) => jdate(e.endDate) },
  { label: "وضعیت کارمند", value: ({ e }) => (e.endDate && e.endDate <= new Date() ? 2 : 1) },
  { label: "شماره‌ی تلفن همراه", value: ({ e }) => (e.mobile || "").replace(/^\+?98/, "0") },
];

const WH: Column<Row>[] = [
  { label: "کد ملی / کد فراگیر اتباع", value: (r) => r.e.nationalId || "" },
  { label: "نوع پرداخت", value: () => 1 },
  { label: "تعداد ماه‌های کارکرد از ابتدای سال", value: (r) => r.months },
  { label: "نوع ارز", value: () => 1 },
  { label: "نرخ تسعیر ارز", value: () => 1 },
  { label: "ناخالص حقوق و مزایای مستمر نقدی", value: (r) => rial(r.continuous) },
  { label: "مسکن", value: () => 0 },
  { label: "وسیله‌ی نقلیه", value: () => 0 },
  { label: "سایر مزایای مستمر غیرنقدی", value: () => 0 },
  { label: "اضافه‌کاری", value: (r) => rial(r.overtime) },
  { label: "سایر پرداخت‌های غیرمستمر نقدی", value: (r) => rial(r.other) },
  { label: "عیدی و پاداش", value: (r) => rial(r.eid) },
  { label: "سنوات و بازخرید", value: (r) => rial(r.severance) },
  { label: "حق بیمه‌ی سهم کارمند", value: (r) => rial(r.insurance) },
  { label: "سایر معافیت‌ها", value: (r) => rial(r.exempt) },
  { label: "مالیات متعلقه", value: (r) => rial(r.tax) },
];

const line = (cells: (string | number)[]) => cells.map((c) => String(c).replace(/[,\r\n]/g, " ")).join(",");

const loadMonth = async (owner: BizOwner, runId: unknown) => {
  const run = await BizPayrun.findOne({ ...own(owner), _id: runId }).lean<IBizPayrun>();
  if (!run) throw new AppError("لیست حقوق پیدا نشد", 404);
  // bonus runs posted for this month: Esfand's, or a settlement in it
  const bonuses = await BizBonusRun.find({
    ...own(owner),
    status: "posted",
    date: { $gte: run.periodStart, $lte: run.periodEnd },
  }).lean<IBizBonusRun[]>();
  // months on the payroll this year, up to this one
  const earlier = await BizPayrun.find({ ...own(owner), year: run.year, month: { $lte: run.month } })
    .select("slips.employee")
    .lean<Pick<IBizPayrun, "slips">[]>();
  const months = new Map<string, number>();
  for (const r of earlier) for (const s of r.slips) months.set(String(s.employee), (months.get(String(s.employee)) || 0) + 1);

  const rows = new Map<string, Omit<Row, "e">>();
  const blank = (id: string) => ({ months: Math.max(1, months.get(id) || 0), continuous: 0, overtime: 0, other: 0, eid: 0, severance: 0, insurance: 0, exempt: 0, tax: 0 });
  for (const s of run.slips) {
    const id = String(s.employee);
    const r = rows.get(id) || blank(id);
    r.continuous += s.base + s.housing + s.food + s.child;
    r.overtime += s.overtime;
    r.other += Math.max(0, s.gross - s.base - s.housing - s.food - s.child - s.overtime);
    r.insurance += s.insuranceEmployee;
    r.exempt += s.child;
    r.tax += s.tax;
    rows.set(id, r);
  }
  for (const b of bonuses)
    for (const s of b.slips) {
      const id = String(s.employee);
      const r = rows.get(id) || blank(id);
      r.eid += s.eid;
      r.severance += s.severance;
      r.exempt += s.severance;
      r.tax += s.tax;
      rows.set(id, r);
    }
  const emps = await BizEmployee.find({ ...own(owner), _id: { $in: [...rows.keys()].map(oid) } }).lean<IBizEmployee[]>();
  const byId = new Map(emps.map((e) => [String(e._id), e]));
  const list: Row[] = [];
  for (const [id, r] of rows) {
    const e = byId.get(id);
    if (e) list.push({ e, ...r });
  }
  list.sort((a, b) => a.e.name.localeCompare(b.e.name, "fa"));
  return { run, bonuses, rows: list };
};

// what the files of a month need and still miss
export const taxProblems = async (owner: BizOwner, runId: unknown) => {
  const m = await loadMonth(owner, runId);
  const missing: { name: string; fields: string[] }[] = [];
  for (const r of m.rows) {
    const fields: string[] = [];
    if (isIranian(r.e) ? !validNationalId(r.e.nationalId) : !r.e.nationalId) fields.push("nationalId");
    if (!r.e.education) fields.push("education");
    if (!r.e.hireDate) fields.push("hireDate");
    if (fields.length) missing.push({ name: r.e.name, fields });
  }
  const sum = (k: "continuous" | "eid" | "severance" | "tax") => m.rows.reduce((a, r) => a + r[k], 0);
  return {
    ...m,
    missing,
    totals: { staff: m.rows.length, paid: sum("continuous") + m.rows.reduce((a, r) => a + r.overtime + r.other, 0), eid: sum("eid"), severance: sum("severance"), tax: sum("tax") },
  };
};

export const taxDisk = async (owner: BizOwner, runId: unknown) => {
  const p = await taxProblems(owner, runId);
  if (!p.rows.length) throw new AppError("در این لیست کارمندی نیست", 400);
  if (p.missing.length) throw new AppError("کد ملی، مدرک تحصیلی یا تاریخ استخدام این کارکنان ثبت نشده است: ${1}".replace("${1}", p.missing.map((m) => m.name).join("، ")), 400);
  const s = await getPayrollSettings(owner);
  const workplace = WORKPLACE[s?.workplaceStatus || "normal"] || 1;
  const encode = (text: string) =>
    s?.taxEncoding === "utf8" ? Buffer.from(normalize(text), "utf8") : encoders.toW1256(text);
  const body = (lines: string[]) => encode(lines.join("\r\n") + "\r\n");
  const wp = body(p.rows.map((r) => line(WP.map((c) => c.value({ e: r.e, workplace })))));
  const wh = body(p.rows.map((r) => line(WH.map((c) => c.value(r)))));
  // the same two lists with their column names, to read or check in Excel
  const csv = (cols: Column<never>[], rows: (string | number)[][]) =>
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([line(cols.map((c) => c.label)), ...rows.map(line)].join("\r\n"), "utf8")]);
  const tag = `${p.run.year}${String(p.run.month).padStart(2, "0")}`;
  return {
    file: zip([
      { name: `WP${tag}.txt`, data: wp },
      { name: `WH${tag}.txt`, data: wh },
      { name: `WP${tag}-columns.csv`, data: csv(WP as Column<never>[], p.rows.map((r) => WP.map((c) => c.value({ e: r.e, workplace })))) },
      { name: `WH${tag}-columns.csv`, data: csv(WH as Column<never>[], p.rows.map((r) => WH.map((c) => c.value(r)))) },
    ]),
    name: `tax-${p.run.year}-${String(p.run.month).padStart(2, "0")}.zip`,
  };
};
