import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError } from "../Lib/AppError";
import AppConfig from "../Models/AppConfig";
import { getAppConfig } from "../Lib/appConfig";
import { AI_DEFAULT_BASE, aiComplete, getAiSettings } from "../Lib/aiSettings";
import { isMaskedSecret, maskSecret } from "../Lib/secretMask";
import { currentLocale } from "../Lib/i18n/requestContext";
import { translateMessage } from "../Lib/i18n/translateMessage";

// Super admin: the AI providers (system settings -> AI). Keys are
// write-only, like the map key: reads get a masked preview.

const describe = (p: { kind: string; model: string } | undefined) =>
  p ? { on: true, provider: p.kind, model: p.model } : { on: false };

// GET /admin/ai/settings
export const getAiSettingsAdmin: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  const c = await getAppConfig();
  const eff = await getAiSettings();
  res.status(200).json({
    message: "getAiSettings",
    data: {
      aiProvider: c.aiProvider || eff.provider,
      aiBaseUrl: c.aiBaseUrl || "",
      apiKeySet: !!c.aiApiKey,
      apiKeyPreview: maskSecret(c.aiApiKey),
      apiKeyFromEnv: !c.aiApiKey && !!process.env.ANTHROPIC_API_KEY,
      ollamaHost: eff.ollamaHost,
      translationAiEnabled: !!eff.translation || (c.translationAiEnabled ?? false),
      translationAiModel: eff.translation?.model || c.translationAiModel || "",
      clinicalAiEnabled: !!eff.clinical || (c.clinicalAiEnabled ?? false),
      clinicalAiProvider: c.clinicalAiProvider || (eff.clinical && eff.clinical.kind !== "ollama" ? "cloud" : "ollama"),
      clinicalAiModel: eff.clinical?.model || c.clinicalAiModel || "",
      sttEnabled: !!eff.stt || (c.sttEnabled ?? false),
      sttUrl: eff.stt?.url || c.sttUrl || "",
      sttKeySet: !!c.sttApiKey,
      sttKeyPreview: maskSecret(c.sttApiKey),
      sttModel: eff.stt?.model || c.sttModel || "",
      sttLanguage: eff.stt?.language || c.sttLanguage || "",
      defaults: AI_DEFAULT_BASE,
      // what actually runs now, after the .env fallback
      status: {
        translation: describe(eff.translation),
        clinical: describe(eff.clinical),
        stt: eff.stt ? { on: true, model: eff.stt.model } : { on: false },
        chat: { on: !!eff.ollamaHost },
      },
    },
  });
});

const url = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === "" || /^https?:\/\/[^\s]+$/i.test(v));
const short = z.string().trim().max(120);

const settingsSchema = z.strictObject({
  aiProvider: z.enum(["anthropic", "openai", "ollama"]).optional(),
  aiApiKey: z.string().trim().max(500).optional(),
  clearApiKey: z.boolean().optional(),
  aiBaseUrl: url.optional(),
  ollamaHost: url.optional(),
  translationAiEnabled: z.boolean().optional(),
  translationAiModel: short.optional(),
  clinicalAiEnabled: z.boolean().optional(),
  clinicalAiProvider: z.enum(["ollama", "cloud"]).optional(),
  clinicalAiModel: short.optional(),
  sttEnabled: z.boolean().optional(),
  sttUrl: url.optional(),
  sttApiKey: z.string().trim().max(500).optional(),
  clearSttKey: z.boolean().optional(),
  sttModel: short.optional(),
  sttLanguage: z.string().trim().max(10).optional(),
});

// POST /admin/ai/settings
export const saveAiSettings: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const parsed = settingsSchema.safeParse(req.body || {});
  if (!parsed.success) return next(new BadInputError());
  const { aiApiKey, clearApiKey, sttApiKey, clearSttKey, ...rest } = parsed.data;
  const $set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) $set[k] = v;
  for (const k of ["aiBaseUrl", "ollamaHost", "sttUrl"] as const)
    if (typeof $set[k] === "string") $set[k] = ($set[k] as string).replace(/\/+$/, "");
  if (clearApiKey) $set.aiApiKey = "";
  else if (aiApiKey && !isMaskedSecret(aiApiKey)) $set.aiApiKey = aiApiKey;
  if (clearSttKey) $set.sttApiKey = "";
  else if (sttApiKey && !isMaskedSecret(sttApiKey)) $set.sttApiKey = sttApiKey;
  await getAppConfig();
  if (Object.keys($set).length) await AppConfig.updateOne({ singleton: "SINGLETON" }, { $set });
  res.status(200).json({ message: "saveAiSettings" });
});

// "fetch failed" / a timeout: the server never answered
const UNREACHABLE = "سرور در دسترس نیست؛ آدرس و دسترسی شبکه‌ی سرور را بررسی کنید";
const errorText = (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const unreachable = /fetch failed|timeout|aborted|ECONNREFUSED|ENOTFOUND/i.test(message);
  return translateMessage(unreachable ? UNREACHABLE : message, currentLocale());
};

// POST /admin/ai/test {feature: translation | clinical | stt | ollama}
// One small real call with the saved settings.
export const testAiConnection: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const feature = String(req.body?.feature || "");
  if (!["translation", "clinical", "stt", "ollama"].includes(feature)) return next(new BadInputError());
  const eff = await getAiSettings();
  const started = Date.now();
  const done = (data: Record<string, unknown>) =>
    res.status(200).json({ message: "testAiConnection", data: { latencyMs: Date.now() - started, ...data } });
  try {
    if (feature === "ollama") {
      if (!eff.ollamaHost) throw new Error("آدرس سرور Ollama در تنظیمات هوش مصنوعی وارد نشده است");
      const r = await fetch(`${eff.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`Ollama ${r.status}`);
      const body = (await r.json()) as { models?: { name?: string }[] };
      return done({ ok: true, models: (body.models || []).map((m) => m.name).filter(Boolean) });
    }
    if (feature === "stt") {
      if (!eff.stt) throw new Error("تبدیل گفتار به متن روی این سرور فعال نیست");
      const r = await fetch(`${eff.stt.url}/models`, {
        headers: eff.stt.key ? { authorization: `Bearer ${eff.stt.key}` } : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`STT ${r.status}`);
      return done({ ok: true });
    }
    const p = feature === "translation" ? eff.translation : eff.clinical;
    if (!p)
      throw new Error(
        feature === "translation"
          ? "ترجمه‌ی ماشینی روی این سرور فعال نیست"
          : "دستیار هوش مصنوعی روی این سرور فعال نیست",
      );
    const reply = await aiComplete(p, "Reply with the single word: OK", { maxTokens: 20, timeoutMs: 60_000 });
    return done({ ok: true, provider: p.kind, model: p.model, reply: reply.trim().slice(0, 80) });
  } catch (err) {
    return done({ ok: false, error: errorText(err) });
  }
});
