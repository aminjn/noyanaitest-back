import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { isValidObjectId } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import { BizOwner, displayName } from "../Lib/business/coa";
import { currentLocale } from "../Lib/i18n/requestContext";
import { bizInsurerKinds } from "../Models/BizInvoice";
import { bizChequeStatuses, bizPayMethods } from "../Models/BizPayment";
import { createMoneyAccount, listMoneyAccounts, moneyAccountLines, reconcile, updateMoneyAccount } from "../Lib/business/finance";
import {
  createInvoice,
  deleteDraft,
  getInvoice,
  invoiceLink,
  issueInvoice,
  listInvoices,
  publicInvoice,
  sendInvoiceToMoadian,
  smsInvoice,
  updateInvoice,
  voidInvoice,
} from "../Lib/business/invoices";
import { createPayment, listCheques, listPayments, setChequeStatus, voidPayment } from "../Lib/business/payments";
import { createExpense, expenseAccounts, listExpenses, setRecurringActive, voidExpense } from "../Lib/business/expenses";
import { claimCandidates, createClaim, deductClaim, deleteClaim, getClaim, listClaims, reopenClaim, submitClaim, updateClaim } from "../Lib/business/claims";
import { agingReport, financeOverview, incomeBreakdown } from "../Lib/business/financeReports";
import { decideReceived, getReceived, listReceived, noyanInsurers, payReceived, saveDecisions } from "../Lib/business/insurerClaims";
import { bizClaimLineDecisions } from "../Models/BizClaim";
import { OwnerOf } from "./businessController";

// The practice-finance API (2026-10, «مالی و حسابداری» in every provider
// panel), mounted under /<panel>/biz/finance by Routers/businessRoutes.ts so
// it shares the accounting routes' access: reading needs readFinance,
// writing manageAccounting, and the plan's "accounting" module opens it.

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const startOf = (s?: string | null) => (s ? new Date(`${s}T00:00:00`) : null);
const endOf = (s?: string | null) => (s ? new Date(`${s}T23:59:59.999`) : null);
// a document's own date: today keeps the time it was written
const docDate = (s?: string | null) => {
  if (!s) return new Date();
  const d = new Date(`${s}T12:00:00`);
  const now = new Date();
  return d.toDateString() === now.toDateString() ? now : d;
};
const range = z.object({ from: day.optional(), to: day.optional() });
const paging = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) });
const id = (v: unknown) => {
  if (!isValidObjectId(v)) throw new NotFoundError();
  return String(v);
};
const money = z.coerce.number().min(0).max(1e13);

const withOwner = (ownerOf: OwnerOf, fn: (owner: BizOwner, req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const owner = ownerOf(req);
    if (!owner || owner.kind === "platform") return next(new NotFoundError());
    await fn(owner, req, res);
  });

const parse = <T extends z.ZodTypeAny>(schema: T, v: unknown, message?: string): z.infer<T> => {
  const r = schema.safeParse(v ?? {});
  if (!r.success) throw message ? new AppError(message, 400) : new BadInputError();
  return r.data;
};

const ok = (res: Response, message: string, data: unknown, status = 200) => res.status(status).json({ message, data });

// an account's name in the reader's language (system accounts)
const named = <T extends { name?: string; code?: string; role?: string } | null | undefined>(a: T) =>
  a && a.name ? { ...a, name: displayName({ name: a.name, code: a.code || "", role: a.role }, currentLocale()) } : a;

const invoiceBody = z.object({
  date: day.optional(),
  dueDate: day.nullable().optional(),
  party: z.object({ name: z.string().trim().max(200).default(""), phone: z.string().max(30).optional(), nationalId: z.string().max(20).optional() }),
  doctorName: z.string().max(200).optional(),
  lines: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        qty: z.coerce.number().min(0).max(100000).default(1),
        unitPrice: money,
        discount: money.default(0),
        taxRate: z.coerce.number().min(0).max(100).default(0),
        account: z.string().optional(),
        // a stock item sold on this line (Lib/business/invoices.ts)
        item: z.string().optional(),
      }),
    )
    .min(1)
    .max(100),
  insurer: z.object({ kind: z.enum(bizInsurerKinds), name: z.string().trim().min(1).max(120), share: money }).nullable().optional(),
  note: z.string().max(1000).optional(),
  center: z.string().optional(),
  issue: z.boolean().optional(),
});

