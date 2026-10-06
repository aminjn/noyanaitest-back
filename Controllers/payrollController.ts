import { tehranNoonOf } from "../Lib/tehranTime";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import mongoose, { isValidObjectId } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import BizEmployee, { bizContractTypes, bizEducations } from "../Models/BizEmployee";
import BizPayrun from "../Models/BizPayrun";
import BizAccount from "../Models/BizAccount";
import PayrollYear from "../Models/PayrollYear";
import { BizOwner, displayName, ensureChart, ownerFilter } from "../Lib/business/coa";
import { currentLocale } from "../Lib/i18n/requestContext";
import {
  createPayrun,
  jalaliToday,
  payAdvance,
  payPayrun,
  postPayrun,
  reopenPayrun,
  updatePayrun,
  advanceBalances,
} from "../Lib/business/payroll";
import { OwnerOf } from "./businessController";
import BizBonusRun from "../Models/BizBonusRun";
import BizPayrollSettings, { diskEncodings, taxEncodings, workplaceStatuses } from "../Models/BizPayrollSettings";
import { createBonusRun, payBonusRun, postBonusRun, reopenBonusRun, updateBonusRun } from "../Lib/business/bonus";
import { diskProblems, getPayrollSettings, taminDisk } from "../Lib/business/taminDisk";
import { taxDisk, taxProblems } from "../Lib/business/taxDisk";

// Noyan Business payroll API (2026-10, under /<panel>/payroll): employees,
// the month's runs and their payments. Reading needs the panel's
// readPayroll, writing managePayroll; the plan module "payroll" opens it
// (Routers/payrollRoutes.ts). The year's legal figures are the super
// admin's (adminPayrollYears below).

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));
const own = (o: BizOwner) => ({ ownerKind: o.kind, ownerId: oid(o.id) });
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .nullable();
// noon of the Tehran day (Lib/tehranTime.ts)
const dateOf = (s?: string | null) => (s ? tehranNoonOf(s) : undefined);

const withOwner = (ownerOf: OwnerOf, fn: (owner: BizOwner, req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const owner = ownerOf(req);
    if (!owner?.id) return next(new NotFoundError());
    await fn(owner, req, res);
  });

const employeeBody = z.object({
  name: z.string().trim().min(2).max(200),
  nationalId: z
    .string()
    .trim()
    .regex(/^\d{10}$/)
    .optional()
    .or(z.literal("")),
  mobile: z.string().trim().max(20).optional(),
  position: z.string().trim().max(100).optional(),
  hireDate: day,
  endDate: day,
  baseSalary: z.coerce.number().min(0).max(1e12),
  housing: z.boolean().default(true),
  food: z.boolean().default(true),
  children: z.coerce.number().int().min(0).max(20).default(0),
  insured: z.boolean().default(true),
  insuranceNo: z.string().trim().max(20).optional(),
  taxable: z.boolean().default(true),
  iban: z
    .string()
    .trim()
    .regex(/^(IR)?\d{24}$/i)
    .optional()
    .or(z.literal("")),
  isActive: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
  // for the Tamin list disk
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  fatherName: z.string().trim().max(100).optional(),
  idNumber: z.string().trim().max(15).optional(),
  idPlace: z.string().trim().max(100).optional(),
  birthDate: day,
  gender: z.enum(["male", "female"]).optional().nullable(),
  nationality: z.string().trim().max(20).optional(),
  jobCode: z
    .string()
    .trim()
    .regex(/^\d{0,6}$/)
    .optional(),
  // for the salary tax list
  education: z.enum(bizEducations).optional().nullable(),
  postalCode: z
    .string()
    .trim()
    .regex(/^(\d{10})?$/)
    .optional(),
  contractType: z.enum(bizContractTypes).optional().nullable(),
});

const employeeData = (b: Partial<z.infer<typeof employeeBody>>) => {
  const { hireDate, endDate, nationalId, iban, birthDate, gender, education, contractType, ...rest } = b;
  return {
    ...rest,
    ...(education !== undefined ? { education: education || undefined } : {}),
    ...(contractType !== undefined ? { contractType: contractType || undefined } : {}),
    ...(birthDate !== undefined ? { birthDate: dateOf(birthDate) || null } : {}),
    ...(gender !== undefined ? { gender: gender || undefined } : {}),
    ...(nationalId !== undefined ? { nationalId: nationalId || undefined } : {}),
    ...(iban !== undefined ? { iban: iban ? (iban.toUpperCase().startsWith("IR") ? iban.toUpperCase() : `IR${iban}`) : undefined } : {}),
    ...(hireDate !== undefined ? { hireDate: dateOf(hireDate) || null } : {}),
    ...(endDate !== undefined ? { endDate: dateOf(endDate) || null } : {}),
  };
};

