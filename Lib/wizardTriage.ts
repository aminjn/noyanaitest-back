import Disease from "../Models/Disease";
import Speciality from "../Models/Speciality";
import { PUBLIC_MEDICAL } from "./medicalContent";

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
  diseases: { _id: string; name: string; slug?: string; terms: string[] }[];
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
      .select("name slug synonyms")
      .lean<{ _id: unknown; name?: string; slug?: string; synonyms?: string[] }[]>(),
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
    "1. While you still need information, reply with ONE short question only (where it hurts, since when, how bad, what else they feel, red flags). Do not give a diagnosis, a list, or advice in a message that asks a question. Wait for the answer.",
    "2. Ask at most four questions in total; stop earlier once you know enough.",
    "3. If anything sounds like an emergency (chest pain, trouble breathing, fainting, signs of stroke, heavy bleeding, suicidal thoughts), say at once to call 115 or go to the nearest emergency department.",
    "4. Once you know enough, give a short assessment with these parts: the likely condition(s), how urgent it is, safe things to do at home, and which specialist to see. Never prescribe prescription drugs or doses.",
    "5. At the very end of that assessment message only, add these two lines exactly, for the website (they are hidden from the patient):",
    "[[specialty: <one specialist name, copied from the list below>]]",
    "[[conditions: <condition name> | <condition name>]]",
    "Never write these lines in a message that asks a question.",
    names ? `Specialists on the site: ${names}` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

export type TriageMeta = {
  speciality?: { _id: string; name: string; slug?: string };
  diseases?: { _id: string; name: string; slug?: string }[];
};

const TAG = /\[\[\s*(specialty|speciality|conditions?|diseases?)\s*:\s*([^\]]*)\]\]/gi;

// the reply without the machine lines, and what they (and the text) name
export const readTriage = async (reply: string): Promise<{ text: string; meta: TriageMeta }> => {
  let specialtyName = "";
  const conditionNames: string[] = [];
  for (const m of reply.matchAll(TAG)) {
    if (/^speci/i.test(m[1])) specialtyName = m[2].trim();
    else conditionNames.push(...m[2].split(/[|،,]/).map((s) => s.trim()).filter(Boolean));
  }
  const text = reply.replace(TAG, "").replace(/\n{3,}/g, "\n\n").trim();
  const { specialities, diseases } = await catalogue();
  const meta: TriageMeta = {};
  if (specialtyName) {
    const want = norm(specialtyName);
    const hit =
      specialities.find((s) => norm(s.name) === want) ||
      specialities.find((s) => want.includes(norm(s.name)) || norm(s.name).includes(want));
    if (hit) meta.speciality = hit;
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
  if (found.size) meta.diseases = [...found.values()].filter((d) => d.slug).slice(0, 6);
  return { text, meta };
};

// a title in the patient's language: Persian when they wrote Persian
export const titleLanguageHint = (question: string) =>
  /[؀-ۿ]/.test(question) ? "Persian (فارسی)" : "the same language as the message";