const toInvoiceInput = (b: z.infer<typeof invoiceBody>) => ({
  ...b,
  date: docDate(b.date),
  dueDate: b.dueDate ? startOf(b.dueDate) : null,
});

const paymentBody = z.object({
  direction: z.enum(["in", "out"]),
  date: day.optional(),
  amount: money,
  method: z.enum(bizPayMethods),
  money: z.string().optional(),
  against: z.enum(["invoice", "claim", "expense", "account"]),
  invoice: z.string().optional(),
  claim: z.string().optional(),
  expense: z.string().optional(),
  account: z.string().optional(),
  party: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  reference: z.string().max(80).optional(),
  center: z.string().optional(),
  cheque: z
    .object({
      number: z.string().trim().min(1).max(40),
      bank: z.string().trim().min(1).max(80),
      branch: z.string().max(80).optional(),
      sayad: z.string().max(20).optional(),
      dueDate: day,
      // (2026-10) the leaf of a chequebook it is written on (it was dropped here)
      checkbook: z.string().max(30).optional(),
    })
    .optional(),
});

const expenseBody = z.object({
  date: day.optional(),
  dueDate: day.nullable().optional(),
  account: z.string(),
  vendor: z.string().max(200).optional(),
  supplier: z.string().optional(),
  description: z.string().max(500).optional(),
  amount: money,
  tax: money.default(0),
  center: z.string().optional(),
  attachment: z.string().max(300).optional(),
  payFrom: z.string().optional(),
  method: z.enum(["cash", "card", "transfer", "wallet"]).optional(),
  recurring: z.object({ interval: z.enum(["monthly", "quarterly", "yearly"]), until: day.nullable().optional() }).nullable().optional(),
});

const claimBody = z.object({
  insurer: z.object({ kind: z.enum(bizInsurerKinds), name: z.string().trim().max(120) }),
  from: day.nullable().optional(),
  to: day.nullable().optional(),
  invoices: z.array(z.string()).max(1000).optional(),
  items: z
    .array(z.object({ date: day, patient: z.string().max(200).default(""), service: z.string().max(300).default(""), total: money.default(0), share: money }))
    .max(1000)
    .optional(),
  note: z.string().max(1000).optional(),
  // (2026-10) the insurer's Noyan profile, when it reviews the list on Noyan
  insurerProfile: z.string().max(30).nullable().optional(),
});

const toClaimInput = (b: z.infer<typeof claimBody>) => ({
  ...b,
  from: startOf(b.from),
  to: endOf(b.to),
  items: (b.items || []).map((i) => ({ ...i, date: docDate(i.date) })),
});

