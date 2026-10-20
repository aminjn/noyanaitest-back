import { AGE, Answer, Flag, Interview, interviewById, interviewFor, Question, RED_FLAGS } from "./interviews";

// Where the health chat's interview stands (Lib/triage/interviews.ts): the
// next question the site asks itself, an emergency, the moment the model
// writes the assessment, or no interview at all (the model talks freely).
//
// The state is the chat itself: each site question carries its interview,
// its question id and whether it opened the run (`meta.interview`), and the
// patient's next message is its answer. So nothing is asked twice, and a
// reload or a second device continues where the patient left off.
//
// Every message is checked for warning signs first, whatever is being asked;
// an unclear answer («نمی‌دونم») gets the question once more, then counts as
// unknown, never as «no»; a message that names another body area instead of
// answering starts that area's interview.

export type InterviewMeta = { id: string; q: string; n: number; total: number; start?: boolean; clarify?: boolean };
type Msg = { role: string; content: string; meta?: { interview?: InterviewMeta } | null };

export type Step =
  | { kind: "model" }
  | { kind: "ask"; text: string; options: string[]; interview: InterviewMeta }
  | { kind: "emergency"; text: string }
  | {
      kind: "assess";
      interview: Interview;
      urgency: "soon" | "routine";
      patientText: string;
      answers: { q: string; a: string }[];
      unclear: string[];
    };

const norm = (s: string) =>
  String(s || "")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[‌\s]+/g, " ")
    .replace(/[.!؟?،,]+$/, "")
    .trim()
    .toLowerCase();

// the answer the patient tapped (or typed in so many words)
const pickedAnswer = (q: Question, said: string): Answer | undefined => {
  const n = norm(said);
  return q.answers.find((x) => norm(x.label) === n) || q.answers.find((x) => n.length >= 3 && norm(x.label).includes(n));
};

