import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import mongoose, { isValidObjectId } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import BizEmployee from "../Models/BizEmployee";
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
} from "../Lib/business/payroll";
import { OwnerOf } from "./businessController";

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
const dateOf = (s?: string | null) => (s ? new Date(`${s}T12:00:00`) : undefined);

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
});

const employeeData = (b: Partial<z.infer<typeof employeeBody>>) => {
  const { hireDate, endDate, nationalId, iban, ...rest } = b;
  return {
    ...rest,
    ...(nationalId !== undefined ? { nationalId: nationalId || undefined } : {}),
    ...(iban !== undefined ? { iban: iban ? (iban.toUpperCase().startsWith("IR") ? iban.toUpperCase() : `IR${iban}`) : undefined } : {}),
    ...(hireDate !== undefined ? { hireDate: dateOf(hireDate) || null } : {}),
    ...(endDate !== undefined ? { endDate: dateOf(endDate) || null } : {}),
  };
};

export const makePayrollController = (ownerOf: OwnerOf) => ({
  getEmployees: withOwner(ownerOf, async (owner, _req, res) => {
    const rows = await BizEmployee.find(own(owner)).sort({ isActive: -1, name: 1 }).lean();
    res.status(200).json({ message: "payEmployees", data: rows });
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