export const makeFinanceController = (ownerOf: OwnerOf) => ({
  // ------------------------------------------------------------ overview
  overview: withOwner(ownerOf, async (owner, _req, res) => ok(res, "finOverview", await financeOverview(owner))),

  // ------------------------------------------------------------ invoices
  listInvoices: withOwner(ownerOf, async (owner, req, res) => {
    const q = parse(range.merge(paging).extend({ status: z.string().max(20).optional(), origin: z.enum(["platform", "manual"]).optional(), q: z.string().max(100).optional() }), req.query);
    ok(res, "finInvoices", await listInvoices(owner, { ...q, from: startOf(q.from), to: endOf(q.to), search: q.q }));
  }),
  getInvoice: withOwner(ownerOf, async (owner, req, res) => {
    const inv = await getInvoice(owner, id(req.params.invoiceId));
    ok(res, "finInvoice", { ...inv, lines: inv.lines.map((l) => ({ ...l, account: named(l.account as any) })), link: await invoiceLink(inv) });
  }),
  createInvoice: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(invoiceBody, req.body, "نام بیمار و دست‌کم یک ردیف با مبلغ را وارد کنید");
    ok(res, "finCreateInvoice", await createInvoice(owner, toInvoiceInput(b), !!b.issue, req.user?._id), 201);
  }),
  updateInvoice: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(invoiceBody, req.body, "نام بیمار و دست‌کم یک ردیف با مبلغ را وارد کنید");
    const inv = await updateInvoice(owner, id(req.params.invoiceId), toInvoiceInput(b));
    ok(res, "finUpdateInvoice", b.issue ? await issueInvoice(owner, String(inv._id), req.user?._id) : inv);
  }),
  deleteInvoice: withOwner(ownerOf, async (owner, req, res) => {
    await deleteDraft(owner, id(req.params.invoiceId));
    ok(res, "finDeleteInvoice", null);
  }),
  issueInvoice: withOwner(ownerOf, async (owner, req, res) => ok(res, "finIssueInvoice", await issueInvoice(owner, id(req.params.invoiceId), req.user?._id))),
  voidInvoice: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(z.object({ reason: z.string().trim().min(2).max(500) }), req.body, "دلیل ابطال را بنویسید");
    ok(res, "finVoidInvoice", await voidInvoice(owner, id(req.params.invoiceId), b.reason));
  }),
  smsInvoice: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(z.object({ phone: z.string().max(30).optional() }), req.body);
    ok(res, "finSmsInvoice", await smsInvoice(owner, id(req.params.invoiceId), b.phone));
  }),
  moadianInvoice: withOwner(ownerOf, async (owner, req, res) => ok(res, "finMoadianInvoice", await sendInvoiceToMoadian(owner, id(req.params.invoiceId)))),

  // ----------------------------------------------- receipts and payments
  listPayments: withOwner(ownerOf, async (owner, req, res) => {
    const q = parse(range.merge(paging).extend({ direction: z.enum(["in", "out"]).optional(), method: z.enum(bizPayMethods).optional(), q: z.string().max(100).optional() }), req.query);
    const data = await listPayments(owner, { ...q, from: startOf(q.from), to: endOf(q.to), search: q.q });
    ok(res, "finPayments", { ...data, items: data.items.map((p: any) => ({ ...p, account: named(p.account) })) });
  }),
  createPayment: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(paymentBody, req.body, "مبلغ، روش و صندوق یا حساب بانکی را وارد کنید");
    ok(
      res,
      "finCreatePayment",
      await createPayment(owner, { ...b, date: docDate(b.date), cheque: b.cheque ? { ...b.cheque, dueDate: startOf(b.cheque.dueDate)! } : undefined }, req.user?._id),
      201,
    );
  }),
  voidPayment: withOwner(ownerOf, async (owner, req, res) => ok(res, "finVoidPayment", await voidPayment(owner, id(req.params.paymentId)))),
  listCheques: withOwner(ownerOf, async (owner, req, res) => {
    const q = parse(z.object({ direction: z.enum(["in", "out"]).optional(), status: z.enum(bizChequeStatuses).optional() }), req.query);
    ok(res, "finCheques", await listCheques(owner, q));
  }),
  chequeStatus: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(z.object({ status: z.enum(bizChequeStatuses), money: z.string().optional(), date: day.optional(), note: z.string().max(300).optional() }), req.body);
    ok(res, "finChequeStatus", await setChequeStatus(owner, id(req.params.paymentId), { ...b, date: b.date ? docDate(b.date) : undefined }, req.user?._id));
  }),

  // ------------------------------------------------ tills and bank accounts
  listMoney: withOwner(ownerOf, async (owner, _req, res) => {
    const rows = await listMoneyAccounts(owner);
    ok(res, "finMoney", rows.map((r) => ({ ...r, name: r.role ? displayName({ name: r.name, code: r.code, role: r.role }, currentLocale()) : r.name })));
  }),
  createMoney: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(
      z.object({ kind: z.enum(["cash", "bank", "pos"]), name: z.string().trim().min(2).max(120), bankName: z.string().max(80).optional(), accountNumber: z.string().max(40).optional(), sheba: z.string().max(34).optional() }),
      req.body,
      "نام حساب را بنویسید",
    );
    ok(res, "finCreateMoney", await createMoneyAccount(owner, b), 201);
  }),
  updateMoney: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(
      z.object({ name: z.string().trim().min(2).max(120).optional(), bankName: z.string().max(80).optional(), accountNumber: z.string().max(40).optional(), sheba: z.string().max(34).optional(), isActive: z.boolean().optional() }),
      req.body,
    );
    ok(res, "finUpdateMoney", await updateMoneyAccount(owner, id(req.params.moneyId), b));
  }),
  moneyLines: withOwner(ownerOf, async (owner, req, res) => {
    const q = parse(range, req.query);
    ok(res, "finMoneyLines", await moneyAccountLines(owner, id(req.params.moneyId), startOf(q.from), endOf(q.to)));
  }),
  reconcile: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(z.object({ vouchers: z.array(z.string()).max(500), cleared: z.boolean(), statementBalance: z.coerce.number().optional(), statementDate: day.optional() }), req.body);
    ok(res, "finReconcile", await reconcile(owner, id(req.params.moneyId), { ...b, statementDate: b.statementDate ? endOf(b.statementDate)! : undefined }));
  }),

  // ------------------------------------------------------------ expenses
  expenseAccounts: withOwner(ownerOf, async (owner, _req, res) => ok(res, "finExpenseAccounts", (await expenseAccounts(owner)).map(named))),
  listExpenses: withOwner(ownerOf, async (owner, req, res) => {
    const q = parse(range.merge(paging).extend({ account: z.string().optional(), status: z.enum(["unpaid", "paid", "recurring"]).optional(), q: z.string().max(100).optional() }), req.query);
    const data = await listExpenses(owner, { ...q, from: startOf(q.from), to: endOf(q.to), search: q.q });
    ok(res, "finExpenses", {
      ...data,
      items: data.items.map((e: any) => ({ ...e, account: named(e.account) })),
      byAccount: data.byAccount.map((b) => ({ ...b, name: displayName({ name: b.name, code: b.code, role: b.role }, currentLocale()) })),
    });
  }),
  createExpense: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(expenseBody, req.body, "نوع هزینه و مبلغ را وارد کنید");
    ok(
      res,
      "finCreateExpense",
      await createExpense(owner, { ...b, date: docDate(b.date), dueDate: b.dueDate ? startOf(b.dueDate) : null, recurring: b.recurring ? { interval: b.recurring.interval, until: endOf(b.recurring.until) } : null }, req.user?._id),
      201,
    );
  }),
  voidExpense: withOwner(ownerOf, async (owner, req, res) => ok(res, "finVoidExpense", await voidExpense(owner, id(req.params.expenseId)))),
  recurringActive: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(z.object({ isActive: z.boolean() }), req.body);
    ok(res, "finRecurring", await setRecurringActive(owner, id(req.params.expenseId), b.isActive));
  }),
  // the receipt's photo: saved by the upload middleware, its name returned
  upload: catchAsync(async (req: Request, res: Response) => {
    const file = (req.body || {}).file;
    if (!file || typeof file !== "string") throw new AppError("فایل را انتخاب کنید", 400);
    ok(res, "finUpload", { file });
  }),

  // ----------------------------------------------------- insurance claims
  listClaims: withOwner(ownerOf, async (owner, req, res) => {
    const q = parse(z.object({ status: z.string().max(20).optional(), kind: z.enum(bizInsurerKinds).optional() }), req.query);
    ok(res, "finClaims", await listClaims(owner, q));
  }),
  claimCandidates: withOwner(ownerOf, async (owner, req, res) => {
    const q = parse(range.extend({ kind: z.enum(bizInsurerKinds).optional(), name: z.string().max(120).optional() }), req.query);
    ok(res, "finClaimCandidates", await claimCandidates(owner, { ...q, from: startOf(q.from), to: endOf(q.to) }));
  }),
  getClaim: withOwner(ownerOf, async (owner, req, res) => ok(res, "finClaim", await getClaim(owner, id(req.params.claimId)))),
  createClaim: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(claimBody, req.body, "بیمه و دست‌کم یک ردیف را وارد کنید");
    ok(res, "finCreateClaim", await createClaim(owner, toClaimInput(b), req.user?._id), 201);
  }),
  updateClaim: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(claimBody, req.body, "بیمه و دست‌کم یک ردیف را وارد کنید");
    ok(res, "finUpdateClaim", await updateClaim(owner, id(req.params.claimId), toClaimInput(b)));
  }),
  deleteClaim: withOwner(ownerOf, async (owner, req, res) => {
    await deleteClaim(owner, id(req.params.claimId));
    ok(res, "finDeleteClaim", null);
  }),
  submitClaim: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(z.object({ date: day.optional(), trackingCode: z.string().max(80).optional() }), req.body);
    ok(res, "finSubmitClaim", await submitClaim(owner, id(req.params.claimId), { date: b.date ? docDate(b.date) : undefined, trackingCode: b.trackingCode }, req.user?._id));
  }),
  deductClaim: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(z.object({ amount: money.optional(), reason: z.string().trim().min(2).max(500), all: z.boolean().optional(), date: day.optional() }), req.body, "مبلغ و دلیل کسر را بنویسید");
    ok(res, "finDeductClaim", await deductClaim(owner, id(req.params.claimId), { ...b, date: b.date ? docDate(b.date) : undefined }, req.user?._id));
  }),
  reopenClaim: withOwner(ownerOf, async (owner, req, res) => ok(res, "finReopenClaim", await reopenClaim(owner, id(req.params.claimId)))),
  // the insurers a list can be sent to on Noyan
  claimInsurers: withOwner(ownerOf, async (_owner, _req, res) => ok(res, "finClaimInsurers", await noyanInsurers())),

  // --------------------------- the insurer: lists received from centres
  listClaimsIn: withOwner(ownerOf, async (owner, req, res) => {
    const q = parse(z.object({ status: z.string().max(20).optional(), q: z.string().max(100).optional() }), req.query);
    ok(res, "finClaimsIn", await listReceived(owner, q));
  }),
  getClaimIn: withOwner(ownerOf, async (owner, req, res) => ok(res, "finClaimIn", await getReceived(owner, id(req.params.claimId)))),
  saveClaimInLines: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(
      z.object({
        lines: z
          .array(z.object({ index: z.coerce.number().int().min(0).max(5000), status: z.enum(bizClaimLineDecisions), amount: money.optional(), reason: z.string().max(300).optional() }))
          .max(5000),
        note: z.string().max(1000).optional(),
      }),
      req.body,
      "تصمیم ردیف‌ها را درست وارد کنید",
    );
    ok(res, "finClaimInLines", await saveDecisions(owner, id(req.params.claimId), b.lines, b.note));
  }),
  decideClaimIn: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(z.object({ date: day.optional() }), req.body);
    ok(res, "finClaimInDecide", await decideReceived(owner, id(req.params.claimId), { date: b.date ? docDate(b.date) : undefined }, req.user?._id));
  }),
  payClaimIn: withOwner(ownerOf, async (owner, req, res) => {
    const b = parse(
      z.object({ amount: money, money: z.string().max(30), date: day.optional(), reference: z.string().max(80).optional(), key: z.string().max(80).optional() }),
      req.body,
      "مبلغ و حساب پرداخت را مشخص کنید",
    );
    ok(res, "finClaimInPay", await payReceived(owner, id(req.params.claimId), { ...b, date: b.date ? docDate(b.date) : undefined }, req.user?._id));
  }),

  // ------------------------------------------------------------- reports
  breakdown: withOwner(ownerOf, async (owner, req, res) => {
    const q = parse(range, req.query);
    ok(res, "finBreakdown", await incomeBreakdown(owner, startOf(q.from), endOf(q.to)));
  }),
  aging: withOwner(ownerOf, async (owner, _req, res) => ok(res, "finAging", await agingReport(owner))),
});

// GET /public/invoice/:token - the patient's view of an invoice (no sign-in)
export const getPublicInvoice = catchAsync(async (req: Request, res: Response) => {
  const data = await publicInvoice(String(req.params.token || ""));
  if (!data) throw new NotFoundError();
  res.status(200).json({ message: "finPublicInvoice", data });
});
