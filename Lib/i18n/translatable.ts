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

// ---- automatic translation (2026-10, Services/autoTranslate.ts) ---------
// A record created, or whose Persian text changes, is queued for machine
// translation into the enabled site languages, whichever path wrote it.
// Writes that only touch `translations` (the translator itself, the admin's
// manual edits) are not.

const enqueue = (modelName: string | undefined, ids: unknown[]) => {
  if (!modelName || !translatableFields[modelName] || !ids.length) return;
  // loaded lazily: the service imports models, models import this plugin
  import("../../Services/autoTranslate")
    .then(({ enqueueTranslationSoon }) => enqueueTranslationSoon(modelName, ids))
    .catch(() => {});
};

// whether an update writes one of the translated fields
export const touchesTranslatedFields = (update: unknown, fields: string[]): boolean => {
  if (!update || typeof update !== "object") return false;
  // an aggregation-pipeline update: anything may change
  if (Array.isArray(update)) return true;
  const paths: string[] = [];
  for (const [key, value] of Object.entries(update as Record<string, unknown>)) {
    if (key.startsWith("$")) {
      if (value && typeof value === "object") paths.push(...Object.keys(value as object));
    } else paths.push(key);
  }
  return paths.some((path) => fields.includes(path.split(".")[0]));
};

const fieldNames = (modelName: string | undefined) =>
  modelName && translatableFields[modelName] ? Object.keys(translatableFields[modelName]) : [];

const MAX_FILTER_IDS = 2000;

const addAutoTranslateHooks = (schema: Schema) => {
  schema.pre("save", function (this: any) {
    const fields = fieldNames(this.constructor?.modelName);
    this.$locals.translateAfterSave =
      !!fields.length && (this.isNew || fields.some((f) => this.isModified(f)));
  });
  schema.post("save", function (this: any) {
    if (this.$locals?.translateAfterSave) enqueue(this.constructor?.modelName, [this._id]);
  });
  schema.post("insertMany", function (this: any, docs: unknown) {
    const list = Array.isArray(docs) ? docs : [docs];
    enqueue(this.modelName, list.map((d) => (d as { _id?: unknown })?._id).filter(Boolean));
  });
  schema.post(["findOneAndUpdate", "findOneAndReplace"], function (this: any, doc: unknown) {
    const modelName = this.model?.modelName;
    const id = (doc as { _id?: unknown } | null)?._id;
    if (!id) return;
    const update = this.op === "findOneAndReplace" ? { $set: this.getUpdate() } : this.getUpdate();
    if (touchesTranslatedFields(update, fieldNames(modelName))) enqueue(modelName, [id]);
  });
  schema.post(["updateOne", "updateMany", "replaceOne"], function (this: any, result: unknown) {
    const modelName = this.model?.modelName;
    const update = this.op === "replaceOne" ? { $set: this.getUpdate() } : this.getUpdate();
    if (!touchesTranslatedFields(update, fieldNames(modelName))) return;
    const upserted = (result as { upsertedId?: unknown } | null)?.upsertedId;
    if (upserted) return enqueue(modelName, [upserted]);
    // the records the filter matched (after the write)
    this.model
      .find(this.getFilter(), { _id: 1 })
      .limit(this.op === "updateMany" ? MAX_FILTER_IDS : 1)
      .lean()
      .then((rows: { _id: unknown }[]) => enqueue(modelName, rows.map((r) => r._id)))
      .catch(() => {});
  });
};

export const translatable = (schema: Schema) => {
  schema.add({ translations: { type: Schema.Types.Mixed } });
  addAutoTranslateHooks(schema);

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
