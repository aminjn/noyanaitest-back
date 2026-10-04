// The AI spots in the provider panels (2026-10), each a draft for a person
// to check - ported where they map from Nexxa's AI (src/lib/ai.ts,
// app/api/ai/*, lib/call-ai.ts) and grounded in NoyanAI's own data:
//   chat reply suggestions + thread summary   (Nexxa insight "chat")
//   patient history summary                   (Nexxa insight "contact")
//   SMS template from a goal                  (Nexxa api/ai/campaign)
//   CRM "action plan for today"               (Nexxa crm/copilot)
//   one contact's insight + follow-up draft   (Nexxa insight "contact"/"lead")
//   phone-call analysis                       (Nexxa call-ai analyzeCallCore)
// All on the clinical provider (Lib/ai/panelAi.ts); the answer comes in the
// reader's language.
import mongoose from "mongoose";
import { currentLocale } from "../Lib/i18n/requestContext";
import { clinicalJson, num, SAFETY, str, strList } from "../Lib/ai/panelAi";
import Chat from "../Models/Chat";
import Message from "../Models/Message";
import DoctorPatient from "../Models/DoctorPatient";
import Reservation from "../Models/Reservation";
import VisitNote from "../Models/VisitNote";
import VisitIntake from "../Models/VisitIntake";
import MedicalDetail from "../Models/MedicalDetail";
import UserIdentity from "../Models/UserIdentity";
import BizContact from "../Models/BizContact";
import BizActivity from "../Models/BizActivity";
import { BizOwner } from "../Lib/business/coa";
import { own } from "../Lib/business/crm";

const LANGS: Record<string, string> = {
  fa: "Persian", en: "English", ar: "Arabic", zh: "Chinese", hi: "Hindi", es: "Spanish", fr: "French", ru: "Russian",
  pt: "Portuguese", de: "German", tr: "Turkish", ur: "Urdu", bn: "Bengali", id: "Indonesian", ja: "Japanese",
};
export const replyLanguage = () => LANGS[currentLocale()] || "Persian";

