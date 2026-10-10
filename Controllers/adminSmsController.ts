import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError } from "../Lib/AppError";
import * as env from "../Lib/Env";
import SmsGatewaySettings from "../Models/SmsGatewaySettings";
import { clearSmsGatewayCache, getSmsGateway, sendSmsRaw } from "../Lib/sendSms";
import { isPhone } from "../Lib/validators";
import SmsPatterns, { smsPatternNames } from "../Models/SmsPatterns";
import { locales } from "../Lib/locales";
import { loadSmsPolicy, normalizeSmsPolicy } from "../Lib/smsPolicy";

// Super admin: the SMS gateway (IPPanel) credentials, set from the panel.
// GET never returns the token itself - only whether one is set, where it
// comes from, and its last 4 characters to recognise it.

const tokenHint = (token: string) =>
  token ? `••••${token.slice(-4)}` : "";

// GET /admin/sms/settings
export const getSmsSettings: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const saved = await SmsGatewaySettings.findOne({ singleton: "SINGLETON" })
      .select("+apiToken")
      .populate({ path: "updatedBy", select: "phone username" })
      .lean();
    const effective = await getSmsGateway();
    const policy = normalizeSmsPolicy(saved);
    res.status(200).json({
      message: "getSmsSettings",
      data: {
        fromNumber: saved?.fromNumber || "",
        marketingFromNumber: saved?.marketingFromNumber || "",
        // advertising SMS rules (Lib/smsPolicy.ts)
        campaignWindowFrom: policy.from,
        campaignWindowUntil: policy.until,
        campaignDailyCap: policy.dailyCap,
        requestUrl: saved?.requestUrl || "",
        tokenSet: !!saved?.apiToken,
        tokenHint: tokenHint(saved?.apiToken || ""),
        // what is actually used right now (panel value, else .env)
        effective: {
          tokenSource: saved?.apiToken ? "panel" : env.SMS_API_TOKEN ? "env" : "none",
          tokenHint: tokenHint(effective.token),
          fromNumber: effective.fromNumber,
          url: effective.url,
        },
        // in development every SMS is only written to the server log
        dryRun: env.NODE_ENV === "development" || !effective.token,
        updatedAt: saved?.updatedAt || null,
        updatedBy: saved?.updatedBy || null,
      },
    });
  },
);

