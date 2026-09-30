// Site languages - kept in sync with Components/i18n/locales.ts on
// noyanai-front.
//
// Two different "base" languages (2026-09):
//  - SOURCE_LOCALE: the language stored content and backend messages are
//    written in (the base fields; other languages live in `translations`,
//    error texts in Lib/i18n/errorMessages.ts). Always Persian.
//  - the site's default language: set by the super admin (AppConfig
//    .defaultLocale, see Lib/siteLocales.ts) - unprefixed URLs, the super
//    admin panel, and a request that names no language use it.
export const locales = [
  "fa",
  "en",
  "ar",
  "zh",
  "hi",
  "es",
  "fr",
  "ru",
  "pt",
  "de",
  "tr",
  "ur",
  "bn",
  "id",
  "ja",
] as const;

export type Locale = (typeof locales)[number];

export const SOURCE_LOCALE: Locale = "fa";

// the site default before the super admin picks one (and the fallback while
// the setting can't be read)
export const defaultLocale: Locale = "fa";

// kept current by Lib/siteLocales.ts (read at boot, refreshed on change and
// every 30 s), so the synchronous per-request fallback below needs no query
let siteDefault: Locale = defaultLocale;
export const setSiteDefaultLocale = (locale: Locale) => {
  siteDefault = locale;
};
export const siteDefaultLocale = () => siteDefault;

export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && (locales as readonly string[]).includes(value);

// Request locale: the frontend sends x-locale on every API call.
export const requestLocale = (headers: Record<string, unknown>): Locale => {
  const value = headers["x-locale"];
  return isLocale(value) ? value : siteDefault;
};
