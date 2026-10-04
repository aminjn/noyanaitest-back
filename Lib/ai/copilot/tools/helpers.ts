// Small helpers the copilot tools share.
import { currentLocale } from "../../../i18n/requestContext";
import { clinicalJson, SAFETY, str } from "../../panelAi";
import { replyLanguage } from "../../../../Services/panelAiFeatures";
import { ToolCtx, Txt } from "../types";

const INTL: Record<string, string> = { fa: "fa-IR", ar: "ar", ur: "ur", en: "en-US" };
export const intlTag = () => INTL[currentLocale()] || currentLocale();

export const money = (n: unknown) => new Intl.NumberFormat(intlTag()).format(Math.round(Number(n) || 0));
export const count = (n: unknown) => new Intl.NumberFormat(intlTag()).format(Number(n) || 0);
export const dateText = (d: unknown) => {
  if (!d) return "";
  const t = new Date(d as string);
  return isNaN(t.getTime()) ? "" : new Intl.DateTimeFormat(intlTag(), { dateStyle: "medium" }).format(t);
};
export const minutesText = (m: unknown) => {
  const n = Number(m);
  if (!Number.isFinite(n)) return "";
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
};

// "YYYY-MM-DD" of a Date in Tehran
export const ymd = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const isYmd = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// "17:30" / "1730" / "17" -> minutes of the day
export const toMinutes = (v: unknown): number | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(String(v).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2] || 0);
  return h < 24 && mm < 60 ? h * 60 + mm : null;
};

// a person's name out of the usual shapes
export const personName = (p: unknown): string => {
  const o = (p || {}) as Record<string, unknown>;
  const id = (o.identity || o) as Record<string, unknown>;
  return (
    [id.givenName || id.firstName, id.lastName].filter(Boolean).join(" ") ||
    String(o.name || o.username || o.phone || "")
  ).trim();
};

export const matches = (hay: string, query: string) => {
  const norm = (s: string) => s.replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/‌/g, " ").toLowerCase();
  const h = norm(hay);
  return norm(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => h.includes(w));
};

// one short paragraph about some data, in the reader's language (the
// "insight" pattern of Nexxa's api/ai/insight)
export const summarize = async (_ctx: ToolCtx, purpose: string, data: unknown) => {
  const obj = await clinicalJson(
    `${SAFETY}
${purpose}
Write in ${replyLanguage()}. Be short and concrete (at most 6 sentences or bullet lines). Use only the data given; say plainly when it is empty.
Never give a diagnosis or a treatment.
JSON shape: {"text": string}`,
    JSON.stringify(data).slice(0, 12000),
    { maxTokens: 900 },
  );
  return str(obj.text, 3000);
};

export const asArray = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

// a status as a translatable text (its Persian source)
const STATUS_FA: Record<string, Record<string, string>> = {
  copStatus: { pending: "در انتظار", active: "در حال برگزاری", completed: "انجام شد", cancelled: "لغو شد", noShow: "غیبت", error: "ناموفق" },
  copOrder: { pending: "در انتظار پرداخت", paid: "پرداخت شد", cancelled: "لغو شد" },
  copClaim: { draft: "پیش‌نویس", submitted: "ارسال شد", partial: "بخشی پرداخت شد", paid: "پرداخت شد", rejected: "رد شد" },
  copRun: { draft: "پیش‌نویس", posted: "ثبت شد" },
  copSession: { inPerson: "حضوری", phone: "تلفنی", voiceCall: "تماس صوتی", videoCall: "تماس تصویری", textChat: "گفتگوی متنی" },
  copTplCat: { general: "عمومی", recall: "یادآوری مراجعه", thanks: "تشکر", birthday: "تولد", noShow: "غیبت در نوبت", winback: "بازگرداندن بیمار", chronic: "بیماری مزمن" },
  copNet: { doctors: "پزشکان", clinics: "درمانگاه‌ها", hospitals: "بیمارستان‌ها", labs: "آزمایشگاه‌ها", pharmacies: "داروخانه‌ها" },
};
export const statusTxt = (group: keyof typeof STATUS_FA, status: string): Txt => ({
  k: `${group}_${status}`,
  fa: STATUS_FA[group]?.[status] || status,
});
