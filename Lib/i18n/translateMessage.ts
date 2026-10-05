import { errorMessages } from "./errorMessages";
import { Locale, SOURCE_LOCALE } from "../locales";

// Error / notice messages are written in Persian throughout the backend
// (new AppError("...")). errorMessages maps each of them (placeholders as
// ${1}, ${2}) to the other languages; errorController runs every outgoing
// message through here with the request's x-locale.

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Translations = Partial<Record<string, string>>;
type Matcher = { regex: RegExp; translations: Translations; literal: number };
type Catalog = { exact: Map<string, Translations>; patterns: Matcher[] };

// Splits a source -> translations map into exact strings and ${n} templates.
export const buildCatalog = (
  entries: Record<string, Translations>,
): Catalog => {
  const exact = new Map<string, Translations>();
  const patterns: Matcher[] = [];
  for (const [source, translations] of Object.entries(entries)) {
    if (source.includes("${")) {
      const regex = new RegExp(
        `^${source
          .split(/\$\{\d+\}/)
          .map(escape)
          .join("([\\s\\S]*?)")}$`,
      );
      const literal = source.replace(/\$\{\d+\}/g, "").length;
      patterns.push({ regex, translations, literal });
    } else exact.set(source, translations);
  }
  // the most specific template first: "درخواست شماره‌ی ${1}: «${2}»" before
  // "درخواست شماره‌ی ${1}", which would otherwise swallow it whole
  patterns.sort((a, b) => b.literal - a.literal);
  return { exact, patterns };
};

const { exact, patterns } = buildCatalog(errorMessages);

// A number inside a Persian message (written with Persian digits, e.g. via
// toLocaleString("fa-IR")) is re-formatted for the reader's language.
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
export const localizeValue = (value: string, locale: Locale) => {
  if (!/^[\d۰-۹٬,.]+$/.test(value)) return value;
  const n = Number(
    value
      .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
      .replace(/[٬,]/g, ""),
  );
  if (!Number.isFinite(n)) return value;
  try {
    return n.toLocaleString(locale);
  } catch {
    return String(n);
  }
};

export const fillTemplate = (
  template: string,
  values: string[],
  locale: Locale,
  mapValue?: (value: string) => string,
) =>
  template.replace(/\$\{(\d+)\}/g, (_, n) => {
    const value = values[Number(n) - 1] ?? "";
    return mapValue ? mapValue(value) : localizeValue(value, locale);
  });

// BadInputError is "<prefix>" or "<prefix>:<technical detail>" (zod output).
const BAD_INPUT = "اطلاعات وارد شده صحیح نمیباشد";

export const translateMessage = (message: string, locale: Locale): string => {
  if (locale === SOURCE_LOCALE || typeof message !== "string") return message;
  const normalized = message.replace(/\s+/g, " ").trim();
  const hit = exact.get(normalized);
  if (hit?.[locale]) return hit[locale]!;
  if (normalized.startsWith(BAD_INPUT)) {
    const base = exact.get(BAD_INPUT)?.[locale];
    if (base) return base + normalized.slice(BAD_INPUT.length);
  }
  for (const { regex, translations } of patterns) {
    const match = normalized.match(regex);
    if (match && translations[locale]) return fillTemplate(translations[locale]!, match.slice(1), locale);
  }
  return message;
};
