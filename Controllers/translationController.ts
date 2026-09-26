import { NextFunction, Request, RequestHandler, Response } from "express";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError } from "../Lib/AppError";
import { isLocale, locales } from "../Lib/locales";
import { contentKeys } from "../Models/TextContent";
import Translation from "../Models/Translation";
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
