import { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import { BIZ_FILE_RE, bizFilePrefix } from "./uploadController";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import { BizOwner } from "../Lib/business/coa";
import { currentLocale } from "../Lib/i18n/requestContext";
import { speechToTextEnabled, transcribe } from "../Services/speechToText";
import {
  booksCopilot,
  cashForecast,
  categorize,
  entryDraft,
  financeAiStatus,
  financeAnomalies,
  financeInsight,
  finAiSubject,
  FinAiCtx,
  insightKinds,
  journalDraft,
  parseStatement,
  payslipAssistant,
  receiptDraft,
  reclassifyExpense,
  rememberChoice,
  uncategorizedExpenses,
} from "../Lib/business/financeAi";
import { OwnerOf } from "./businessController";
import { audioMinutes, consumeAiFor, refundAi } from "../Lib/ai/aiGate";

// The finance assistant's API (2026-10, Lib/business/financeAi.ts), under
// /<panel>/biz/finance/ai with the suite's own access: reading needs the
// panel's readFinance, a draft its manageAccounting, and the plan's
// "accounting" module opens both (Routers/businessRoutes.ts). Nothing here
// posts to the books except reclassify, which the user confirms row by row.

const withCtx = (ownerOf: OwnerOf, fn: (ctx: FinAiCtx, req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const owner = ownerOf(req) as BizOwner | null;
    if (!owner || owner.kind === "platform") return next(new NotFoundError());
    await fn({ owner, user: req.user?._id, locale: currentLocale() }, req, res);
  });

const ok = (res: Response, message: string, data: unknown, status = 200) => res.status(status).json({ message, data });

const parse = <T extends z.ZodTypeAny>(schema: T, v: unknown, message?: string): z.infer<T> => {
  const r = schema.safeParse(v ?? {});
  if (!r.success) throw message ? new AppError(message, 400) : new BadInputError();
  return r.data;
};

// a voice note, kept in memory only (as the visit scribe)
export const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /^audio\//.test(file.mimetype) || file.mimetype === "video/webm"),
}).single("audio");

const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", pdf: "application/pdf" };

