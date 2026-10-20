import Disease from "../Models/Disease";
import Speciality from "../Models/Speciality";
import { PUBLIC_MEDICAL } from "./medicalContent";
import { chooseSpeciality, specialityGuide } from "./triageSpeciality";

// The health chat's own protocol (2026-10), sent after the admin's
// instructions so it has the last word: one question at a time, an
// assessment only once the answers are in, and two machine lines the site
// turns into links and doctor cards (the patient never sees them).
//
// Benchmark: Ada and K Health ask one focused question per turn, then end
// with possible conditions, urgency and "who to see"; Babylon's failure was
// answering before asking. NoyanAI adds the step after: nearby doctors of
// that specialty, from the patient's own location.

const CACHE_MS = 10 * 60_000;
let cache: {
  at: number;
  specialities: { _id: string; name: string; slug?: string }[];
  diseases: { _id: string; name: string; slug?: string; terms: string[]; specialities: string[] }[];
} | null = null;

const norm = (s: string) =>
  String(s || "")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[‌‏‎]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const catalogue = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const [specialities, diseases] = await Promise.all([
    Speciality.find({ active: true, mergedInto: { $in: [null, undefined] } })
      .select("name slug")
      .lean<{ _id: unknown; name?: string; slug?: string }[]>(),
    Disease.find({ ...PUBLIC_MEDICAL, mergedInto: { $in: [null, undefined] } })
      .select("name slug synonyms specialities")
      .lean<{ _id: unknown; name?: string; slug?: string; synonyms?: string[]; specialities?: unknown[] }[]>(),
  ]);
  cache = {
    at: Date.now(),
    specialities: specialities.filter((s) => s.name).map((s) => ({ _id: String(s._id), name: s.name as string, slug: s.slug })),
    diseases: diseases
      .filter((d) => d.name)
      .map((d) => ({
        _id: String(d._id),
        name: d.name as string,
        slug: d.slug,
        terms: [d.name as string, ...(d.synonyms || [])].map(norm).filter((t) => t.length >= 3),
        specialities: (d.specialities || []).map(String),
      })),
  };
  return cache;
};

