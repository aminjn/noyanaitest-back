// AI help for the medical encyclopedia (Disease, Drug, Symptom), 2026-10.
//
// The editorial pattern of Healthline, Ada and Altibbi: the model drafts,
// a named doctor reviews, and nothing AI-written reaches the public page as
// "medically reviewed". Two calls, neither of which saves anything:
//   draft: Persian text for the structured fields that are still EMPTY
//          (a field an editor wrote is never overwritten);
//   check: a list of likely errors / missing safety warnings in what is
//          already written.
// The admin's form fills the drafts in, marks the record `aiDrafted` and
// clears the reviewer, so the page shows "awaiting a doctor's review" until
// a doctor is named again (Lib/medicalContent.ts).
//
// Encyclopedia text is public content, not patient data, so it uses the
// content provider of system settings -> AI (the machine translation one,
// Lib/aiSettings.ts) rather than the clinical one.
import { consumePlatformAi, refundAi } from "../Lib/ai/aiGate";
import AppError from "../Lib/AppError";
import { aiComplete, AiProvider, getAiSettings } from "../Lib/aiSettings";

export type MedicalKind = "disease" | "drug" | "symptom";

type FieldSpec = { key: string; about: string };

const CONDITION_FIELDS: FieldSpec[] = [
  { key: "description", about: "what it is, in plain language for patients (2-4 short paragraphs)" },
  { key: "pathophysiology", about: "how it develops in the body (mechanism), in plain language" },
  { key: "naturalProgression", about: "how it usually evolves over time, with and without treatment" },
  {
    key: "possibleComplication",
    about: "possible complications, and the warning signs that need a doctor or emergency care",
  },
  { key: "expectedPrognosis", about: "the usual outlook, stated cautiously (it varies between people)" },
];

// the structured text fields each kind may draft (all plain-text areas of
// the admin form; HTML fields such as `content` and `aiSummary` are not
// touched). Drug.prescriptionStatus is deliberately absent.
export const DRAFT_FIELDS: Record<MedicalKind, FieldSpec[]> = {
  disease: CONDITION_FIELDS,
  symptom: CONDITION_FIELDS,
  drug: [
    { key: "description", about: "what the drug is and what it is used for (indications), plain language" },
    { key: "prescribingInfo", about: "the usual indications / when doctors prescribe it" },
    {
      key: "dosage",
      about: "general guidance on how it is taken; no numeric doses unless given in the input - say the dose is set by the doctor",
    },
    { key: "sideEffects", about: "common side effects, and the serious ones that need urgent care" },
    { key: "warning", about: "main warnings, contraindications and important drug interactions (by drug class)" },
    { key: "pregnancyWarning", about: "use in pregnancy, cautiously; advise consulting a doctor" },
    { key: "breastfeedingWarning", about: "use while breastfeeding, cautiously; advise consulting a doctor" },
    { key: "alcoholWarning", about: "alcohol interaction" },
    { key: "foodWarning", about: "food interactions and whether to take it with food" },
    { key: "overdosage", about: "signs of overdose and what to do (emergency care / poison centre)" },
    { key: "clinicalPharmacology", about: "how it works (mechanism of action), plain language" },
  ],
};

// what the model is shown about the record besides the draftable fields
const CONTEXT_FIELDS: Record<MedicalKind, string[]> = {
  disease: ["name", "summary", "genderSpecific"],
  symptom: ["name", "summary", "genderSpecific"],
  drug: [
    "name",
    "summary",
    "alternateName",
    "brand",
    "activeIngridient",
    "dosageForm",
    "drugUnit",
    "adminstrationRoute",
  ],
};

const KIND_NAME: Record<MedicalKind, string> = {
  disease: "a disease",
  symptom: "a symptom",
  drug: "a medicine",
};

const MAX_FIELD = 4000;

const text = (value: unknown, max = MAX_FIELD) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const isEmpty = (value: unknown) => !text(value);

// the record as the model sees it: context + every draftable field that has text
export const recordForAi = (kind: MedicalKind, record: Record<string, unknown>) => {
  const out: Record<string, string> = {};
  for (const key of [...CONTEXT_FIELDS[kind], ...DRAFT_FIELDS[kind].map((f) => f.key)]) {
    const value = text(record[key]);
    if (value) out[key] = value;
  }
  return out;
};

export const emptyDraftFields = (kind: MedicalKind, record: Record<string, unknown>) =>
  DRAFT_FIELDS[kind].filter((f) => isEmpty(record[f.key]));

// --- provider ---------------------------------------------------------------

export const NOT_CONFIGURED =
  "هوش مصنوعی برای محتوای پزشکی تنظیم نشده است؛ در تنظیمات سیستم، تب هوش مصنوعی، «ترجمه‌ی خودکار محتوا» را روشن کنید";
const UNREACHABLE =
  "سرور هوش مصنوعی پاسخ نداد؛ آدرس آن در تنظیمات سیستم و دسترسی شبکه‌ی سرور را بررسی کنید";
const FAILED = "سرویس هوش مصنوعی خطا داد؛ کمی بعد دوباره امتحان کنید";
const UNREADABLE = "پاسخ هوش مصنوعی قابل خواندن نبود؛ دوباره امتحان کنید";

export const contentAiProvider = async (): Promise<AiProvider | undefined> =>
  (await getAiSettings()).translation;