export const makePayrollController = (ownerOf: OwnerOf) => ({
  getEmployees: withOwner(ownerOf, async (owner, _req, res) => {
    const [rows, advances] = await Promise.all([BizEmployee.find(own(owner)).sort({ isActive: -1, name: 1 }).lean(), advanceBalances(owner)]);
    // (2026-10) what each one still owes for advances and loans
    res.status(200).json({ message: "payEmployees", data: rows.map((r) => ({ ...r, advanceBalance: advances.get(String(r._id)) || 0 })) });
  }),

  createEmployee: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = employeeBody.safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام، حقوق پایه و (در صورت ثبت) کد ملی ۱۰ رقمی و شبای ۲۴ رقمی را درست وارد کنید", 400);
    const emp = await BizEmployee.create({ ...own(owner), ...employeeData(parsed.data) });
    res.status(201).json({ message: "payCreateEmployee", data: emp });
  }),

  updateEmployee: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = employeeBody.partial().safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.employeeId))
      throw new AppError("نام، حقوق پایه و (در صورت ثبت) کد ملی ۱۰ رقمی و شبای ۲۴ رقمی را درست وارد کنید", 400);
    const emp = await BizEmployee.findOneAndUpdate(
      { ...own(owner), _id: req.params.employeeId },
      { $set: employeeData(parsed.data) },
      { new: true },
    ).lean();
    if (!emp) throw new NotFoundError();
    res.status(200).json({ message: "payUpdateEmployee", data: emp });
  }),

  advance: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({ amount: z.coerce.number().positive().max(1e12), via: z.string(), date: day })
      .safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.employeeId) || !isValidObjectId(parsed.data.via))
      throw new AppError("مبلغ و حساب پرداخت را مشخص کنید", 400);
    const voucher = await payAdvance(owner, req.params.employeeId, parsed.data.amount, parsed.data.via, dateOf(parsed.data.date));
    res.status(201).json({ message: "payAdvance", data: voucher });
  }),

  // the run list, the current Jalali month and which years have rules
  getRuns: withOwner(ownerOf, async (owner, _req, res) => {
    const [runs, years] = await Promise.all([
      BizPayrun.find(own(owner)).select("-slips").sort({ year: -1, month: -1 }).limit(60).lean(),
      PayrollYear.find().select("year").sort({ year: -1 }).lean(),
    ]);
    res.status(200).json({
      message: "payRuns",
      data: { runs, today: jalaliToday(), years: years.map((y) => y.year) },
    });
  }),

  getRun: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.runId)) throw new NotFoundError();
    const run = await BizPayrun.findOne({ ...own(owner), _id: req.params.runId })
      .populate("salariesVia liabilitiesVia", "code name role")
      .lean();
    if (!run) throw new NotFoundError();
    res.status(200).json({ message: "payRun", data: run });
  }),

  createRun: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({ year: z.coerce.number().int().min(1400).max(1500), month: z.coerce.number().int().min(1).max(12) })
      .safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const run = await createPayrun(owner, parsed.data.year, parsed.data.month, req.user?._id);
    res.status(201).json({ message: "payCreateRun", data: run });
  }),

  updateRun: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        slips: z
          .array(
            z.object({
              employee: z.string(),
              workedDays: z.coerce.number().min(0).max(31),
              overtimeHours: z.coerce.number().min(0).max(400).default(0),
              otherEarnings: z.coerce.number().min(0).max(1e12).default(0),
              deductions: z.coerce.number().min(0).max(1e12).default(0),
            }),
          )
          .min(1)
          .max(500),
      })
      .safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.runId) || parsed.data.slips.some((s) => !isValidObjectId(s.employee)))
      throw new BadInputError();
    const run = await updatePayrun(owner, req.params.runId, parsed.data.slips);
    res.status(200).json({ message: "payUpdateRun", data: run });
  }),

  postRun: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.runId)) throw new NotFoundError();
    res.status(200).json({ message: "payPostRun", data: await postPayrun(owner, req.params.runId) });
  }),

  payRun: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({ what: z.enum(["salaries", "liabilities"]), via: z.string(), date: day })
      .safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.runId) || !isValidObjectId(parsed.data.via))
      throw new AppError("مبلغ و حساب پرداخت را مشخص کنید", 400);
    const run = await payPayrun(owner, req.params.runId, parsed.data.what, parsed.data.via, dateOf(parsed.data.date));
    res.status(200).json({ message: "payPayRun", data: run });
  }),

  reopenRun: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.runId)) throw new NotFoundError();
    res.status(200).json({ message: "payReopenRun", data: await reopenPayrun(owner, req.params.runId) });
  }),

  // the workshop Tamin knows this owner as (for the list disk)
  getSettings: withOwner(ownerOf, async (owner, _req, res) => {
    res.status(200).json({ message: "paySettings", data: (await getPayrollSettings(owner)) || { contractRow: "000", listNo: "01", encoding: "iransystem", taxEncoding: "windows1256", workplaceStatus: "normal" } });
  }),

  saveSettings: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        workshopCode: z.string().trim().regex(/^\d{0,10}$/).optional(),
        workshopName: z.string().trim().max(100).optional(),
        employerName: z.string().trim().max(100).optional(),
        address: z.string().trim().max(100).optional(),
        contractRow: z.string().trim().regex(/^\d{3}$/).optional(),
        listNo: z.string().trim().regex(/^\d{1,12}$/).optional(),
        encoding: z.enum(diskEncodings).optional(),
        taxEncoding: z.enum(taxEncodings).optional(),
        workplaceStatus: z.enum(workplaceStatuses).optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) throw new AppError("کد کارگاه ۱۰ رقمی و ردیف پیمان ۳ رقمی است", 400);
    const row = await BizPayrollSettings.findOneAndUpdate(own(owner), { $set: parsed.data }, { upsert: true, new: true }).lean();
    res.status(200).json({ message: "paySaveSettings", data: row });
  }),

  // what the month's disk still misses, then the zip itself
  getDiskCheck: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.runId)) throw new NotFoundError();
    const p = await diskProblems(owner, req.params.runId);
    res.status(200).json({ message: "payDiskCheck", data: { workshop: p.workshop, missing: p.missing, insured: p.insured.length } });
  }),

  getDisk: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.runId)) throw new NotFoundError();
    const { file, name } = await taminDisk(owner, req.params.runId);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.status(200).send(file);
  }),

  // the month's salary tax list files for my.tax.gov.ir (Lib/business/taxDisk.ts)
  getTaxCheck: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.runId)) throw new NotFoundError();
    const p = await taxProblems(owner, req.params.runId);
    res.status(200).json({ message: "payTaxCheck", data: { missing: p.missing, totals: p.totals, bonuses: p.bonuses.length } });
  }),

  getTaxDisk: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.runId)) throw new NotFoundError();
    const { file, name } = await taxDisk(owner, req.params.runId);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.status(200).send(file);
  }),

  // عیدی و سنوات (Lib/business/bonus.ts)
  getBonusRuns: withOwner(ownerOf, async (owner, _req, res) => {
    const rows = await BizBonusRun.find(own(owner)).sort({ year: -1, createdAt: -1 }).limit(40).lean();
    res.status(200).json({ message: "payBonusRuns", data: rows });
  }),

  createBonusRun: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({ year: z.coerce.number().int().min(1400).max(1500), employees: z.array(z.string()).max(500).optional() })
      .safeParse(req.body || {});
    if (!parsed.success || parsed.data.employees?.some((e) => !isValidObjectId(e))) throw new BadInputError();
    const run = await createBonusRun(owner, parsed.data.year, parsed.data.employees, req.user?._id);
    res.status(201).json({ message: "payCreateBonusRun", data: run });
  }),

  updateBonusRun: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        slips: z
          .array(z.object({ employee: z.string(), days: z.coerce.number().min(0).max(366), deductions: z.coerce.number().min(0).max(1e12).default(0) }))
          .min(1)
          .max(500),
      })
      .safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.bonusId) || parsed.data.slips.some((s) => !isValidObjectId(s.employee)))
      throw new BadInputError();
    res.status(200).json({ message: "payUpdateBonusRun", data: await updateBonusRun(owner, req.params.bonusId, parsed.data.slips) });
  }),

  postBonusRun: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.bonusId)) throw new NotFoundError();
    res.status(200).json({ message: "payPostBonusRun", data: await postBonusRun(owner, req.params.bonusId) });
  }),

  payBonusRun: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ what: z.enum(["salaries", "liabilities"]), via: z.string(), date: day }).safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.bonusId) || !isValidObjectId(parsed.data.via))
      throw new AppError("مبلغ و حساب پرداخت را مشخص کنید", 400);
    res.status(200).json({
      message: "payPayBonusRun",
      data: await payBonusRun(owner, req.params.bonusId, parsed.data.what, parsed.data.via, dateOf(parsed.data.date)),
    });
  }),

  reopenBonusRun: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.bonusId)) throw new NotFoundError();
    res.status(200).json({ message: "payReopenBonusRun", data: await reopenBonusRun(owner, req.params.bonusId) });
  }),

  // cash, bank and the Noyan wallet (and sub-accounts opened under them)
  getPayAccounts: withOwner(ownerOf, async (owner, _req, res) => {
    await ensureChart(owner);
    const rows = await BizAccount.find({
      ...ownerFilter(owner),
      type: "asset",
      level: "detail",
      $or: [{ role: { $in: ["cash", "bank", "noyanWallet"] } }, { parentCode: "11", role: { $exists: false } }],
    })
      .sort({ code: 1 })
      .select("code name role")
      .lean();
    res.status(200).json({
      message: "payPayAccounts",
      data: rows.map((a) => ({ ...a, name: displayName(a, currentLocale()) })),
    });
  }),

  // the year's legal figures, read-only for the provider (shown on the page)
  getYear: catchAsync(async (req: Request, res: Response) => {
    const year = Number(req.params.year);
    const y = await PayrollYear.findOne({ year }).lean();
    if (!y) throw new NotFoundError();
    res.status(200).json({ message: "payYear", data: y });
  }),
});

