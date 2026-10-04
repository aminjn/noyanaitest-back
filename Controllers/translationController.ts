import { NextFunction, Request, RequestHandler, Response } from "express";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError } from "../Lib/AppError";
import { isLocale, locales } from "../Lib/locales";
import { clearSiteLocalesCache, getSiteLocales } from "../Lib/siteLocales";
import { contentKeys } from "../Models/TextContent";
import Translation from "../Models/Translation";
import AppConfig from "../Models/AppConfig";
import { getAppConfig } from "../Lib/appConfig";
import { getPatientFreeCancelHours } from "../Services/reservationCancelService";
import { getTextOverrides, setTextOverride } from "../Services/translationStore";

const keySet = new Set<string>(contentKeys);

// GET /public/texts?locale=en - admin overrides for one language (the base
// texts ship with the frontend).
export const getPublicTexts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { locale } = req.query;
    if (!isLocale(locale)) return next(new BadInputError());
    res.status(200).json({ message: "getPublicTexts", data: await getTextOverrides(locale) });
  },
);

// GET /admin/texts - overrides of every language, for the admin dictionary.
export const getAllTexts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const docs = await Translation.find().lean();
    const data = Object.fromEntries(
      locales.map((locale) => [
        locale,
        (docs.find((d) => d.locale === locale)?.texts as Record<string, string>) || {},
      ]),
    );
    res.status(200).json({ message: "getAllTexts", data });
  },
);

const updateSchema = z.object({
  locale: z.enum(locales),
  key: z.string().refine((k) => keySet.has(k), "unknown key"),
  // empty / null = remove the override and fall back to the bundled text
  value: z.string().max(10000).nullable(),
});

// PATCH /admin/texts {locale, key, value}
export const updateText: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const { locale, key, value } = parsed.data;
    await setTextOverride(locale, key, value?.trim() ? value : null);
    res.status(200).json({ message: "updateText" });
  },
);

// GET /public/locales - languages the site currently serves (middleware,
// language switcher, sitemap).
export const getPublicLocales: RequestHandler = catchAsync(
  async (req: Request, res: Response) => {
    const { enabled, default: def } = await getSiteLocales();
    // the few public site settings the pages need (2026-10): the emergency
    // note of the health pages and the patient's free-cancel window. Extra
    // fields only - older readers of { enabled, default } are unaffected.
    const config = await getAppConfig().catch(() => null);
    const emergencyNumber =
      typeof config?.emergencyNumber === "string" && config.emergencyNumber.trim()
        ? config.emergencyNumber.trim()
        : "115";
    res.status(200).json({
      message: "getPublicLocales",
      data: {
        enabled,
        default: def,
        site: {
          emergencyNumber,
          emergencyNoteEnabled: config?.emergencyNoteEnabled !== false,
          patientFreeCancelHours: await getPatientFreeCancelHours(),
        },
      },
    });
  },
);

const enabledLocalesSchema = z.object({
  enabled: z.array(z.enum(locales)).max(locales.length),
  // the site default (unprefixed URLs, the super admin panel); always kept
  // among the enabled ones
  default: z.enum(locales).optional(),
});

// PATCH /admin/locales {enabled: [...], default} - super admin "Site
// languages".
export const updateEnabledLocales: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = enabledLocalesSchema.safeParse(req.body);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const def = parsed.data.default || (await getSiteLocales()).default;
    const enabled = [
      def,
      ...locales.filter((l) => l !== def && parsed.data.enabled.includes(l)),
    ];
    await AppConfig.findOneAndUpdate(
      { singleton: "SINGLETON" },
      { $set: { enabledLocales: enabled, defaultLocale: def } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    clearSiteLocalesCache();
    await getSiteLocales();
    res.status(200).json({
      message: "updateEnabledLocales",
      data: { enabled, default: def },
    });
  },
);
