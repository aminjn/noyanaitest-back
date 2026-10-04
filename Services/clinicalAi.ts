// Clinical AI for the doctor panel: the pre-visit summary and the visit
// note draft. Patient data is sensitive, so the default is a model hosted
// inside Iran (Ollama). A foreign API is used only when the super admin
// picks the cloud provider for it (system settings -> AI, Lib/aiSettings.ts).
//
// Every output is a draft that the doctor edits and confirms.
import { IVisitIntake } from "../Models/VisitIntake";
import { aiComplete, getAiSettings } from "../Lib/aiSettings";

export const clinicalAiEnabled = async () => !!(await getAiSettings()).clinical;

const TIMEOUT_MS = 90_000;

const complete = async (system: string, user: string): Promise<string> => {
  const p = (await getAiSettings()).clinical;
  if (!p) throw new Error("Clinical AI is not configured");
  return aiComplete(p, user, { system, json: true, timeoutMs: TIMEOUT_MS });
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
