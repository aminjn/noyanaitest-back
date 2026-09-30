import { Schema } from "mongoose";
import { Locale, SOURCE_LOCALE } from "../locales";
import { currentLocale } from "./requestContext";
import { translatableFields } from "./translatableFields";

// DB content is authored in Persian. A translatable model keeps the other
// languages next to it, in `translations`:
//   { en: { name: "...", summary: "..." }, ar: { ... } }
// Only the fields listed in translatableFields are translated; anything
// missing for a language falls back to the Persian value.

// "line": short text, "text": long text or Slate RTF JSON (the editor
// tells them apart by content), "list": array of short strings.
export type TranslatableKind = "line" | "text" | "list";
export type TranslatableFields = Record<string, TranslatableKind>;

export type Translations = Partial<
  Record<Locale, Record<string, string | string[]>>
>;

const isInclusive = (projection: Record<string, unknown>) =>
  Object.entries(projection).some(
    ([key, value]) => key !== "_id" && (value === 1 || value === true),
  );

const isRegexCondition = (value: unknown) =>
  value instanceof RegExp ||
  (!!value && typeof value === "object" && "$regex" in (value as object));

// { name: /قلب/ } -> { $or: [{ name: /x/ }, { "translations.en.name": /x/ }] }
// so text search also finds records by their translated name.
const widenSearch = (
  filter: Record<string, unknown>,
  fields: string[],
  locale: Locale,
) => {
  const widened: Record<string, unknown>[] = [];
  for (const field of fields) {
    const condition = filter[field];
    if (!isRegexCondition(condition)) continue;
    delete filter[field];
    widened.push({
      $or: [
        { [field]: condition },
        { [`translations.${locale}.${field}`]: condition },
      ],
    });
  }
  if (!widened.length) return filter;
  return { $and: [filter, ...widened] };
};

export const translatable = (schema: Schema) => {
  schema.add({ translations: { type: Schema.Types.Mixed } });

  // Queries that pick fields explicitly (.select("name slug")) would drop
  // `translations`; add the current language's part so the response
  // overlay (localizeResponse) has something to apply. Populate runs
  // through here too.
  schema.pre(/^find/, function (this: any) {
    const locale = currentLocale();
    if (locale === SOURCE_LOCALE) return;
    const projection = this.projection?.();
    if (projection && isInclusive(projection) && !("translations" in projection))
      this.select({ [`translations.${locale}`]: 1 });
    const fields = translatableFields[this.model?.modelName];
    if (fields) {
      const filter = this.getFilter();
      const widened = widenSearch({ ...filter }, Object.keys(fields), locale);
      if (widened.$and) this.setQuery(widened);
    }
  });

  schema.pre("aggregate", function (this: any) {
    const locale = currentLocale();
    if (locale === SOURCE_LOCALE) return;
    const fields = translatableFields[this._model?.modelName];
    if (!fields) return;
    for (const stage of this.pipeline() as Record<string, any>[]) {
      if (stage.$match)
        stage.$match = widenSearch({ ...stage.$match }, Object.keys(fields), locale);
      // Keep the translations through field-picking projections.
      if (
        stage.$project &&
        isInclusive(stage.$project) &&
        !("translations" in stage.$project)
      )
        stage.$project[`translations.${locale}`] = 1;
    }
  });
};