const UNSURE = /^(نمی ?دونم|نمی ?دانم|نمیدونم|نمیدانم|مطمئن نیستم|شاید|یادم نیست|خبر ندارم|نه می ?دونم|\?|؟|idk|not sure|don't know)$/;
const unsure = (said: string) => UNSURE.test(norm(said));
const NO = /^(نه|خیر|هیچ‌?کدام|هیچ کدام|مشکلی ندارد|ارتباطی ندارد|فرقی ندارد|نه، فقط .*)$/;

const EMERGENCY =
  "این علامت می‌تواند نشانه‌ی یک وضعیت اورژانسی باشد. همین حالا با اورژانس ۱۱۵ تماس بگیرید یا به نزدیک‌ترین اورژانس بروید و تا رسیدن کمک تنها نمانید.";
const OPENING = "چند سؤال کوتاه می‌پرسم تا بهتر راهنمایی‌تان کنم.";
const CLARIFY = "متوجه شدم. اگر مطمئن نیستید، نزدیک‌ترین گزینه را انتخاب کنید یا با کلمات خودتان بنویسید:";

// a question about a condition or a drug («دیابت چیه؟»), not a complaint:
// the model answers it
const asksAbout = (text: string) =>
  /[?؟]\s*$/.test(text.trim()) || /(^|\s)(چیه|چیست|یعنی چه|چطوری|چگونه|علت|عوارض|درمان|دارو|قرص)(\s|$|[?؟])/.test(text);

// a question with an emergency answer: its warning signs must be cleared
const isWarning = (q: Question) => q.answers.some((x) => x.flag === "emergency");

const meets = (conds: { q: string; any: string[] }[] | undefined, said: Map<string, string>) =>
  !conds || conds.every((c) => c.any.some((l) => norm(l) === norm(said.get(c.q) || "")));

// the questions this patient gets, in order, given what is known so far
const plan = (interview: Interview, complaint: string, said: Map<string, string>) =>
  [AGE, ...interview.questions].filter((q) => !q.skipIf?.test(complaint) && meets(q.when, said));

const ask = (interview: Interview, q: Question, n: number, total: number, start: boolean, clarify = false): Step => ({
  kind: "ask",
  text: clarify ? `${CLARIFY}\n\n${q.q}` : start ? `${OPENING}\n\n${q.q}` : q.q,
  options: q.answers.map((x) => x.label),
  interview: { id: interview.id, q: q.id, n, total, ...(start ? { start } : {}), ...(clarify ? { clarify } : {}) },
});

export const nextStep = (history: Msg[], prompt: string): Step => {
  // warning signs come first, in any message
  const red = RED_FLAGS.find((r) => r.words.test(prompt));
  if (red) return { kind: "emergency", text: red.note || EMERGENCY };

  // the interview running now: the assistant's latest messages that carry
  // it, back to the one that opened it
  const run: number[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "assistant") continue;
    const meta = m.meta?.interview;
    if (!meta || (run.length && history[run[0]].meta?.interview?.id !== meta.id)) break;
    run.unshift(i);
    if (meta.start) break;
  }
  const lastMeta = run.length ? history[run[run.length - 1]].meta?.interview : undefined;
  let interview = lastMeta ? interviewById(lastMeta.id) : undefined;

  const start = (complaint: string): Step => {
    const found = asksAbout(complaint) ? undefined : interviewFor(complaint);
    if (!found) return { kind: "model" };
    const qs = plan(found, complaint, new Map());
    return ask(found, qs[0], 1, qs.length, true);
  };
  if (!interview || !lastMeta) return start(prompt);

  const current = [AGE, ...interview.questions].find((q) => q.id === lastMeta.q);
  // the patient named another complaint instead of answering: its interview
  const other = interviewFor(prompt);
  const anyAnswer = [AGE, ...interview.questions].some((q) => pickedAnswer(q, prompt));
  if (current && !anyAnswer && !unsure(prompt) && other && other.id !== interview.id && !interview.words.test(prompt))
    return start(prompt);

  // an unclear answer: the same question once more
  if (current && unsure(prompt) && !lastMeta.clarify) return ask(interview, current, lastMeta.n, lastMeta.total, false, true);

  // what the patient first said, and each question's answer (the last one
  // is this very message; a question asked again keeps its last answer)
  const complaint = history.slice(0, run[0]).filter((m) => m.role === "user").slice(-1)[0]?.content || "";
  const said = new Map<string, string>();
  run.forEach((i, k) => {
    const id = history[i].meta?.interview?.q;
    const text = k === run.length - 1 ? prompt : history[i + 1]?.role === "user" ? history[i + 1].content : "";
    if (id) said.set(id, text);
  });

  const all = [AGE, ...interview.questions];
  const flags: Flag[] = [];
  const unclear: string[] = [];
  for (const [id, text] of said) {
    const q = all.find((x) => x.id === id);
    if (!q) continue;
    const picked = pickedAnswer(q, text);
    if (picked?.flag) flags.push(picked.flag);
    if (unsure(text) && isWarning(q)) unclear.push(q.q);
    // an emergency sign typed to another question
    if (all.some((x) => x.answers.some((y) => y.flag === "emergency" && norm(y.label) === norm(text)))) flags.push("emergency");
  }
  for (const r of interview.rules || []) if (meets(r.when, said)) flags.push(r.flag);
  if (flags.includes("emergency")) return { kind: "emergency", text: interview.emergencyNote || EMERGENCY };

  const qs = plan(interview, complaint, said);
  const next = qs.find((q) => !said.has(q.id));
  if (next) return ask(interview, next, qs.filter((q) => said.has(q.id)).length + 1, qs.length, false);

  return {
    kind: "assess",
    interview,
    // a warning sign left unclear is not «no hurry»
    urgency: flags.includes("soon") || unclear.length ? "soon" : "routine",
    // what the specialist is chosen from: the complaint and every answer
    // that says yes to something, with its question («باردار ... بله»)
    patientText: [complaint, ...qs.filter((q) => said.has(q.id) && !NO.test(norm(said.get(q.id) || ""))).map((q) => `${q.q} ${said.get(q.id)}`)].join("\n"),
    answers: qs.filter((q) => said.has(q.id)).map((q) => ({ q: q.q, a: unsure(said.get(q.id) || "") ? "نامشخص" : (said.get(q.id) as string) })),
    unclear,
  };
};

// the model's brief for the assessment: the answers are in the chat above
export const assessmentBrief = (step: Extract<Step, { kind: "assess" }>) =>
  [
    "The site has asked its questions and the patient has answered (see the conversation above). Do not ask anything now.",
    "Write a short assessment in the patient's language with these parts, in this order:",
    "1. Possible causes: name one to three that fit the answers, as possibilities, never as a diagnosis; no percentages. Choose them from this list when they fit: " +
      step.interview.conditions.join("، ") +
      ". If telling them apart needs an examination or a test, say so.",
    "2. What to do and how soon (decided by the answers, not by the cause).",
    "3. Safe things to do at home that fit this complaint and the patient's age, with no prescription drugs or doses, and the signs that mean they should stop and see a doctor sooner.",
    "4. Which specialist to see.",
    step.urgency === "soon"
      ? "The answers include a warning sign or one left unclear: say they should see a doctor within the next few days, and use [[urgency: soon]]."
      : "Use [[urgency: routine]] unless the answers clearly need sooner care.",
    step.unclear.length ? `These were left unclear, so do not treat them as absent and mention the uncertainty: ${step.unclear.join(" / ")}` : "",
    "The patient's answers («نامشخص» = unclear):",
    ...step.answers.map((x) => `- ${x.q} → ${x.a}`),
  ]
    .filter(Boolean)
    .join("\n");