const saveSchema = z.strictObject({
  // empty / missing = keep the saved token; clearToken removes it
  apiToken: z.string().trim().max(500).optional(),
  // form data sends "true"/"false" strings (coerce would read "false" as true)
  clearToken: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true")
    .optional(),
  fromNumber: z
    .string()
    .trim()
    .max(20)
    .regex(/^\+?\d*$/)
    .optional(),
  // the advertising line campaign SMS leave from (2026-10)
  marketingFromNumber: z
    .string()
    .trim()
    .max(20)
    .regex(/^\+?\d*$/)
    .optional(),
  requestUrl: z
    .string()
    .trim()
    .max(300)
    .refine((v) => !v || /^https:\/\/[^\s]+$/.test(v))
    .optional(),
  // the Tehran hours advertising SMS may leave in, and the daily cap per
  // provider (0 = none) - Lib/smsPolicy.ts
  // inside the operators' 08:00-21:00 (Lib/smsPolicy.ts)
  campaignWindowFrom: z.coerce.number().int().min(8).max(20).optional(),
  campaignWindowUntil: z.coerce.number().int().min(9).max(21).optional(),
  campaignDailyCap: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

// POST /admin/sms/settings
export const saveSmsSettings: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = saveSchema.safeParse(req.body || {});
    if (!success) return next(new BadInputError());
    const $set: Record<string, unknown> = {
      updatedBy: req.user?._id,
      updatedAt: new Date(),
    };
    const $unset: Record<string, 1> = {};
    if (data.fromNumber !== undefined) $set.fromNumber = data.fromNumber;
    if (data.requestUrl !== undefined) $set.requestUrl = data.requestUrl;
    if (data.marketingFromNumber !== undefined) $set.marketingFromNumber = data.marketingFromNumber;
    if (data.campaignWindowFrom !== undefined || data.campaignWindowUntil !== undefined) {
      const current = await loadSmsPolicy();
      const from = data.campaignWindowFrom ?? current.from;
      const until = data.campaignWindowUntil ?? current.until;
      if (until <= from) return next(new AppError("پایان بازه‌ی ارسال باید بعد از شروع آن باشد", 400));
      $set.campaignWindowFrom = from;
      $set.campaignWindowUntil = until;
    }
    if (data.campaignDailyCap !== undefined) $set.campaignDailyCap = data.campaignDailyCap;
    if (data.clearToken) $unset.apiToken = 1;
    else if (data.apiToken) $set.apiToken = data.apiToken;
    await SmsGatewaySettings.updateOne(
      { singleton: "SINGLETON" },
      { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
      { upsert: true },
    );
    clearSmsGatewayCache();
    await loadSmsPolicy();
    res.status(200).json({ message: "saveSmsSettings" });
  },
);

const testSchema = z.strictObject({
  phone: z.string(),
  locale: z.enum(locales).optional(),
});

// POST /admin/sms/test - sends the login-code pattern (OTP_PATTERN) with a
// sample code, so the token, sender number and pattern are all checked at
// once; the gateway's own error text is returned as is.
export const testSms: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = testSchema.safeParse(req.body || {});
    const phone = success ? isPhone(data.phone) : undefined;
    if (!phone) return next(new BadInputError());
    const gateway = await getSmsGateway();
    const dryRun = env.NODE_ENV === "development" || !gateway.token;
    try {
      await sendSmsRaw(phone, "OTP_PATTERN", { OTP: "12345" }, { locale: data?.locale });
    } catch (err) {
      const raw = (err as Error)?.message || "";
      if (raw === "SMS pattern not set")
        return next(
          new AppError(
            "کد پترن ورود (OTP_PATTERN) در صفحه‌ی پترن‌های پیامک وارد نشده است",
            400,
          ),
        );
      return next(
        new AppError(
          `ارسال پیامک آزمایشی ناموفق بود: ${raw || "خطای نامشخص"}`,
          400,
        ),
      );
    }
    res.status(200).json({ message: "testSms", data: { phone, dryRun } });
  },
);

// ---- per-language pattern codes (Models/SmsPatterns.ts `localized`) ----
// A gateway pattern is fixed text, so a language gets its own pattern on
// the provider's panel and its code here. A language left empty sends the
// base pattern.

// GET /admin/sms/localizedPatterns
export const getLocalizedSmsPatterns: RequestHandler = catchAsync(
  async (_req: Request, res: Response) => {
    const doc = await SmsPatterns.findOneAndUpdate(
      { singleton: "SINGLETON" },
      {},
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    res.status(200).json({
      message: "getLocalizedSmsPatterns",
      data: { localized: doc?.localized || {} },
    });
  },
);

const localizedSchema = z.strictObject({
  localized: z.partialRecord(
    z.enum(smsPatternNames),
    z.partialRecord(z.enum(locales), z.string().trim().max(100)),
  ),
});

// POST /admin/sms/localizedPatterns - replaces the whole map; empty codes
// are dropped so that language falls back to the base pattern.
export const saveLocalizedSmsPatterns: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = localizedSchema.safeParse(req.body || {});
    if (!success) return next(new BadInputError());
    const localized: Record<string, Record<string, string>> = {};
    for (const [name, byLocale] of Object.entries(data.localized)) {
      const codes = Object.fromEntries(
        Object.entries(byLocale || {}).filter(([, code]) => !!code),
      ) as Record<string, string>;
      if (Object.keys(codes).length) localized[name] = codes;
    }
    await SmsPatterns.updateOne(
      { singleton: "SINGLETON" },
      { $set: { localized } },
      { upsert: true },
    );
    res.status(200).json({ message: "saveLocalizedSmsPatterns" });
  },
);
