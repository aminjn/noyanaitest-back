import { NextFunction, Request, RequestHandler, Response } from "express";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError } from "../Lib/AppError";
import { defaultLocale, isLocale, locales } from "../Lib/locales";
import { contentKeys } from "../Models/TextContent";
import Translation from "../Models/Translation";
import AppConfig from "../Models/AppConfig";
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

// Enabled site languages, Persian first and always included; every language
// when nothing has been saved yet.
const readEnabledLocales = async () => {
  const config = await AppConfig.findOne({ singleton: "SINGLETON" })
    .select("enabledLocales")
    .lean();
  const saved = Array.isArray(config?.enabledLocales)
    ? config.enabledLocales.filter(isLocale)
    : null;
  const enabled = saved && saved.length ? saved : [...locales];
  return [defaultLocale, ...locales.filter((l) => l !== defaultLocale && enabled.includes(l))];
};

// GET /public/locales - languages the site currently serves (middleware,
// language switcher, sitemap).
export const getPublicLocales: RequestHandler = catchAsync(
  async (req: Request, res: Response) => {
    res.status(200).json({
      message: "getPublicLocales",
      data: { enabled: await readEnabledLocales(), default: defaultLocale },
    });
  },
);

const enabledLocalesSchema = z.object({
  enabled: z.array(z.enum(locales)).max(locales.length),
});

// PATCH /admin/locales {enabled: [...]} - super admin "Site languages".
export const updateEnabledLocales: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = enabledLocalesSchema.safeParse(req.body);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const enabled = [
      defaultLocale,
      ...locales.filter(
        (l) => l !== defaultLocale && parsed.data.enabled.includes(l),
      ),
    ];
    await AppConfig.findOneAndUpdate(
      { singleton: "SINGLETON" },
      { $set: { enabledLocales: enabled } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    res.status(200).json({ message: "updateEnabledLocales", data: { enabled } });
  },
);
