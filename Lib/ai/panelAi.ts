// AI in the provider panels (2026-10): the copilot «دستیار نویان», voice
// prescription, chat reply suggestions, patient summaries, CRM texts and
// call analysis. Everything here may touch patient data, so every feature
// runs on the CLINICAL provider of Lib/aiSettings.ts (the in-country Ollama
// server unless the super admin picked the cloud one for it).
//
// Shared rules, enforced by `panelAiGate` before any model is called:
//   - the panel (doctor, clinic, ...) and the org come from useAcl(), so a
//     secretary works with the org's data and her own ACL;
//   - licence: a doctor's plan needs the "aiAssistant" module (the AI scribe
//     module since 2026-10); an organisation's plan needs "crm", i.e. any
//     paid tier (Pro / Premium) - the free tier has no AI;
//   - the provider must be configured (System settings -> AI);
//   - a per-user daily safety limit (AppConfig.panelAiDailyLimit, 0 = none)
//     counted in PanelAiUsage, split by feature.
// Every output is a draft or a suggestion: nothing is saved or sent by the
// AI itself.
import { NextFunction, Request, RequestHandler, Response } from "express";
import mongoose from "mongoose";
import AppError, { AccessError, MiddlewareError, PathNotFoundError } from "../AppError";
import { nodesWithAcl, NodeWithAcl } from "../enums";
import { aiComplete, getAiSettings } from "../aiSettings";
import { getAppConfig } from "../appConfig";
import PanelAiUsage from "../../Models/PanelAiUsage";
import * as doctorController from "../../Controllers/doctorController";
import * as clinicController from "../../Controllers/clinicController";
import * as hospitalController from "../../Controllers/hospitalController";
import * as pharmacyController from "../../Controllers/pharmacyController";
import * as paraClinicController from "../../Controllers/paraClinicController";
import * as insuranceController from "../../Controllers/InsuracneController";

export type PanelName = NodeWithAcl;

export const NOT_CONFIGURED = "دستیار هوش مصنوعی روی این سرور فعال نیست";
export const STT_NOT_CONFIGURED = "تبدیل گفتار به متن روی این سرور فعال نیست";
export const NOT_IN_PLAN = "دستیار هوش مصنوعی در پلن شما نیست؛ برای استفاده پلن را ارتقا دهید";
export const LIMIT_REACHED = "سقف روزانه‌ی درخواست‌های هوش مصنوعی شما پر شده است؛ فردا دوباره تلاش کنید";
export const OWNER_ONLY = "فقط صاحب حساب به داده‌ی بالینی بیماران دسترسی دارد";
export const AI_FAILED = "دستیار نتوانست پاسخ بدهد؛ دوباره تلاش کنید";

// the plan module that opens panel AI
export const PLAN_MODULE: Record<PanelName, string> = {
  doctor: "aiAssistant",
  clinic: "crm",
  hospital: "crm",
  pharmacy: "crm",
  paraClinic: "crm",
  insurance: "crm",
};

type Gate = (mod: never) => RequestHandler;
const gates: Record<PanelName, Gate> = {
  doctor: doctorController.requireLicenseModule as Gate,
  clinic: clinicController.requireLicenseModule as Gate,
  hospital: hospitalController.requireLicenseModule as Gate,
  pharmacy: pharmacyController.requireLicenseModule as Gate,
  paraClinic: paraClinicController.requireLicenseModule as Gate,
  insurance: insuranceController.requireLicenseModule as Gate,
};

export const panelOf = (req: Request): PanelName | undefined =>
  nodesWithAcl.find((n) => n === req.params.name);

// the org document useAcl() put on the request
export const orgOf = (req: Request): { _id: mongoose.Types.ObjectId; user?: unknown } | undefined => {
  const name = panelOf(req);
  return name ? ((req as unknown as Record<string, unknown>)[name] as never) : undefined;
};

export const isOwner = (req: Request) => req.aclGrant === "FULL";
export const can = (req: Request, action: string) =>
  req.aclGrant === "FULL" || !!(req.aclGrant as Record<string, unknown> | null)?.[action];

// runs the org's own licence middleware and reports whether it let through
export const hasPlanModule = (req: Request, res: Response, mod: string): Promise<boolean> => {
  const name = panelOf(req);
  if (!name) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      gates[name](mod as never)(req, res, ((err?: unknown) => resolve(!err)) as NextFunction);
    } catch {
      resolve(false);
    }
  });
};

export const tehranDay = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export const dailyLimit = async () => {
  const c = await getAppConfig();
  const v = Number((c as { panelAiDailyLimit?: number }).panelAiDailyLimit);
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : 200;
};

export const usedToday = async (userId: unknown) => {
  const row = await PanelAiUsage.findOne({ user: userId, day: tehranDay() }).select("count").lean<{ count?: number }>();
  return row?.count || 0;
};

