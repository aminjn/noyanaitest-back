// The doctor's assistant: the day's schedule, patients, their history,
// desk bookings and moves, and the voice prescription writer.
import { z } from "zod";
import * as doctorController from "../../../../Controllers/doctorController";
import { patientSummary } from "../../../../Services/panelAiFeatures";
import { invoke, registerCopilotTool } from "../registry";
import { ToolCtx, txt } from "../types";
import { asArray, dateText, isYmd, matches, minutesText, personName, toMinutes, ymd, statusTxt } from "./helpers";

type Res = {
  _id: string;
  date: string;
  start: number;
  end: number;
  status: string;
  sessionType: string;
  patient?: { givenName?: string; lastName?: string; nationalId?: string };
  user?: { phone?: string; username?: string };
  office?: { name?: string };
};
type Patient = {
  _id: string;
  user?: { phone?: string; username?: string; identity?: { givenName?: string; lastName?: string; nationalId?: string } };
  stats?: { visits?: number; lastVisit?: string | null; nextVisit?: string | null };
};

const localDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const schedule = async (ctx: ToolCtx) =>
  asArray<Res>((await invoke<{ reservations?: Res[] }>(doctorController.getMySchedule, ctx.req))?.reservations);
const patients = async (ctx: ToolCtx) => asArray<Patient>(await invoke(doctorController.getMyPatients, ctx.req));
const patientLabel = (p: Patient) => personName(p.user) || p.user?.phone || "";
const findPatients = async (ctx: ToolCtx, query: string) => {
  const all = await patients(ctx);
  const qy = query.trim();
  if (!qy) return all.slice(0, 8);
  return all.filter((p) =>
    matches(`${patientLabel(p)} ${p.user?.phone || ""} ${p.user?.identity?.nationalId || ""}`, qy),
  );
};
const SESSION_TYPES = ["inPerson", "phone", "voiceCall", "videoCall", "textChat"];

registerCopilotTool({
  name: "today_schedule",
  profiles: ["doctor"],
  kind: "read",
  description: "The visits of a day (today by default): who, when, which type, status.",
  args: '{"date": "YYYY-MM-DD"}',
  schema: z.object({ date: z.string().max(10).optional() }),
  acl: "readSchedule",
  module: "schedule",
  run: async (ctx, args) => {
    const dayStr = isYmd(args.date) ? args.date : ymd();
    const from = localDay(dayStr).getTime();
    const list = (await schedule(ctx))
      .filter((r) => {
        const t = new Date(r.date).getTime();
        return t >= from && t < from + 864e5 && r.status !== "cancelled";
      })
      .sort((a, b) => a.start - b.start);
    return {
      type: "list",
      title: txt("copDaySchedule", "نوبت‌های ${1}", [dateText(localDay(dayStr))]),
      rows: list.map((r) => ({
        title: `${minutesText(r.start)} · ${personName(r.patient) || r.user?.phone || ""}`,
        sub: r.office?.name || "",
        badge: statusTxt("copStatus", r.status),
        link: `${ctx.panel}/booking/${r._id}`,
      })),
      empty: txt("copNoVisits", "نوبتی در این روز نیست"),
      link: `${ctx.panel}/schedule`,
    };
  },
});

registerCopilotTool({
  name: "find_patient",
  profiles: ["doctor"],
  kind: "read",
  description: "Find the doctor's patients by name, phone or national id.",
  args: '{"query": string}',
  schema: z.object({ query: z.string().max(100) }),
  acl: "readPatients",
  module: "patients",
  run: async (ctx, args) => {
    const found = await findPatients(ctx, String(args.query || ""));
    return {
      type: "list",
      title: txt("copPatientsFound", "بیماران پیدا شده"),
      rows: found.slice(0, 10).map((p) => ({
        title: patientLabel(p),
        sub: [p.user?.phone, p.stats?.lastVisit ? dateText(p.stats.lastVisit) : ""].filter(Boolean).join(" · "),
        link: `${ctx.panel}/patient/${p._id}`,
      })),
      empty: txt("copNothingFound", "چیزی پیدا نشد"),
      link: `${ctx.panel}/patient`,
    };
  },
});

