import { createHash } from "crypto";
import { consumePlatformAi, refundAi } from "../Lib/ai/aiGate";
import { Model } from "mongoose";
import { Locale, locales, SOURCE_LOCALE } from "../Lib/locales";
import { aiComplete, getAiSettings } from "../Lib/aiSettings";
import {
  TranslatableFields,
  Translations,
} from "../Lib/i18n/translatable";

// Machine translation of DB content (Persian source -> other languages).
// The provider and model are set by the super admin (system settings -> AI,
// Lib/aiSettings.ts). With none set, only manual editing works.

const languageNames: Record<Locale, string> = {
  fa: "Persian",
  en: "English",
  ar: "Arabic",
  zh: "Simplified Chinese",
  hi: "Hindi",
  es: "Spanish",
  fr: "French",
  ru: "Russian",
  pt: "Portuguese (Brazil)",
  de: "German",
  tr: "Turkish",
  ur: "Urdu",
  bn: "Bengali",
  id: "Indonesian",
  ja: "Japanese",
};

export const targetLocales = locales.filter((l) => l !== SOURCE_LOCALE);

export const machineTranslationEnabled = async () => !!(await getAiSettings()).translation;

const prompt = (texts: string[], locale: Locale) =>
  `You translate content of a Persian medical and healthcare website (doctors, clinics, diseases, drugs, articles) into ${languageNames[locale]}.
Translate every string of the JSON array below from Persian into ${languageNames[locale]}.
- Keep the meaning precise and use standard medical terminology.
- Person names and brand names: transliterate, do not translate their meaning.
- Keep numbers, URLs, e-mail addresses, emoji, line breaks and any markup unchanged.
- A string that is already not Persian stays as it is.
Reply with only a JSON array of exactly ${texts.length} strings, in the same order, nothing else.

${JSON.stringify(texts)}`;

// Person names are written in the target language's script, never
// translated (2026-10): «محمد رضایی» is "Mohammad Rezaei", not a meaning.
const namesPrompt = (texts: string[], locale: Locale) =>
  `Each string of the JSON array below is part of a person's name (a doctor or a team member of a Persian healthcare website), written in Persian.
Write each one in ${languageNames[locale]} the way that person would write their own name in ${languageNames[locale]}: transliterate it into the script of ${languageNames[locale]} (for Latin-script languages use the common Latin spelling of Iranian names, e.g. محمد -> Mohammad, رضایی -> Rezaei). Do not translate the meaning of a name. Translate only a title such as «دکتر» (Dr.).
- A string that is already not Persian stays as it is.
Reply with only a JSON array of exactly ${texts.length} strings, in the same order, nothing else.

${JSON.stringify(texts)}`;

// the fields that hold a person's name, per model (transliterated)
export const personNameFields: Record<string, readonly string[]> = {
  DoctorProfile: ["firstName", "lastName"],
  Doctor: ["name"],
  AboutTeam: ["name"],
  Testify: ["name"],
};

const parseArray = (reply: string, length: number): string[] => {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("No JSON array in reply");
  const parsed = JSON.parse(reply.slice(start, end + 1));
  if (
    !Array.isArray(parsed) ||
    parsed.length !== length ||
    parsed.some((item) => typeof item !== "string")
  )
    throw new Error("Translation reply has the wrong shape");
  return parsed;
};

// one model call; the AI policy's "content.translation" (the platform's
// own budget, Lib/ai/aiGate.ts) counts it, and gives it back on failure
const complete = async (text: string): Promise<string> => {
  const p = (await getAiSettings()).translation;
  if (!p) throw new Error("Machine translation is not configured");
  const ticket = await consumePlatformAi("content.translation");
  try {
    return await aiComplete(p, text, { maxTokens: 16000, timeoutMs: 300_000 });
  } catch (err) {
    await refundAi(ticket);
    throw err;
  }
};

// Keeps each request well inside output limits.
const MAX_BATCH_CHARS = 6000;

export const translateTexts = async (
  texts: string[],
  locale: Locale,
  mode: "text" | "names" = "text",
): Promise<string[]> => {
  const build = mode === "names" ? namesPrompt : prompt;
  const out: string[] = [];
  let batch: string[] = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    let attempt = 0;
    for (;;) {
      try {
        out.push(...parseArray(await complete(build(batch, locale)), batch.length));
        break;
      } catch (err) {
        if (++attempt >= 3) throw err;
      }
    }
    batch = [];
    size = 0;
  };
  for (const text of texts) {
    if (size + text.length > MAX_BATCH_CHARS) await flush();
    batch.push(text);
    size += text.length;
  }
  await flush();
  return out;
};

// ---- Field values -> translatable pieces -------------------------------