// counts one request; false when the day's limit is reached
export const consumeAi = async (userId: unknown, feature: string): Promise<boolean> => {
  const limit = await dailyLimit();
  const day = tehranDay();
  const inc = { $inc: { count: 1, [`features.${feature}`]: 1 }, $setOnInsert: { createdAt: new Date() } };
  if (!limit) {
    await PanelAiUsage.updateOne({ user: userId, day }, inc, { upsert: true });
    return true;
  }
  try {
    const row = await PanelAiUsage.findOneAndUpdate({ user: userId, day, count: { $lt: limit } }, inc, {
      upsert: true,
      new: true,
    });
    return !!row;
  } catch (err) {
    // the day's row exists and is full: the upsert hits the unique index
    if ((err as { code?: number })?.code === 11000) return false;
    throw err;
  }
};

export type PanelAiFeature =
  | "copilot"
  | "transcribe"
  | "rx"
  | "chat"
  | "summary"
  | "crmText"
  | "crmPlan"
  | "contactInsight"
  | "call";

// What a panel page needs to know to show or hide its AI buttons.
export const panelAiStatus = async (req: Request, res: Response) => {
  const name = panelOf(req)!;
  const [settings, inPlan, limit, used] = await Promise.all([
    getAiSettings(),
    hasPlanModule(req, res, PLAN_MODULE[name]),
    dailyLimit(),
    usedToday(req.user?._id),
  ]);
  return {
    panel: name,
    inPlan,
    planModule: PLAN_MODULE[name],
    configured: !!settings.clinical,
    stt: !!settings.stt,
    owner: isOwner(req),
    limit,
    used,
    // the actions the AI tools touch, so the UI hides what the ACL forbids
    acl: {
      crm: can(req, "readCrm"),
      crmWrite: can(req, "manageCrm"),
      finance: can(req, "readFinance"),
      financeWrite: can(req, "manageAccounting"),
      chat: name === "doctor" && can(req, "readChat"),
      schedule: name === "doctor" && can(req, "readSchedule"),
      calendar: name === "doctor" && can(req, "mutateCalendar"),
      patients: name === "doctor" && can(req, "readPatients"),
    },
  };
};

// Middleware: panel + licence + provider + daily limit, then counts the
// request. `needs` adds an ACL action, "owner" for clinical data, or "stt".
export const panelAiGate = (
  feature: PanelAiFeature,
  { needs, stt, doctorOnly }: { needs?: string | "owner"; stt?: boolean; doctorOnly?: boolean } = {},
): RequestHandler => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = panelOf(req);
    if (!name) return next(new PathNotFoundError());
    if (!req.user || !orgOf(req)) return next(new MiddlewareError());
    if (doctorOnly && name !== "doctor") return next(new PathNotFoundError());
    if (needs === "owner" && !isOwner(req)) return next(new AppError(OWNER_ONLY, 403));
    if (needs && needs !== "owner" && !can(req, needs)) return next(new AccessError());
    if (!(await hasPlanModule(req, res, PLAN_MODULE[name]))) return next(new AppError(NOT_IN_PLAN, 403));
    const settings = await getAiSettings();
    if (stt ? !settings.stt : !settings.clinical)
      return next(new AppError(stt ? STT_NOT_CONFIGURED : NOT_CONFIGURED, 503));
    if (!(await consumeAi(req.user._id, feature))) return next(new AppError(LIMIT_REACHED, 429));
    next();
  } catch (err) {
    next(err);
  }
};

// ---------------- model calls ----------------

export const SAFETY = `You support licensed healthcare staff in Iran inside the NoyanAI practice software.
You never make a clinical decision and never invent facts that are not in the input.
Reply with JSON only, no markdown fences.`;

// the reply's JSON object (fences and stray text around it dropped)
export const parseJsonObject = (reply: string): Record<string, unknown> => {
  let s = reply.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b <= a) throw new Error("No JSON object in reply");
  s = s.slice(a, b + 1);
  const parsed = JSON.parse(s);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Reply is not an object");
  return parsed as Record<string, unknown>;
};

export const clinicalJson = async (
  system: string,
  user: string,
  { maxTokens = 2000, timeoutMs = 90_000 }: { maxTokens?: number; timeoutMs?: number } = {},
) => {
  const p = (await getAiSettings()).clinical;
  if (!p) throw new AppError(NOT_CONFIGURED, 503);
  const reply = await aiComplete(p, user, { system, json: true, maxTokens, timeoutMs });
  return parseJsonObject(reply);
};

export const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const strList = (v: unknown, max: number, count: number) =>
  Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, count) : [];

// Persian / Arabic digits -> ASCII, and a number out of a model's reply
export const asciiDigits = (s: string) =>
  s.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
export const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(asciiDigits(v).replace(/[^\d.]/g, ""));
  return v.trim() && Number.isFinite(n) ? n : null;
};

// a model failure the user can retry; configuration / limit errors pass through
export const aiFailure = (err: unknown) =>
  err instanceof AppError ? err : new AppError(AI_FAILED, 502);