registerCopilotTool({
  name: "open_patient",
  profiles: ["doctor"],
  kind: "navigate",
  description: "Open one patient's file by name, phone or national id.",
  args: '{"query": string}',
  schema: z.object({ query: z.string().min(1).max(100) }),
  acl: "readPatient",
  module: "patients",
  run: async (ctx, args) => {
    const found = await findPatients(ctx, String(args.query || ""));
    if (found.length === 1) return { type: "navigate", path: `${ctx.panel}/patient/${found[0]._id}` };
    return {
      type: "list",
      title: txt("copPatientsFound", "بیماران پیدا شده"),
      rows: found.slice(0, 10).map((p) => ({ title: patientLabel(p), sub: p.user?.phone, link: `${ctx.panel}/patient/${p._id}` })),
      empty: txt("copNothingFound", "چیزی پیدا نشد"),
    };
  },
});

registerCopilotTool({
  name: "patient_summary",
  aiFeature: "clinical.patientSummary",
  profiles: ["doctor"],
  kind: "read",
  description: "Summarize one patient's history with this doctor (visits, notes, questionnaires). Owner only.",
  args: '{"query": string (patient name / phone)}',
  schema: z.object({ query: z.string().min(1).max(100) }),
  acl: "owner",
  module: "patients",
  run: async (ctx, args) => {
    const found = await findPatients(ctx, String(args.query || ""));
    if (!found.length) return { type: "message", text: txt("copNothingFound", "چیزی پیدا نشد") };
    const s = await patientSummary(ctx.req.doctor?._id, found[0]._id);
    if (!s) return { type: "message", text: txt("copNothingFound", "چیزی پیدا نشد") };
    const lines = [
      s.summary,
      s.problems.length ? `• ${s.problems.join("، ")}` : "",
      s.medications.length ? `💊 ${s.medications.join("، ")}` : "",
      s.allergies.length ? `⚠ ${s.allergies.join("، ")}` : "",
    ].filter(Boolean);
    return {
      type: "insight",
      title: txt("copPatientSummary", "خلاصه‌ی پرونده‌ی ${1}", [patientLabel(found[0])]),
      text: lines.join("\n"),
      link: `${ctx.panel}/patient/${found[0]._id}`,
    };
  },
});

registerCopilotTool({
  name: "book_appointment",
  profiles: ["doctor"],
  kind: "write",
  description: "Prepare a desk / phone booking for a patient on a day (and preferred time).",
  args: '{"phone": string, "nationalId": string, "birthDate": "YYYY-MM-DD", "date": "YYYY-MM-DD", "time": "HH:MM", "sessionType": "inPerson"|"phone"|"voiceCall"|"videoCall"|"textChat"}',
  schema: z.object({
    phone: z.string().max(20).optional(),
    nationalId: z.string().max(12).optional(),
    birthDate: z.string().max(10).optional(),
    date: z.string().max(10).optional(),
    time: z.string().max(5).optional(),
    sessionType: z.string().max(20).optional(),
  }),
  acl: "mutateCalendar",
  module: "schedule",
  run: async (ctx, args) => {
    const sessionType = SESSION_TYPES.includes(String(args.sessionType)) ? String(args.sessionType) : "inPerson";
    return {
      type: "confirm",
      title: txt("copNewBooking", "نوبت تازه (پذیرش)"),
      fields: [
        {
          key: "sessionType",
          label: txt("copFieldVisitType", "نوع ویزیت"),
          type: "select",
          value: sessionType,
          options: SESSION_TYPES.map((t) => ({ value: t, label: statusTxt("copSession", t) })),
        },
        {
          key: "slot",
          label: txt("copFieldSlot", "زمان نوبت"),
          type: "slot",
          required: true,
          value: { date: isYmd(args.date) ? args.date : ymd(), start: toMinutes(args.time) },
          slot: { sessionTypeField: "sessionType" },
        },
        { key: "phone", label: txt("copFieldPhone", "موبایل بیمار"), type: "text", required: true, value: String(args.phone || "") },
        { key: "nationalId", label: txt("copFieldNationalId", "کد ملی"), type: "text", required: true, value: String(args.nationalId || "") },
        { key: "birthDate", label: txt("copFieldBirthDate", "تاریخ تولد"), type: "date", required: true, value: isYmd(args.birthDate) ? args.birthDate : "" },
      ],
      request: { method: "POST", path: "/doctor/desk/reservation" },
      link: `${ctx.panel}/schedule`,
      done: txt("copBooked", "نوبت ثبت شد"),
    };
  },
});

