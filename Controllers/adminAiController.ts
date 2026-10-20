import { NextFunction, Request, RequestHandler, Response } from "express";
import { kickTranslationWorker } from "../Services/autoTranslate";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError } from "../Lib/AppError";
import AppConfig from "../Models/AppConfig";
import { getAppConfig } from "../Lib/appConfig";
import { AI_DEFAULT_BASE, AI_FEATURES, AiFeature, AiFeatureConfig, aiComplete, getAiSettings } from "../Lib/aiSettings";
import { isMaskedSecret, maskSecret } from "../Lib/secretMask";
import { currentLocale } from "../Lib/i18n/requestContext";
import { translateMessage } from "../Lib/i18n/translateMessage";

// Super admin: the AI providers (system settings -> AI). Keys are
// write-only, like the map key: reads get a masked preview.

const FEATURE_KEYS = AI_FEATURES;

// GET /admin/ai/settings: the one connection and every feature under it
export const getAiSettingsAdmin: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  const c = await getAppConfig();
  const eff = await getAiSettings();
  const saved = (c.aiFeatures || {}) as Record<string, AiFeatureConfig>;
  const running: Record<AiFeature, { model?: string } | undefined> = {
    translation: eff.translation,
    content: eff.content,
    clinical: eff.clinical,
    finance: eff.finance,
    chat: eff.chat,
    stt: eff.stt,
  };
  const features = Object.fromEntries(
    FEATURE_KEYS.map((f) => [
      f,
      {
        enabled: saved[f]?.enabled ?? !!running[f],
        model: saved[f]?.model || "",
        instruction: saved[f]?.instruction || "",
        ...(f === "stt" ? { language: saved.stt?.language || c.sttLanguage || "" } : {}),
        // what actually runs now, and why not when it doesn't
        on: !!running[f],
        runningModel: running[f]?.model || "",
        why: why(eff.missing[f]),
      },
    ]),
  );
  res.status(200).json({
    message: "getAiSettings",
    data: {
      connection: {
        kind: eff.connection.kind,
        url: eff.connection.url,
        keySet: !!c.aiApiKey,
        keyPreview: maskSecret(c.aiApiKey),
        keyFromEnv: !c.aiApiKey && !!process.env.ANTHROPIC_API_KEY,
      },
      features,
      // a separate speech-to-text server, only when the connection has none
      sttUrl: c.sttUrl || "",
      sttKeySet: !!c.sttApiKey,
      sttKeyPreview: maskSecret(c.sttApiKey),
      defaults: AI_DEFAULT_BASE,
    },
  });
});

// what a feature still lacks, in the admin's language
function why(text?: string) {
  return text ? translateMessage(text, currentLocale()) : undefined;
}

const url = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === "" || /^https?:\/\/[^\s]+$/i.test(v));
const featureSchema = z.strictObject({
  enabled: z.boolean().optional(),
  model: z.string().trim().max(120).optional(),
  instruction: z.string().trim().max(4000).optional(),
  language: z.string().trim().max(10).optional(),
});
const settingsSchema = z.strictObject({
  connection: z
    .strictObject({
      kind: z.enum(["anthropic", "openai", "ollama"]),
      url: url.optional(),
      key: z.string().trim().max(500).optional(),
      clearKey: z.boolean().optional(),
    })
    .optional(),
  features: z.record(z.string(), featureSchema).optional(),
  sttUrl: url.optional(),
  sttKey: z.string().trim().max(500).optional(),
  clearSttKey: z.boolean().optional(),
});

// POST /admin/ai/settings: the connection once, then each feature's switch,
// model and instruction
export const saveAiSettings: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const parsed = settingsSchema.safeParse(req.body || {});
  if (!parsed.success) return next(new BadInputError());
  const { connection, features, sttUrl, sttKey, clearSttKey } = parsed.data;
  const c = await getAppConfig();
  const $set: Record<string, unknown> = {};
  if (connection) {
    $set.aiProvider = connection.kind;
    const address = (connection.url || "").replace(/\/+$/, "");
    if (connection.kind === "ollama") $set.ollamaHost = address;
    else $set.aiBaseUrl = address;
    if (connection.clearKey) $set.aiApiKey = "";
    else if (connection.key && !isMaskedSecret(connection.key)) $set.aiApiKey = connection.key;
    // every feature follows the one connection; the old per-feature model
    // names belonged to the old provider, so "automatic" means this one's
    $set.clinicalAiProvider = "";
    $set.translationAiModel = "";
    $set.clinicalAiModel = "";
  }
  if (features) {
    const merged = { ...((c.aiFeatures || {}) as Record<string, AiFeatureConfig>) };
    for (const [f, v] of Object.entries(features))
      if ((AI_FEATURES as readonly string[]).includes(f)) merged[f] = { ...(merged[f] || {}), ...v };
    $set.aiFeatures = merged;
  }
  if (typeof sttUrl === "string") $set.sttUrl = sttUrl.replace(/\/+$/, "");
  if (clearSttKey) $set.sttApiKey = "";
  else if (sttKey && !isMaskedSecret(sttKey)) $set.sttApiKey = sttKey;
  if (Object.keys($set).length) await AppConfig.updateOne({ singleton: "SINGLETON" }, { $set });
  // a provider set just now: the waiting translations start (Services/autoTranslate.ts)
  kickTranslationWorker();
  res.status(200).json({ message: "saveAiSettings" });
});