export const triagePrompt = async (): Promise<string> => {
  const { specialities } = await catalogue();
  const names = specialities
    .map((s) => s.name)
    .slice(0, 200)
    .join("، ");
  return [
    "You are NoyanAI's health assistant. Always answer in the language the patient writes in (Persian when they write Persian).",
    "Work like a careful triage nurse:",
    "1. While you still need information, reply with ONE short question only. Do not give a diagnosis, a list, or advice in a message that asks a question. Wait for the answer.",
    "   Choose the question like a doctor would: think of the likely causes of exactly what the patient described, and ask the one thing that best tells them apart or rules out something serious (how it started and how long, what makes it worse, the symptoms that come with it, warning signs).",
    "   Never ask what the patient already told you: if they said where it hurts, do not ask where it hurts. Stay on the body part and the complaint they named.",
    "   Do not greet or introduce yourself; the page already does. Go straight to the question, with at most one short sentence of empathy.",
    "   After the question add one line with 2 to 5 short answers to that exact question, in the patient's language, written as plain text without brackets.",
    "   Example: the patient says «باسنم درد میکنه». A good question: «درد موقع اجابت مزاج یا نشستن بیشتر می‌شود؟» then [[options: موقع اجابت مزاج | موقع نشستن | هر دو | فرقی ندارد]]. A bad question asks where the pain is and offers head, neck or shoulder.",
    "2. Ask at most four questions in total; stop earlier once you know enough.",
    "3. If anything sounds like an emergency (chest pain, trouble breathing, fainting, signs of stroke, heavy bleeding, suicidal thoughts), say at once to call 115 or go to the nearest emergency department.",
    "4. Once you know enough, give a short assessment with these parts: the likely condition(s), how urgent it is, safe things to do at home, and which specialist to see. Never prescribe prescription drugs or doses.",
    "5. At the very end of that assessment message only, add these two lines exactly, for the website (they are hidden from the patient):",
    "[[urgency: emergency | soon | routine]] (one word: emergency = now / 115, soon = within a few days, routine = no hurry)",
    "[[specialty: <one specialist name, copied from the list below>]]",
    "[[conditions: <condition name> | <condition name>]]",
    "Never write the urgency, specialty or conditions lines in a message that asks a question.",
    specialityGuide(),
    "An assessment never asks anything: if you still want to ask (for example \"any other symptoms?\"), send only that question with its options line, and give the assessment after the answer.",
    names ? `Specialists on the site: ${names}` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

export type TriageMeta = {
  // the answers the patient can tap under a question
  options?: string[];
  urgency?: "emergency" | "soon" | "routine";
  speciality?: { _id: string; name: string; slug?: string };
  diseases?: { _id: string; name: string; slug?: string }[];
};

// a line that asks: it ends with a question mark (Persian or Latin)
const isQuestion = (line: string) => /[?؟][\s"'»)!.…]*$/.test(line.trim());

const TAG = /\[\[\s*(specialty|speciality|conditions?|diseases?|options?|urgency)\s*:\s*([^\]]*)\]\]/gi;

// the reply without the machine lines, and what they (and the text) name.
// `patientText` is what the patient wrote in this chat: the specialist must
// fit it (Lib/triageSpeciality.ts).
// `assessment`: the site's interview is over, so this reply is the assessment
// whatever it opens with, at least as urgent as the answers said.
export const readTriage = async (
  reply: string,
  patientText = "",
  opts: { assessment?: boolean; urgency?: "soon" | "routine" } = {},
): Promise<{ text: string; meta: TriageMeta }> => {
  let specialtyName = "";
  let urgency = "";
  const conditionNames: string[] = [];
  const options: string[] = [];
  for (const m of reply.matchAll(TAG)) {
    const kind = m[1].toLowerCase();
    if (kind.startsWith("speci")) specialtyName = m[2].trim();
    else if (kind === "urgency") urgency = m[2].trim().toLowerCase();
    else if (kind.startsWith("option")) options.push(...m[2].split("|").map((s) => s.trim()).filter(Boolean));
    else conditionNames.push(...m[2].split(/[|،,]/).map((s) => s.trim()).filter(Boolean));
  }
  let text = reply.replace(TAG, "").replace(/\n{3,}/g, "\n\n").trim();
  const { specialities, diseases } = await catalogue();
  const meta: TriageMeta = {};
  // plain answers: no template brackets the model copied («<در ناحیه‌ی سر»)
  const taps = [...new Set(options.map((o) => o.replace(/[<>{}\[\]«»"]/g, "").trim()))]
    .filter((o) => o && o.length <= 40 && !/^(answer|پاسخ)$/i.test(o))
    .slice(0, 5);
  // a reply that opens with a question is a question, even when the model
  // wrote an assessment under it: the patient gets only the question and
  // answers it first. An emergency is never held back.
  const lines = text.split("\n");
  const opening = lines.findIndex((l) => l.trim());
  const second = lines.findIndex((l, i) => i > opening && l.trim());
  const qLine = [opening, second].find((i) => i >= 0 && isQuestion(lines[i]));
  if (!opts.assessment && urgency !== "emergency" && qLine !== undefined) {
    text = lines.slice(0, qLine + 1).join("\n").trim();
    specialtyName = "";
    urgency = "";
    conditionNames.length = 0;
  }
  if (taps.length >= 2 && !specialtyName) meta.options = taps;
  if (urgency === "emergency" || urgency === "soon" || urgency === "routine") meta.urgency = urgency;
  if (opts.assessment) {
    delete meta.options;
    if (!meta.urgency || (meta.urgency === "routine" && opts.urgency === "soon")) meta.urgency = opts.urgency || "routine";
  }
  // conditions the reply names that the site has a page for: the tag's own
  // names first, then any page title written in the text
  const body = norm(text);
  const found = new Map<string, { _id: string; name: string; slug?: string }>();
  for (const name of conditionNames) {
    const n = norm(name);
    const d = diseases.find((x) => x.terms.includes(n)) || diseases.find((x) => x.terms.some((t) => n.includes(t) && t.length >= 4));
    if (d) found.set(d._id, { _id: d._id, name: d.name, slug: d.slug });
  }
  for (const d of diseases) {
    if (found.size >= 6) break;
    if (d.terms.some((t) => t.length >= 4 && body.includes(t))) found.set(d._id, { _id: d._id, name: d.name, slug: d.slug });
  }
  // the specialist: the model's pick when it fits the complaint, else the
  // fitting one (a condition page's own specialist first)
  if (specialtyName || meta.urgency === "soon" || meta.urgency === "routine") {
    const want = norm(specialtyName);
    const picked = !want
      ? undefined
      : specialities.find((s) => norm(s.name) === want) ||
        specialities.find((s) => want.includes(norm(s.name)) || norm(s.name).includes(want));
    const pageIds = new Set([...found.values()].flatMap((d) => diseases.find((x) => x._id === d._id)?.specialities || []));
    const chosen = chooseSpeciality({
      picked,
      patientText,
      fromDiseases: specialities.filter((s) => pageIds.has(s._id)),
      specialities,
    });
    if (!chosen && picked) text = text.split(picked.name).join("پزشک");
    if (chosen) {
      meta.speciality = chosen;
      // the text names the specialist the card shows
      if (picked && chosen._id !== picked._id) {
        const named = text.includes(picked.name) ? picked.name : specialtyName;
        text = text.split(named).join(chosen.name);
      }
    }
  }
  if (found.size) meta.diseases = [...found.values()].filter((d) => d.slug).slice(0, 6);
  return { text, meta };
};

// a title in the patient's language: Persian when they wrote Persian
export const titleLanguageHint = (question: string) =>
  /[؀-ۿ]/.test(question) ? "Persian (فارسی)" : "the same language as the message";
