// Writes the JSON Schema of the bulk provider import's native format
// (Lib/providerImport/catalog.ts) - the file the super admin downloads next
// to the sample (frontend public/samples/, docs/provider-import.schema.json).
//   npm run build && node compile/Scripts/providerImportSchema.js <out.json>
import fs from "fs";
import { AnyKind, FieldType, kindChildren, kindFields, nativeListKeys, TargetField } from "../Lib/providerImport/catalog";

const i18n = {
  oneOf: [
    { type: "string" },
    {
      type: "object",
      description: "fa (stored text) plus optional translations: en, ar, zh, hi, es, fr, ru, pt, de, tr, ur, bn, id, ja",
      properties: { fa: { type: "string" } },
      additionalProperties: { type: "string" },
    },
  ],
};

const typeSchema = (f: TargetField): Record<string, unknown> => {
  const t: FieldType = f.type;
  switch (t) {
    case "i18n":
      return i18n;
    case "number":
      return { oneOf: [{ type: "number", minimum: 0 }, { type: "string" }] };
    case "price":
      return { oneOf: [{ type: "number", exclusiveMinimum: 0 }, { type: "string" }], description: "toman" };
    case "boolean":
      return { oneOf: [{ type: "boolean" }, { type: "string" }] };
    case "enum":
      return { type: "string", enum: [...(f.enum || [])] };
    case "list":
    case "refList":
    case "phoneList":
      return { oneOf: [{ type: "array", items: { type: "string" } }, { type: "string", description: "comma separated" }] };
    case "lat":
      return { oneOf: [{ type: "number", minimum: -90, maximum: 90 }, { type: "string" }] };
    case "lng":
      return { oneOf: [{ type: "number", minimum: -180, maximum: 180 }, { type: "string" }] };
    case "point":
      return { oneOf: [{ type: "string", description: "\"lat,lng\"" }, { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }] };
    case "day":
      return {
        oneOf: [
          { type: "string", description: "saturday ... friday, or شنبه ... جمعه" },
          { type: "integer", minimum: 0, maximum: 6, description: "0 = Saturday (Iranian week)" },
          { type: "array", items: { oneOf: [{ type: "string" }, { type: "integer", minimum: 0, maximum: 6 }] } },
        ],
      };
    case "time":
      return { type: "string", pattern: "^\\d{1,2}(:\\d{2})?$", description: "HH:MM, Tehran time" };
    case "timeRange":
      return { type: "string", description: "\"09:00-13:00\", several separated by commas" };
    default:
      return { oneOf: [{ type: "string" }, { type: "number" }] };
  }
};

const objectOf = (kind: AnyKind): Record<string, unknown> => {
  const properties: Record<string, unknown> = {};
  for (const f of kindFields[kind]) properties[f.key] = { ...typeSchema(f), ...(f.example !== undefined && f.example !== "" ? { examples: [f.example] } : {}) };
  for (const c of kindChildren[kind]) properties[c.key] = { type: "array", items: { $ref: `#/$defs/${c.kind}` } };
  properties.translations = {
    type: "object",
    description: "per locale: { en: { firstName: \"...\" } }",
    additionalProperties: { type: "object", additionalProperties: { type: "string" } },
  };
  return {
    type: "object",
    required: kindFields[kind].filter((f) => f.required).map((f) => f.key),
    properties,
    additionalProperties: false,
  };
};

const kinds: AnyKind[] = ["doctor", "office", "hours", "visitType", "clinic", "hospital", "pharmacy", "lab", "labTest", "insurer"];
const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://noyanai.com/samples/noyan-providers.schema.json",
  title: "NoyanAI bulk provider import, format version 1",
  type: "object",
  required: ["version"],
  properties: {
    version: { const: 1 },
    ...Object.fromEntries(Object.entries(nativeListKeys).map(([key, kind]) => [key, { type: "array", items: { $ref: `#/$defs/${kind}` } }])),
  },
  additionalProperties: false,
  $defs: Object.fromEntries(kinds.map((k) => [k, objectOf(k)])),
};

const out = process.argv[2];
const text = `${JSON.stringify(schema, null, 2)}\n`;
if (out) fs.writeFileSync(out, text);
else process.stdout.write(text);
