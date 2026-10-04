import BizQuiz, { IBizQuiz, IBizQuizQuestion } from "../../../Models/BizQuiz";
import BizQuizAssignment, { IBizQuizAssignment } from "../../../Models/BizQuizAssignment";
import BizQuizAttempt, { IBizQuizAttempt } from "../../../Models/BizQuizAttempt";
import { BizOwner } from "../coa";
import { own, team } from "./common";

// Staff quizzes (2026-10), nexxacrm's crm/knowledge/quizzes and
// lib/quiz-tracking.ts: marked on the server - the right answers never
// leave it - and who of the team passed, tried or has not taken each.

// ---------------------------------------------------------------- pure

const sameSet = (a: number[], b: number[]) => {
  const x = Array.from(new Set(a)).sort();
  const y = Array.from(new Set(b)).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

// a question is right only when exactly the right options were chosen
export const gradeQuiz = (questions: Pick<IBizQuizQuestion, "correct" | "options">[], answers: number[][], passScore: number) => {
  const total = questions.length;
  let correct = 0;
  questions.forEach((q, i) => {
    const a = Array.isArray(answers?.[i]) ? answers[i].filter((n) => Number.isInteger(n) && n >= 0 && n < q.options.length) : [];
    if (q.correct.length && sameSet(a, q.correct)) correct++;
  });
  const score = total ? Math.round((correct / total) * 100) : 0;
  return { correctCount: correct, total, score, passed: total > 0 && score >= passScore };
};

// the quiz as someone taking it sees it
export const forTaker = (q: IBizQuiz) => ({
  _id: q._id,
  title: q.title,
  description: q.description,
  passScore: q.passScore,
  article: q.article,
  questions: q.questions.map((x) => ({ _id: x._id, text: x.text, options: x.options, multi: x.correct.length > 1 })),
});

// the earliest due date wins when a person has several assignments
const earlier = (a?: Date | null, b?: Date | null) => (!a ? b ?? null : !b ? a : a < b ? a : b);

// ---------------------------------------------------------------- status

export type AssignedStatus = { userId: string; name: string; status: "passed" | "attempted" | "pending"; bestScore: number | null; dueDate: Date | null };

export const quizAssignedStatus = async (owner: BizOwner, quizId: unknown): Promise<AssignedStatus[]> => {
  const assignments = await BizQuizAssignment.find({ ...own(owner), quiz: quizId }).lean<IBizQuizAssignment[]>();
  if (!assignments.length) return [];
  const members = await team(owner);
  const due = new Map<string, Date | null>();
  for (const a of assignments) {
    const who = a.scope === "all" ? members.map((m) => m._id) : a.user ? [String(a.user)] : [];
    for (const u of who) due.set(u, due.has(u) ? earlier(due.get(u), a.dueDate) : a.dueDate || null);
  }
  const ids = [...due.keys()];
  const attempts = await BizQuizAttempt.find({ ...own(owner), quiz: quizId, user: { $in: ids } }).select("user score passed").lean<IBizQuizAttempt[]>();
  const best = new Map<string, number>();
  const passed = new Set<string>();
  for (const at of attempts) {
    const u = String(at.user);
    if (at.passed) passed.add(u);
    best.set(u, Math.max(best.get(u) ?? -1, at.score));
  }
  const rank = { pending: 0, attempted: 1, passed: 2 };
  return ids
    .map((u) => ({
      userId: u,
      name: members.find((m) => m._id === u)?.name || "",
      status: (passed.has(u) ? "passed" : best.has(u) ? "attempted" : "pending") as AssignedStatus["status"],
      bestScore: best.has(u) ? best.get(u)! : null,
      dueDate: due.get(u) || null,
    }))
    .sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
};

// the quizzes given to this person, with their nearest due date
export const myQuizzes = async (owner: BizOwner, user: string) => {
  const assignments = await BizQuizAssignment.find({ ...own(owner), $or: [{ scope: "all" }, { scope: "user", user }] }).lean<IBizQuizAssignment[]>();
  const due = new Map<string, Date | null>();
  for (const a of assignments) {
    const k = String(a.quiz);
    due.set(k, due.has(k) ? earlier(due.get(k), a.dueDate) : a.dueDate || null);
  }
  return due;
};

export { BizQuiz };
