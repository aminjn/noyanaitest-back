import Translation from "../Models/Translation";
import TextContent, { contentKeys } from "../Models/TextContent";
import { Locale } from "../Lib/locales";

// In-memory cache of the per-language admin overrides; every public page
// render asks for them, and they only change from the admin dictionary.
const cache = new Map<Locale, Record<string, string>>();

export const getTextOverrides = async (locale: Locale) => {
  const hit = cache.get(locale);
  if (hit) return hit;
  const doc = await Translation.findOne({ locale }).lean();
  const texts = (doc?.texts as Record<string, string>) || {};
  cache.set(locale, texts);
  return texts;
};

export const setTextOverride = async (
  locale: Locale,
  key: string,
  value: string | null,
) => {
  const update = value
    ? { $set: { [`texts.${key}`]: value } }
    : { $unset: { [`texts.${key}`]: 1 } };
  await Translation.findOneAndUpdate({ locale }, update, { upsert: true });
  cache.delete(locale);
};

// One-time move of the old single TextContent document (Persian) into the
// "fa" overrides, so texts edited in production over the years keep
// winning over the frontend's bundled fa.json. Values still equal to their
// key were never edited and are skipped.
export const migrateLegacyTextContent = async () => {
  const existing = await Translation.exists({ locale: "fa" });
  if (existing) return;
  const legacy: any = await TextContent.findOne().lean();
  const texts: Record<string, string> = {};
  if (legacy)
    for (const key of contentKeys) {
      const value = legacy[key];
      if (typeof value === "string" && value.trim() && value !== key)
        texts[key] = value;
    }
  await Translation.create({ locale: "fa", texts });
  console.log(`[i18n] migrated ${Object.keys(texts).length} Persian texts to Translation(fa)`);
};