export const makeFinanceAiController = (ownerOf: OwnerOf) => ({
  status: withCtx(ownerOf, async (ctx, req, res) => {
    const data = await financeAiStatus(ctx);
    // only the super admin can open system settings -> AI
    const isAdmin = (req.user as { role?: string } | undefined)?.role === "admin";
    ok(res, "finAiStatus", { ...data, settingsUrl: isAdmin ? `/${process.env.ADMIN_KEY || "notadmin"}/appConfig?tab=ai` : null });
  }),

  // multipart "file" (saved by the upload middleware as the attachment) or
  // JSON { text, attachment } when the model cannot read images
  receipt: withCtx(ownerOf, async (ctx, req, res) => {
    const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
    const f = files[0];
    const saved = typeof req.body?.file === "string" ? req.body.file : undefined;
    // a file of this panel's only (uploadController.savePrivateBizFiles)
    const own = typeof req.body?.attachment === "string" && BIZ_FILE_RE.test(req.body.attachment) && req.body.attachment.startsWith(bizFilePrefix(ctx.owner));
    const attachment = saved || (own ? req.body.attachment : undefined);
    const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 6000) : undefined;
    if (!f && !text) throw new AppError("فایل را انتخاب کنید", 400);
    const ext = (saved || "").split(".").pop() || "";
    const data = await receiptDraft(ctx, {
      file: f && !text ? { buffer: f.buffer, mime: MIME[ext] || f.mimetype } : undefined,
      attachment,
      text,
    });
    ok(res, "finAiReceipt", data);
  }),

  journal: withCtx(ownerOf, async (ctx, req, res) => {
    const b = parse(z.object({ description: z.string().trim().min(3).max(1000) }), req.body, "شرح رویداد را بنویسید");
    ok(res, "finAiJournal", await journalDraft(ctx, b.description));
  }),

  entry: withCtx(ownerOf, async (ctx, req, res) => {
    const b = parse(z.object({ text: z.string().trim().min(3).max(600) }), req.body, "جمله را بنویسید");
    ok(res, "finAiEntry", await entryDraft(ctx, b.text));
  }),

  transcribe: withCtx(ownerOf, async (ctx, req, res) => {
    if (!(await speechToTextEnabled())) throw new AppError("تبدیل گفتار به متن روی این سرور فعال نیست", 503);
    if (!req.file?.buffer?.length) throw new AppError("فایل صوتی ارسال نشده است", 400);
    // the AI policy, in minutes of audio (Lib/ai/aiGate.ts)
    const ticket = await consumeAiFor(finAiSubject(ctx), "finance.voice", audioMinutes(req));
    try {
      const text = await transcribe(req.file.buffer, req.file.mimetype, req.file.originalname || "note.webm");
      ok(res, "finAiTranscribe", { text });
    } catch (err) {
      await refundAi(ticket);
      console.log("[financeAi] transcription failed:", (err as Error)?.message);
      throw new AppError("تبدیل صدا به متن انجام نشد؛ دوباره تلاش کنید", 502);
    }
  }),

  copilot: withCtx(ownerOf, async (ctx, req, res) => {
    const b = parse(
      z.object({
        question: z.string().trim().min(2).max(600),
        history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) })).max(20).optional(),
      }),
      req.body,
      "سؤالتان را بنویسید",
    );
    ok(res, "finAiCopilot", await booksCopilot(ctx, b.question, b.history || []));
  }),

  insight: withCtx(ownerOf, async (ctx, req, res) => {
    const b = parse(z.object({ kind: z.enum(insightKinds), fresh: z.boolean().optional() }), req.body);
    ok(res, "finAiInsight", await financeInsight(ctx, b.kind, !!b.fresh));
  }),

  forecast: withCtx(ownerOf, async (ctx, _req, res) => ok(res, "finAiForecast", await cashForecast(ctx.owner))),
  anomalies: withCtx(ownerOf, async (ctx, _req, res) => ok(res, "finAiAnomalies", await financeAnomalies(ctx.owner))),

  // bank statement lines: pasted CSV text or rows already split
  categorize: withCtx(ownerOf, async (ctx, req, res) => {
    const b = parse(
      z.object({
        csv: z.string().max(400_000).optional(),
        lines: z
          .array(z.object({ id: z.string().max(40), date: z.string().max(20).optional(), amount: z.coerce.number().min(0).max(1e13), direction: z.enum(["in", "out"]), description: z.string().max(300) }))
          .max(200)
          .optional(),
        money: z.string().optional(),
        ai: z.boolean().optional(),
      }),
      req.body,
    );
    const lines = b.lines?.length ? b.lines : parseStatement(b.csv || "");
    if (!lines.length) throw new AppError("ردیفی در صورت‌حساب پیدا نشد", 400);
    ok(res, "finAiCategorize", { lines, suggestions: await categorize(ctx, lines, { money: b.money, useAi: b.ai !== false }) });
  }),

  uncategorized: withCtx(ownerOf, async (ctx, req, res) => {
    const b = parse(z.object({ ai: z.boolean().optional() }), req.body);
    ok(res, "finAiUncategorized", await uncategorizedExpenses(ctx, b.ai !== false));
  }),

  reclassify: withCtx(ownerOf, async (ctx, req, res) => {
    const b = parse(z.object({ expense: z.string(), account: z.string() }), req.body, "نوع هزینه را انتخاب کنید");
    ok(res, "finAiReclassify", await reclassifyExpense(ctx, b.expense, b.account, req.user?._id));
  }),

  // a confirmed suggestion (a posted draft), remembered for next time
  learn: withCtx(ownerOf, async (ctx, req, res) => {
    const b = parse(z.object({ text: z.string().trim().min(2).max(300), account: z.string(), center: z.string().optional() }), req.body);
    ok(res, "finAiLearn", await rememberChoice(ctx.owner, b.text, b.account, b.center));
  }),

  payslip: withCtx(ownerOf, async (ctx, req, res) => {
    const b = parse(z.object({ run: z.string(), employee: z.string() }), req.body);
    ok(res, "finAiPayslip", await payslipAssistant(ctx, b.run, b.employee));
  }),
});