const day = (d?: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

// ---------------- chat ----------------

// Suggested replies for the doctor (or the secretary answering for the
// doctor) in a patient chat, and a one-line summary of the thread.
export const chatSuggestions = async (chatId: string, actor: mongoose.Types.ObjectId | string) => {
  if (!mongoose.isValidObjectId(chatId)) return null;
  const chat = await Chat.findOne({ _id: chatId, participants: actor }).select("_id").lean();
  if (!chat) return null;
  const messages = await Message.find({ chat: chatId }).sort({ createdAt: -1 }).limit(20).select("sender message createdAt").lean();
  const lines = messages
    .reverse()
    .filter((m) => m.message)
    .map((m) => `${String(m.sender) === String(actor) ? "DOCTOR" : "PATIENT"}: ${String(m.message).slice(0, 600)}`);
  if (!lines.length) return { summary: "", suggestions: [] as string[] };
  const obj = await clinicalJson(
    `${SAFETY}
You help a doctor answer a patient's chat message. Write in ${replyLanguage()}.
Suggest up to 3 short, polite replies the doctor could send next (each under 300 characters). Never diagnose or prescribe in a suggestion;
when the patient describes an emergency sign, one suggestion must tell them to call emergency services or come in.
Also give a one-sentence summary of the thread.
JSON shape: {"summary": string, "suggestions": string[]}`,
    lines.join("\n"),
    { maxTokens: 800 },
  );
  return { summary: str(obj.summary, 500), suggestions: strList(obj.suggestions, 400, 3) };
};

// ---------------- patient history ----------------

export const patientSummary = async (doctorId: unknown, doctorPatientId: string) => {
  if (!mongoose.isValidObjectId(doctorPatientId)) return null;
  const dp = await DoctorPatient.findOne({ _id: doctorPatientId, doctor: doctorId }).select("user").lean<{ user?: unknown }>();
  if (!dp?.user) return null;
  const reservations = await Reservation.find({ doctor: doctorId, user: dp.user })
    .sort({ date: -1 })
    .limit(15)
    .select("date status sessionType patient")
    .lean<{ _id: unknown; date: Date; status: string; sessionType: string }[]>();
  const ids = reservations.map((r) => r._id);
  // nothing to read: no model call, nothing made up
  if (!reservations.length)
    return { summary: "", problems: [], medications: [], allergies: [], openItems: [], sources: { visits: 0, notes: 0, intakes: 0 } };
  const [notes, intakes, medical, identity] = await Promise.all([
    VisitNote.find({ reservation: { $in: ids } }).select("reservation subjective assessment plan patientInstructions updatedAt").lean(),
    VisitIntake.find({ reservation: { $in: ids } }).select("reservation complaint conditions medications allergies redFlags updatedAt").lean(),
    MedicalDetail.findOne({ user: dp.user }).select("height weight bloodType").lean(),
    UserIdentity.findOne({ user: dp.user }).select("gender dateOfbirth").lean<{ gender?: string; dateOfbirth?: Date }>(),
  ]);
  const noteOf = new Map(notes.map((n) => [String(n.reservation), n]));
  const intakeOf = new Map(intakes.map((n) => [String(n.reservation), n]));
  const visits = reservations.map((r) => {
    const n = noteOf.get(String(r._id));
    const i = intakeOf.get(String(r._id));
    return {
      date: day(r.date),
      status: r.status,
      type: r.sessionType,
      complaint: i?.complaint || undefined,
      conditions: i?.conditions?.length ? i.conditions : undefined,
      medications: i?.medications || undefined,
      allergies: i?.allergies || undefined,
      note: n ? { s: n.subjective, a: n.assessment, p: n.plan } : undefined,
    };
  });
  const age = identity?.dateOfbirth ? Math.floor((Date.now() - new Date(identity.dateOfbirth).getTime()) / (365.25 * 864e5)) : null;
  const obj = await clinicalJson(
    `${SAFETY}
Summarize this patient's history with the physician for a quick look before a visit. Write in ${replyLanguage()}.
Use only the data given. 3-5 sentence summary, then the lists. Do not suggest a diagnosis or treatment.
JSON shape: {"summary": string, "problems": string[], "medications": string[], "allergies": string[], "openItems": string[]}`,
    JSON.stringify({ age, gender: identity?.gender, medical, visits }).slice(0, 12000),
    { maxTokens: 1200 },
  );
  return {
    summary: str(obj.summary, 2000),
    problems: strList(obj.problems, 200, 8),
    medications: strList(obj.medications, 200, 10),
    allergies: strList(obj.allergies, 200, 6),
    openItems: strList(obj.openItems, 300, 6),
    sources: { visits: reservations.length, notes: notes.length, intakes: intakes.length },
  };
};

// ---------------- CRM ----------------

const CATEGORIES = ["general", "recall", "thanks", "birthday", "noShow", "winback", "chronic"];

// An SMS template text from a goal ("remind diabetic patients to come for
// their 3-month check"), with the CRM's variables and Iran's SMS rules.
export const crmTemplateText = async (goal: string, orgName: string) => {
  const obj = await clinicalJson(
    `${SAFETY}
Write one SMS template for a healthcare practice in Iran named "${orgName}". Write the SMS in ${replyLanguage()}.
Rules: at most 2 short sentences, under 140 characters if possible, friendly and respectful, one clear call to action.
You may use these variables exactly as written: {name} (patient name), {firstName}, {org} (practice name), {link} (booking link), {lastVisit}.
No medical claims, no diagnosis, no prices you were not given. Do not add the opt-out text (it is added automatically).
Also give a short template name and the best category from: ${CATEGORIES.join(", ")}.
JSON shape: {"name": string, "category": string, "text": string}`,
    `Goal: ${goal.slice(0, 600)}`,
    { maxTokens: 500 },
  );
  const category = CATEGORIES.includes(String(obj.category)) ? String(obj.category) : "general";
  return { name: str(obj.name, 80) || goal.slice(0, 60), category, text: str(obj.text, 700) };
};

// The CRM "action plan for today" (Nexxa crm/copilot): due follow-ups,
// patients due a recall, recent no-shows and birthdays, prioritised.
export const crmActionPlan = async (owner: BizOwner) => {
  const now = new Date();
  const soon = new Date(now.getTime() + 864e5);
  const recall = new Date(now.getTime() - 180 * 864e5);
  const [due, recalls, noShows, totals] = await Promise.all([
    BizActivity.find({ ...own(owner), kind: "followUp", doneAt: { $exists: false }, dueAt: { $lte: soon } })
      .sort({ dueAt: 1 })
      .limit(15)
      .populate({ path: "contact", select: "name phone" })
      .lean(),
    BizContact.find({ ...own(owner), isActive: { $ne: false }, lastVisitAt: { $lte: recall } })
      .sort({ lastVisitAt: -1 })
      .limit(10)
      .select("name lastVisitAt visits")
      .lean(),
    BizContact.find({ ...own(owner), lastNoShowAt: { $gte: new Date(now.getTime() - 14 * 864e5) } })
      .limit(10)
      .select("name lastNoShowAt noShows")
      .lean(),
    BizContact.countDocuments({ ...own(owner) }),
  ]);
  const data = {
    contacts: totals,
    followUpsDue: due.map((a) => ({
      who: (a.contact as unknown as { name?: string })?.name,
      text: a.text,
      due: day(a.dueAt as Date | undefined),
      overdue: !!a.dueAt && new Date(a.dueAt as Date) < now,
    })),
    recallCandidates: recalls.map((c) => ({ who: c.name, lastVisit: day(c.lastVisitAt), visits: c.visits })),
    recentNoShows: noShows.map((c) => ({ who: c.name, when: day(c.lastNoShowAt), count: c.noShows })),
  };
  const obj = await clinicalJson(
    `${SAFETY}
You are the patient-relations assistant of a healthcare practice. From the data, write today's action plan in ${replyLanguage()}:
prioritised, concrete, short. Overdue follow-ups first, then recent no-shows to call back, then recall candidates. If the data is empty, say so.
JSON shape: {"plan": string, "actions": string[]}`,
    JSON.stringify(data).slice(0, 10000),
    { maxTokens: 900 },
  );
  return {
    plan: str(obj.plan, 3000),
    actions: strList(obj.actions, 300, 10),
    counts: { followUps: due.length, recalls: recalls.length, noShows: noShows.length },
  };
};

// One CRM contact: a short read of the relationship and a follow-up draft.
export const contactInsight = async (owner: BizOwner, contactId: string) => {
  if (!mongoose.isValidObjectId(contactId)) return null;
  const contact = await BizContact.findOne({ ...own(owner), _id: contactId }).select("-optCode").lean();
  if (!contact) return null;
  const acts = await BizActivity.find({ ...own(owner), contact: contactId }).sort({ createdAt: -1 }).limit(20).select("kind text dueAt doneAt createdAt").lean();
  const obj = await clinicalJson(
    `${SAFETY}
Read this patient/customer record of a healthcare practice's CRM and write in ${replyLanguage()}:
a 2-3 sentence summary of the relationship, the best next action, and a short polite follow-up SMS draft (no medical advice).
JSON shape: {"summary": string, "nextAction": string, "message": string}`,
    JSON.stringify({
      name: contact.name,
      visits: contact.visits,
      orders: contact.orders,
      noShows: contact.noShows,
      lastVisit: day(contact.lastVisitAt),
      lastSeen: day(contact.lastSeenAt),
      tags: contact.tags,
      note: contact.note,
      activities: acts.map((a) => ({ kind: a.kind, text: a.text, due: day(a.dueAt as Date | undefined), done: !!a.doneAt, at: day(a.createdAt as Date) })),
    }).slice(0, 8000),
    { maxTokens: 700 },
  );
  return {
    contact: { _id: String(contact._id), name: contact.name, phone: contact.phone },
    summary: str(obj.summary, 1500),
    nextAction: str(obj.nextAction, 400),
    message: str(obj.message, 500),
  };
};

// ---------------- calls ----------------

// A phone call at the practice (reception or a phone consultation), from
// its transcript (Nexxa analyzeCallCore, re-aimed: patient request, urgency
// and service quality instead of sales objections). Nothing is stored.
export const analyzeCall = async (transcript: string) => {
  const obj = await clinicalJson(
    `${SAFETY}
Analyse this phone call between a healthcare practice (reception, nurse or doctor) and a patient. Write in ${replyLanguage()}.
Flag "urgent" true only if the patient described an emergency sign (chest pain, breathing trouble, stroke signs, heavy bleeding, suicidal thoughts).
JSON shape: {"summary": string, "reason": string, "requests": string[], "sentiment": "positive"|"neutral"|"negative", "sentimentScore": number (-1..1),
"urgent": boolean, "qualityScore": integer 0-100 (how well the practice handled the call), "strengths": string[], "improvements": string[],
"nextAction": string, "followUpText": string (a short task for the CRM, empty if none), "followUpInDays": integer|null, "tags": string[]}`,
    `Transcript:\n${transcript.slice(0, 12000)}`,
    { maxTokens: 1500 },
  );
  const sentiment = ["positive", "neutral", "negative"].includes(String(obj.sentiment)) ? String(obj.sentiment) : "neutral";
  const clamp = (v: unknown, lo: number, hi: number) => {
    const n = num(v);
    return n === null ? null : Math.min(hi, Math.max(lo, n));
  };
  return {
    summary: str(obj.summary, 2000),
    reason: str(obj.reason, 300),
    requests: strList(obj.requests, 300, 8),
    sentiment,
    sentimentScore: clamp(obj.sentimentScore, -1, 1),
    urgent: obj.urgent === true,
    qualityScore: clamp(obj.qualityScore, 0, 100),
    strengths: strList(obj.strengths, 300, 6),
    improvements: strList(obj.improvements, 300, 6),
    nextAction: str(obj.nextAction, 400),
    followUpText: str(obj.followUpText, 500),
    followUpInDays: clamp(obj.followUpInDays, 0, 365),
    tags: strList(obj.tags, 60, 8),
  };
};
