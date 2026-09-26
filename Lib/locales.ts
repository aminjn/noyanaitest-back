// Site languages - kept in sync with Components/i18n/locales.ts on
// noyanai-front. Persian is the default.
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

export const defaultLocale: Locale = "fa";

export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && (locales as readonly string[]).includes(value);

// Request locale: the frontend sends x-locale on every API call.
export const requestLocale = (headers: Record<string, unknown>): Locale => {
  const value = headers["x-locale"];
  return isLocale(value) ? value : defaultLocale;
};