registerCopilotTool({
  name: "reschedule_appointment",
  profiles: ["doctor"],
  kind: "write",
  description: "Prepare moving a patient's upcoming visit to another day / time.",
  args: '{"patient": string (name or phone), "date": "YYYY-MM-DD", "time": "HH:MM"}',
  schema: z.object({ patient: z.string().max(100).optional(), date: z.string().max(10).optional(), time: z.string().max(5).optional() }),
  acl: "mutateCalendar",
  module: "schedule",
  run: async (ctx, args) => {
    const today = localDay(ymd()).getTime();
    const qy = String(args.patient || "");
    const upcoming = (await schedule(ctx))
      .filter((r) => r.status === "pending" && new Date(r.date).getTime() >= today)
      .filter((r) => !qy || matches(`${personName(r.patient)} ${r.user?.phone || ""}`, qy))
      .slice(0, 10);
    if (!upcoming.length) return { type: "message", text: txt("copNoUpcoming", "نوبت آینده‌ای برای جابه‌جایی پیدا نشد") };
    return {
      type: "confirm",
      title: txt("copMoveVisit", "جابه‌جایی نوبت"),
      fields: [
        {
          key: "reservation",
          label: txt("copFieldVisit", "نوبت"),
          type: "select",
          required: true,
          value: upcoming[0]._id,
          options: upcoming.map((r) => ({
            value: r._id,
            label: `${personName(r.patient) || r.user?.phone || ""} · ${dateText(r.date)} ${minutesText(r.start)}`,
          })),
        },
        {
          key: "slot",
          label: txt("copFieldNewSlot", "زمان تازه"),
          type: "slot",
          required: true,
          value: { date: isYmd(args.date) ? args.date : ymd(new Date(Date.now() + 864e5)), start: toMinutes(args.time) },
          slot: { sessionType: upcoming[0].sessionType, exceptField: "reservation" },
        },
      ],
      request: { method: "POST", path: "/doctor/reservation/{reservation}/move" },
      link: `${ctx.panel}/schedule`,
      done: txt("copMoved", "نوبت جابه‌جا شد و به بیمار خبر داده شد"),
    };
  },
});

registerCopilotTool({
  name: "write_prescription",
  // opens the writer with the text; its parse counts it (/ai/doctor/rx/parse)
  aiFeature: "clinical.rx",
  aiCounted: true,
  profiles: ["doctor"],
  kind: "navigate",
  description: "Open the prescription writer and fill it from the dictated medicines (e.g. 'amoxicillin 500 every 8 hours for 7 days'). The doctor reviews and signs.",
  args: '{"text": string (the medicines exactly as said)}',
  schema: z.object({ text: z.string().max(4000).optional() }),
  acl: "owner",
  module: "drugsAndPrescriptions",
  run: async (ctx, args) => ({
    type: "navigate",
    path: `${ctx.panel}/prescription${args.text ? `?rx=${encodeURIComponent(String(args.text))}` : ""}`,
    title: txt("copRxOpen", "نسخه‌نویس باز شد؛ داروها را بررسی و امضا کنید"),
  }),
});
