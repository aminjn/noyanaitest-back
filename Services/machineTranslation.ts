import { createHash } from "crypto";
import { Model } from "mongoose";
import { Locale, locales } from "../Lib/locales";
import {
  TranslatableFields,
  Translations,
} from "../Lib/i18n/translatable";

// Machine translation of DB content (Persian source -> other languages).
//
// Provider, from env:
//   ANTHROPIC_API_KEY (+ TRANSLATION_MODEL, default claude-sonnet-5,
//     ANTHROPIC_BASE_URL for a proxy)            -> Anthropic Messages API
//   otherwise TRANSLATION_OLLAMA_MODEL (+ OLLAMA_HOST) -> the Ollama server
// With neither set, machine translation is off and only manual editing
// works.

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

export const targetLocales = locales.filter((l) => l !== "fa");

type Provider =
  | { kind: "anthropic"; key: string; model: string; baseUrl: string }
  | { kind: "ollama"; host: string; model: string };

const provider = (): Provider | undefined => {
  if (process.env.ANTHROPIC_API_KEY)
    return {
      kind: "anthropic",
      key: process.env.ANTHROPIC_API_KEY,
      model: process.env.TRANSLATION_MODEL || "claude-sonnet-5",
      baseUrl: (
        process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"
      ).replace(/\/$/, ""),
    };
  if (process.env.TRANSLATION_OLLAMA_MODEL)
    return {
      kind: "ollama",
      host: (process.env.OLLAMA_HOST || "http://84.241.5.9:11434").replace(
        /\/$/,
        "",
      ),
      model: process.env.TRANSLATION_OLLAMA_MODEL,
    };
};

export const machineTranslationEnabled = () => !!provider();

const prompt = (texts: string[], locale: Locale) =>
  `You translate content of a Persian medical and healthcare website (doctors, clinics, diseases, drugs, articles) into ${languageNames[locale]}.
Translate every string of the JSON array below from Persian into ${languageNames[locale]}.
- Keep the meaning precise and use standard medical terminology.
- Person names and brand names: transliterate, do not translate their meaning.
- Keep numbers, URLs, e-mail addresses, emoji, line breaks and any markup unchanged.
- A string that is already not Persian stays as it is.
Reply with only a JSON array of exactly ${texts.length} strings, in the same order, nothing else.

${JSON.stringify(texts)}`;

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

const complete = async (text: string): Promise<string> => {
  const p = provider();
  if (!p) throw new Error("Machine translation is not configured");
  if (p.kind === "anthropic") {
    const response = await fetch(`${p.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": p.key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: p.model,
        max_tokens: 16000,
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!response.ok)
      throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
    const data = (await response.json()) as {
      content: { type: string; text?: string }[];
    };
    return data.content.map((block) => block.text || "").join("");
  }
  const response = await fetch(`${p.host}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: p.model,
      stream: false,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}`);
  const data = (await response.json()) as { message?: { content?: string } };
  return data.message?.content || "";
};

// Keeps each request well inside output limits.
const MAX_BATCH_CHARS = 6000;

export const translateTexts = async (
  texts: string[],
  locale: Locale,
): Promise<string[]> => {
  const out: string[] = [];
  let batch: string[] = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    let attempt = 0;
    for (;;) {
      try {
        out.push(...parseArray(await complete(prompt(batch, locale)), batch.length));
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
    // Surrounding whitespace (spacing between RTF leaves) is kept as is.
    const texts = parts.flatMap((part) => part.pieces.map((p) => p.text.trim()));
    const translated = await translateTexts(texts, locale);
    let i = 0;
    const set: Record<string, unknown> = {};
    for (const part of parts) {
      for (const piece of part.pieces) {
        const [, lead, , trail] = piece.text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
        piece.apply(lead + translated[i++].trim() + trail);
      }
      set[`translations.${locale}.${part.field}`] = part.build();
      set[`translations.${locale}._src.${part.field}`] = sourceHash(doc[part.field]);
    }
    await model.updateOne({ _id: doc._id }, { $set: set }, { strict: false });
    written += parts.length;
  }
  return written;
};