// Slate RTF is stored as a JSON string; only its text leaves are sent.
type SlateNode = { text?: string; children?: SlateNode[] };

const parseRtf = (value: string): SlateNode[] | undefined => {
  if (!value.trim().startsWith("[")) return;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((n) => n && typeof n === "object")
      ? parsed
      : undefined;
  } catch {
    return;
  }
};

const textLeaves = (nodes: SlateNode[], out: SlateNode[] = []) => {
  for (const node of nodes) {
    if (typeof node.text === "string" && node.text.trim()) out.push(node);
    if (Array.isArray(node.children)) textLeaves(node.children, out);
  }
  return out;
};

type Piece = { text: string; apply: (translated: string) => void };

// Splits a field value into strings to translate; `build` returns the
// translated value once every piece has been applied.
const decompose = (value: unknown) => {
  const pieces: Piece[] = [];
  if (Array.isArray(value)) {
    const result = value.map((item) => (typeof item === "string" ? item : ""));
    result.forEach((item, i) => {
      if (item.trim()) pieces.push({ text: item, apply: (t) => (result[i] = t) });
    });
    return { pieces, build: () => result };
  }
  if (typeof value !== "string" || !value.trim())
    return { pieces, build: () => undefined };
  const rtf = parseRtf(value);
  if (rtf) {
    const leaves = textLeaves(rtf);
    for (const leaf of leaves)
      pieces.push({ text: leaf.text!, apply: (t) => (leaf.text = t) });
    return { pieces, build: () => JSON.stringify(rtf) };
  }
  let result = value;
  pieces.push({ text: value, apply: (t) => (result = t) });
  return { pieces, build: () => result };
};

// Fingerprint of the Persian source, stored with each translation so the
// admin can see which translations are older than their source.
export const sourceHash = (value: unknown) =>
  createHash("sha1").update(JSON.stringify(value ?? "")).digest("hex").slice(0, 12);

const hasText = (value: unknown) =>
  Array.isArray(value)
    ? value.some((v) => typeof v === "string" && v.trim())
    : typeof value === "string" && value.trim() !== "";

export type LocaleBag = Record<string, unknown> & {
  _src?: Record<string, string>;
};

// Which fields of `doc` still need a (fresh) translation in `locale`.
export const pendingFields = (
  doc: Record<string, any>,
  fields: TranslatableFields,
  locale: Locale,
  overwrite: boolean,
) => {
  const bag = ((doc.translations as Translations | undefined)?.[locale] ||
    {}) as LocaleBag;
  return Object.keys(fields).filter((field) => {
    if (!hasText(doc[field])) return false;
    if (overwrite || !hasText(bag[field])) return true;
    // Machine-made and the source changed since: redo it.
    const src = bag._src?.[field];
    return !!src && src !== sourceHash(doc[field]);
  });
};

// Machine-translates the pending fields of one document into `locales`
// and stores them (translations.<locale>.<field>). Returns how many
// fields were written.
export const translateDocument = async (
  model: Model<any>,
  doc: Record<string, any>,
  fields: TranslatableFields,
  targets: readonly Locale[],
  overwrite = false,
) => {
  let written = 0;
  for (const locale of targets) {
    const todo = pendingFields(doc, fields, locale, overwrite);
    if (!todo.length) continue;
    const parts = todo.map((field) => ({ field, ...decompose(doc[field]) }));
    // a person's name is transliterated, the rest translated
    const names = personNameFields[model.modelName] || [];
    const isName = (field: string) => names.includes(field);
    // Surrounding whitespace (spacing between RTF leaves) is kept as is.
    const textsOf = (list: typeof parts) => list.flatMap((part) => part.pieces.map((p) => p.text.trim()));
    const nameParts = parts.filter((p) => isName(p.field));
    const textParts = parts.filter((p) => !isName(p.field));
    const [nameOut, textOut] = await Promise.all([
      nameParts.length ? translateTexts(textsOf(nameParts), locale, "names") : Promise.resolve([]),
      textParts.length ? translateTexts(textsOf(textParts), locale) : Promise.resolve([]),
    ]);
    let ni = 0;
    let ti = 0;
    const set: Record<string, unknown> = {};
    for (const part of parts) {
      for (const piece of part.pieces) {
        const [, lead, , trail] = piece.text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
        const out = isName(part.field) ? nameOut[ni++] : textOut[ti++];
        piece.apply(lead + String(out ?? "").trim() + trail);
      }
      set[`translations.${locale}.${part.field}`] = part.build();
      set[`translations.${locale}._src.${part.field}`] = sourceHash(doc[part.field]);
    }
    await model.updateOne({ _id: doc._id }, { $set: set }, { strict: false });
    written += parts.length;
  }
  return written;
};