const complete = async (system: string, user: string) => {
  const p = await contentAiProvider();
  if (!p) throw new AppError(NOT_CONFIGURED, 503);
  // the AI policy's "content.medical" (the platform's own budget)
  const ticket = await consumePlatformAi("content.medical");
  try {
    return await aiComplete(p, user, { system, json: true, maxTokens: 8000, timeoutMs: 180_000 });
  } catch (err) {
    await refundAi(ticket);
    const message = err instanceof Error ? err.message : String(err);
    console.log("[medicalContentAi]", message.slice(0, 300));
    const unreachable = /fetch failed|timeout|aborted|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message);
    throw new AppError(unreachable ? UNREACHABLE : FAILED, 502);
  }
};

const parseObject = (reply: string): Record<string, unknown> => {
  // models sometimes wrap JSON in a ```json fence or add a sentence
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  try {
    if (start === -1 || end <= start) throw new Error("no object");
    const parsed = JSON.parse(reply.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError(UNREADABLE, 502);
  }
};

const RULES = `You help the editors of a Persian-language medical encyclopedia for patients in Iran.
Everything you write is a DRAFT that a licensed physician will review before it is published.
Rules:
- Write in clear, cautious, standard Persian (Farsi) for lay readers. Use Persian digits only if you must write a number.
- Never invent numbers: no doses, percentages, statistics, durations or prices unless they appear in the input.
- Do not cite sources, studies or URLs, and do not name brands that are not in the input.
- Do not give a definitive diagnosis or tell the reader to start or stop a medicine on their own; advise seeing a doctor where relevant.
- Always mention warning signs that need urgent care when they apply to the topic.
- If you are not reasonably sure of something, leave it out. An empty string is better than a guess.
- Reply with one JSON object only, no other text.`;

// --- draft ------------------------------------------------------------------

export const draftMedicalFields = async (
  kind: MedicalKind,
  record: Record<string, unknown>,
): Promise<{ drafts: Record<string, string>; skipped: string[] }> => {
  const targets = emptyDraftFields(kind, record);
  if (!targets.length) return { drafts: {}, skipped: [] };
  const fieldList = targets.map((f) => `- "${f.key}": ${f.about}`).join("\n");
  const reply = await complete(
    `${RULES}
Task: write drafts for the EMPTY fields of an encyclopedia page about ${KIND_NAME[kind]}.
Fields to write (and only these keys):
${fieldList}
Use the fields already filled in the input as context and stay consistent with them.
JSON shape: {"drafts": {"<field key>": "<Persian text>"}}`,
    JSON.stringify({ kind, record: recordForAi(kind, record) }),
  );
  const obj = parseObject(reply);
  const raw = (obj.drafts && typeof obj.drafts === "object" ? obj.drafts : obj) as Record<string, unknown>;
  const drafts: Record<string, string> = {};
  for (const f of targets) {
    const value = text(raw[f.key]);
    if (value) drafts[f.key] = value;
  }
  return { drafts, skipped: targets.map((f) => f.key).filter((k) => !drafts[k]) };
};

// --- check ------------------------------------------------------------------

export type MedicalAiIssue = {
  field: string;
  severity: "high" | "medium" | "low";
  message: string;
  suggestion?: string;
};

const SEVERITIES = ["high", "medium", "low"] as const;

export const checkMedicalFields = async (
  kind: MedicalKind,
  record: Record<string, unknown>,
): Promise<MedicalAiIssue[]> => {
  const known = new Set(["general", ...CONTEXT_FIELDS[kind], ...DRAFT_FIELDS[kind].map((f) => f.key)]);
  const fieldList = DRAFT_FIELDS[kind].map((f) => `- "${f.key}": ${f.about}`).join("\n");
  const reply = await complete(
    `${RULES}
Task: review an encyclopedia page about ${KIND_NAME[kind]} as a careful medical editor. Change nothing.
List: likely factual errors, dangerous or overconfident advice, invented-looking numbers, missing safety warnings
(contraindications, pregnancy/breastfeeding, interactions, overdose, warning signs that need urgent care),
and contradictions between fields. Do not list style or grammar remarks. At most 15 items, most serious first.
The page's fields:
${fieldList}
"field" is one of the keys above, or "general" for the page as a whole.
JSON shape: {"issues": [{"field": string, "severity": "high" | "medium" | "low", "message": "<Persian>", "suggestion": "<Persian, optional>"}]}
If you find nothing, reply {"issues": []}.`,
    JSON.stringify({ kind, record: recordForAi(kind, record) }),
  );
  const obj = parseObject(reply);
  const list = Array.isArray(obj.issues) ? obj.issues : [];
  const issues: MedicalAiIssue[] = [];
  for (const item of list.slice(0, 15)) {
    if (!item || typeof item !== "object") continue;
    const el = item as Record<string, unknown>;
    const message = text(el.message, 600);
    if (!message) continue;
    const field = text(el.field, 60);
    const severity = SEVERITIES.includes(el.severity as never) ? (el.severity as MedicalAiIssue["severity"]) : "medium";
    const suggestion = text(el.suggestion, 600);
    issues.push({
      field: known.has(field) ? field : "general",
      severity,
      message,
      ...(suggestion ? { suggestion } : {}),
    });
  }
  return issues;
};