// POST /admin/ai/models {kind?, url?, key?}: the models the connection
// offers, for each feature's picker. Values typed in the form but not yet
// saved are used; an empty or masked key means the saved one.
export const listAiModels: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const body = z
    .strictObject({ kind: z.enum(["anthropic", "openai", "ollama"]).optional(), url: url.optional(), key: z.string().trim().max(500).optional() })
    .safeParse(req.body || {});
  if (!body.success) return next(new BadInputError());
  const eff = await getAiSettings();
  const c = await getAppConfig();
  const kind = body.data.kind || eff.connection.kind;
  const typedKey = body.data.key && !isMaskedSecret(body.data.key) ? body.data.key : "";
  const key = typedKey || c.aiApiKey || (kind === "anthropic" ? process.env.ANTHROPIC_API_KEY || "" : "");
  const address = (body.data.url || (kind === eff.connection.kind ? eff.connection.url : "") || (kind === "ollama" ? "" : AI_DEFAULT_BASE[kind])).replace(/\/+$/, "");
  const started = Date.now();
  try {
    if (!address) throw new Error("آدرس اتصال وارد نشده است");
    let models: string[] = [];
    if (kind === "ollama") {
      const r = await fetch(`${address}/api/tags`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`Ollama ${r.status}`);
      const data = (await r.json()) as { models?: { name?: string }[] };
      models = (data.models || []).map((m) => String(m.name || "")).filter(Boolean);
    } else {
      if (!key) throw new Error("کلید API سرویس ابری وارد نشده است");
      const r = await fetch(kind === "anthropic" ? `${address}/v1/models?limit=100` : `${address}/models`, {
        headers: kind === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`${kind === "anthropic" ? "Anthropic" : "API"} ${r.status}`);
      const data = (await r.json()) as { data?: { id?: string }[] };
      models = (data.data || []).map((m) => String(m.id || "")).filter(Boolean);
    }
    models.sort((a, b) => a.localeCompare(b));
    res.status(200).json({ message: "listAiModels", data: { ok: true, models, latencyMs: Date.now() - started } });
  } catch (err) {
    res.status(200).json({ message: "listAiModels", data: { ok: false, error: errorText(err), models: [] } });
  }
});

// "fetch failed" / a timeout: the server never answered
const UNREACHABLE = "سرور در دسترس نیست؛ آدرس و دسترسی شبکه‌ی سرور را بررسی کنید";
const errorText = (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const unreachable = /fetch failed|timeout|aborted|ECONNREFUSED|ENOTFOUND/i.test(message);
  return translateMessage(unreachable ? UNREACHABLE : message, currentLocale());
};

// POST /admin/ai/test {feature}: one small real call with the saved
// settings for that feature
export const testAiConnection: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const feature = String(req.body?.feature || "") as AiFeature;
  if (!(AI_FEATURES as readonly string[]).includes(feature)) return next(new BadInputError());
  const eff = await getAiSettings();
  const started = Date.now();
  const done = (data: Record<string, unknown>) =>
    res.status(200).json({ message: "testAiConnection", data: { latencyMs: Date.now() - started, ...data } });
  const off = (f: AiFeature) => new Error(eff.missing[f] || "دستیار هوش مصنوعی روی این سرور فعال نیست");
  try {
    if (feature === "chat") {
      if (!eff.chat) throw off("chat");
      const r = await fetch(`${eff.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`Ollama ${r.status}`);
      const body = (await r.json()) as { models?: { name?: string }[] };
      const names = (body.models || []).map((m) => String(m.name || ""));
      if (eff.chat.model && !names.includes(eff.chat.model)) throw new Error("این مدل روی سرور Ollama نصب نیست");
      return done({ ok: true, provider: "ollama", model: eff.chat.model || undefined });
    }
    if (feature === "stt") {
      if (!eff.stt) throw off("stt");
      const r = await fetch(`${eff.stt.url}/models`, {
        headers: eff.stt.key ? { authorization: `Bearer ${eff.stt.key}` } : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`STT ${r.status}`);
      return done({ ok: true, model: eff.stt.model });
    }
    const p = eff[feature];
    if (!p) throw off(feature);
    const reply = await aiComplete(p, "Reply with the single word: OK", { maxTokens: 20, timeoutMs: 60_000 });
    return done({ ok: true, provider: p.kind, model: p.model, reply: reply.trim().slice(0, 80) });
  } catch (err) {
    return done({ ok: false, error: errorText(err) });
  }
});