// ---------------------------------------------------------------- super admin

const yearBody = z.object({
  minWage: z.coerce.number().positive().max(1e12),
  housing: z.coerce.number().min(0).max(1e12),
  food: z.coerce.number().min(0).max(1e12),
  childAllowance: z.coerce.number().min(0).max(1e12),
  employeeInsuranceRate: z.coerce.number().min(0).max(100),
  employerInsuranceRate: z.coerce.number().min(0).max(100),
  insuranceCeilingMultiplier: z.coerce.number().min(1).max(50),
  overtimeMultiplier: z.coerce.number().min(1).max(5),
  monthHours: z.coerce.number().min(1).max(400),
  taxExemption: z.coerce.number().min(0).max(1e13),
  brackets: z
    .array(z.object({ upTo: z.coerce.number().positive().nullable(), rate: z.coerce.number().min(0).max(100) }))
    .min(1)
    .max(20),
  note: z.string().trim().max(500).optional(),
});

export const adminPayrollYears = {
  list: catchAsync(async (_req: Request, res: Response) => {
    const rows = await PayrollYear.find().sort({ year: -1 }).lean();
    const used = await BizPayrun.aggregate([{ $group: { _id: "$year", runs: { $sum: 1 } } }]);
    const runs = new Map(used.map((u) => [u._id, u.runs]));
    res.status(200).json({ message: "payrollYears", data: rows.map((r) => ({ ...r, runs: runs.get(r.year) || 0 })) });
  }),

  save: catchAsync(async (req: Request, res: Response) => {
    const year = Number(req.params.year);
    const parsed = yearBody.safeParse(req.body || {});
    if (!Number.isInteger(year) || year < 1400 || year > 1500 || !parsed.success)
      throw new AppError("همه‌ی ارقام سال را وارد کنید؛ پله‌های مالیات باید صعودی باشند و آخرین پله بدون سقف", 400);
    const b = parsed.data.brackets;
    const ups = b.map((x) => x.upTo);
    const last = ups[ups.length - 1];
    const finite = ups.slice(0, -1);
    if (
      last !== null ||
      finite.some((u) => u === null) ||
      finite.some((u, i) => (i === 0 ? (u as number) <= parsed.data.taxExemption : (u as number) <= (finite[i - 1] as number)))
    )
      throw new AppError("همه‌ی ارقام سال را وارد کنید؛ پله‌های مالیات باید صعودی باشند و آخرین پله بدون سقف", 400);
    const row = await PayrollYear.findOneAndUpdate(
      { year },
      { $set: { ...parsed.data, year } },
      { upsert: true, new: true, runValidators: true },
    ).lean();
    res.status(200).json({ message: "payrollYearSaved", data: row });
  }),

  remove: catchAsync(async (req: Request, res: Response) => {
    const year = Number(req.params.year);
    if (await BizPayrun.exists({ year }))
      throw new AppError("لیست حقوق این سال ساخته شده و قوانینش حذف نمی‌شود؛ فقط ویرایش کنید", 400);
    await PayrollYear.deleteOne({ year });
    res.status(200).json({ message: "payrollYearDeleted" });
  }),
};
