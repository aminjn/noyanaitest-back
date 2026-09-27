// Clinical AI for the doctor panel: the pre-visit summary and the visit
// note draft. Patient data is sensitive, so the default is a model hosted
// inside Iran (Ollama). A foreign API is used only when the operator opts in
// explicitly with CLINICAL_AI_PROVIDER=anthropic.
//
//   CLINICAL_AI_PROVIDER   "ollama" (default) | "anthropic"
//   CLINICAL_OLLAMA_MODEL  e.g. "qwen2.5:14b"; unset = feature off
//   OLLAMA_HOST            shared with the translation service
//   CLINICAL_AI_MODEL      model for the anthropic provider
//
// Every output is a draft that the doctor edits and confirms.
import { IVisitIntake } from "../Models/VisitIntake";

type Provider =
  | { kind: "anthropic"; key: string; model: string; baseUrl: string }
  | { kind: "ollama"; host: string; model: string };

const provider = (): Provider | undefined => {
  const kind = process.env.CLINICAL_AI_PROVIDER || "ollama";
  if (kind === "anthropic" && process.env.ANTHROPIC_API_KEY)
    return {
      kind: "anthropic",
      key: process.env.ANTHROPIC_API_KEY,
      model: process.env.CLINICAL_AI_MODEL || "claude-sonnet-5",
      baseUrl: (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, ""),
    };
  if (kind === "ollama" && process.env.CLINICAL_OLLAMA_MODEL)
    return {
      kind: "ollama",
      host: (process.env.OLLAMA_HOST || "http://84.241.5.9:11434").replace(/\/$/, ""),
      model: process.env.CLINICAL_OLLAMA_MODEL,
    };
};

export const clinicalAiEnabled = () => !!provider();

const TIMEOUT_MS = 90_000;

const complete = async (system: string, user: string): Promise<string> => {
  const p = provider();
  if (!p) throw new Error("Clinical AI is not configured");
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  if (p.kind === "anthropic") {
    const response = await fetch(`${p.baseUrl}/v1/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": p.key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: p.model,
        max_tokens: 4000,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic API ${response.status}`);
    const data = (await response.json()) as { content: { text?: string }[] };
    return data.content.map((block) => block.text || "").join("");
  }
  const response = await fetch(`${p.host}/api/chat`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: p.model,
      stream: false,
      format: "json",
      options: { temperature: 0.2 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}`);
  const data = (await response.json()) as { message?: { content?: string } };
  return data.message?.content || "";
};

const parseObject = (reply: string): Record<string, unknown> => {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in reply");
  const parsed = JSON.parse(reply.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Reply is not an object");
  return parsed;
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const SAFETY = `You support a licensed physician in Iran. You never make the final decision.
Write in clear, clinical Persian. Do not invent facts that are not in the input; if something is unknown, leave it out.
Reply with JSON only.`;

const intakeText = (intake: Partial<IVisitIntake>) =>
  JSON.stringify({
    complaint: intake.complaint,
    onset: intake.onset,
    severity0to10: intake.severity,
    chronicConditions: intake.conditions,
    currentMedications: intake.medications,
    allergies: intake.allergies,
    emergencySymptoms: intake.redFlags,
    otherNotes: intake.notes,
  });

// Two-to-three sentence pre-visit summary + up to 3 questions to ask.
export const summarizeIntake = async (
  intake: Partial<IVisitIntake>,
): Promise<{ summary: string; questions: string[] }> => {
  const reply = await complete(
    `${SAFETY}
Summarize the patient's pre-visit questionnaire for the physician in 2-3 short sentences, then suggest up to 3 focused questions the physician may ask.
JSON shape: {"summary": string, "questions": string[]}`,
    intakeText(intake),
  );
  const obj = parseObject(reply);
  const questions = Array.isArray(obj.questions)
    ? obj.questions.map((q) => str(q, 300)).filter(Boolean).slice(0, 3)
    : [];
  return { summary: str(obj.summary, 1200), questions };
};

export type NoteDraft = {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  patientInstructions: string;
};

// Visit transcript (dictation or conversation) -> SOAP draft.
export const draftVisitNote = async (
  transcript: string,
  intake?: Partial<IVisitIntake> | null,
): Promise<NoteDraft> => {
  const reply = await complete(
    `${SAFETY}
Turn the physician's visit transcript into a SOAP note draft.
- subjective: chief complaint and history as reported by the patient
- objective: findings and measurements mentioned in the visit
- assessment: the physician's impression, only if the physician stated it
- plan: treatment, tests, follow-up that the physician said
- patientInstructions: the plan rewritten in simple words for the patient
JSON shape: {"subjective": string, "objective": string, "assessment": string, "plan": string, "patientInstructions": string}`,
    `Pre-visit questionnaire (may be empty): ${intake ? intakeText(intake) : "{}"}

Transcript:
${transcript}`,
  );
  const obj = parseObject(reply);
  return {
    subjective: str(obj.subjective, 5000),
    objective: str(obj.objective, 5000),
    assessment: str(obj.assessment, 5000),
    plan: str(obj.plan, 5000),
    patientInstructions: str(obj.patientInstructions, 3000),
  };
};
