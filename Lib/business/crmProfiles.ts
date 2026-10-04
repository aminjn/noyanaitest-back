import { BizOwner } from "./coa";

// What the CRM sales side looks like for each kind of provider (2026-10,
// docs/nexxa-crm-parity.md in the frontend repo). Nexxa is the source of
// the features and their logic; each profile takes only what fits, with
// its own words, stages, fields and defaults:
//   doctor      a light pipeline, treatment plans, simple targets
//   clinic /    the full pipeline per department, staff assignment,
//   hospital    per-doctor targets and commission, corporate / insurer
//               contracts, discount and credit approvals
//   pharmacy    customers (not leads), credit limits, refill plans,
//               corporate supply contracts - no pipeline
//   paraClinic  referring doctors as a channel (tracked, never paid),
//               home-sampling requests, corporate check-up contracts
//   insurance   corporate deals, contracts and their members - no
//               patient pipeline
// Stored names are in SOURCE_LOCALE; a built-in one carries a key the
// panel shows in the reader's language until it is renamed.

export type Profile = "doctor" | "clinic" | "hospital" | "pharmacy" | "paraClinic" | "insurance";
export const profileOf = (owner: BizOwner): Profile =>
  (["doctor", "clinic", "hospital", "pharmacy", "paraClinic", "insurance"].includes(owner.kind) ? owner.kind : "clinic") as Profile;

type StageTpl = { key: string; name: string; probability: number };
export type PipelineTemplate = { key: string; name: string; stages: StageTpl[] };

const S = (key: string, name: string, probability: number): StageTpl => ({ key, name, probability });

// the pipeline templates a profile can start a pipeline from; the first is
// the one made on first use
export const PIPELINE_TEMPLATES: Record<Profile, PipelineTemplate[]> = {
  doctor: [{ key: "treatment", name: "قیف درمان", stages: [S("inquiry", "استعلام", 10), S("consult", "مشاوره", 40), S("plan", "طرح درمان", 70), S("done", "انجام شد", 100)] }],
  clinic: [
    {
      key: "treatment",
      name: "قیف درمان",
      stages: [S("inquiry", "استعلام", 10), S("consult", "مشاوره", 30), S("plan", "طرح درمان", 50), S("accepted", "پذیرش", 80), S("treatment", "در حال درمان", 90), S("done", "انجام شد", 100)],
    },
    { key: "surgery", name: "بسته‌ی جراحی", stages: [S("inquiry", "استعلام", 10), S("consult", "مشاوره", 30), S("preop", "آزمایش‌های پیش از عمل", 60), S("surgery", "عمل", 90), S("followup", "پیگیری پس از عمل", 100)] },
    { key: "checkup", name: "چکاپ سازمانی", stages: [S("inquiry", "استعلام", 10), S("quote", "پیشنهاد قیمت", 40), S("contract", "قرارداد", 70), S("scheduled", "زمان‌بندی", 85), S("done", "انجام شد", 100)] },
  ],
  hospital: [],
  pharmacy: [{ key: "sales", name: "قیف فروش", stages: [S("inquiry", "استعلام", 10), S("quote", "پیش‌فاکتور", 50), S("accepted", "پذیرش", 90)] }],
  paraClinic: [
    { key: "homeSampling", name: "نمونه‌گیری در منزل", stages: [S("request", "درخواست", 20), S("scheduled", "هماهنگی", 50), S("sampled", "نمونه‌گیری", 80), S("resultReady", "جواب آماده", 95), S("delivered", "تحویل جواب", 100)] },
    { key: "checkup", name: "چکاپ سازمانی", stages: [S("inquiry", "استعلام", 10), S("quote", "پیشنهاد قیمت", 40), S("contract", "قرارداد", 70), S("scheduled", "زمان‌بندی", 85), S("done", "انجام شد", 100)] },
  ],
  insurance: [
    { key: "corporate", name: "فروش سازمانی", stages: [S("inquiry", "استعلام", 10), S("needs", "نیازسنجی", 30), S("quote", "پیشنهاد قیمت", 50), S("negotiation", "مذاکره", 70), S("contract", "قرارداد", 90)] },
    { key: "renewal", name: "تمدید قرارداد", stages: [S("renewalDue", "سررسید تمدید", 30), S("contacted", "تماس گرفته شد", 50), S("quote", "پیشنهاد قیمت", 70), S("renewed", "تمدید شد", 100)] },
  ],
};
PIPELINE_TEMPLATES.hospital = PIPELINE_TEMPLATES.clinic;

export const pipelineTemplate = (owner: BizOwner, key?: string) => {
  const list = PIPELINE_TEMPLATES[profileOf(owner)];
  return list.find((t) => t.key === key) || list[0];
};

type SourceTpl = { system: string; name: string };
const SOURCES_CARE: SourceTpl[] = [
  { system: "instagram", name: "اینستاگرام" },
  { system: "referral", name: "معرفی بیمار" },
  { system: "website", name: "وب‌سایت" },
  { system: "phone", name: "تلفن" },
  { system: "webform", name: "فرم سایت" },
  { system: "noyan", name: "نویان" },
  { system: "walkIn", name: "مراجعه‌ی حضوری" },
  { system: "other", name: "سایر" },
];
export const SOURCE_TEMPLATES: Record<Profile, SourceTpl[]> = {
  doctor: SOURCES_CARE,
  clinic: SOURCES_CARE,
  hospital: [...SOURCES_CARE, { system: "insurer", name: "معرفی بیمه" }],
  pharmacy: [
    { system: "walkIn", name: "مراجعه‌ی حضوری" },
    { system: "phone", name: "تلفن" },
    { system: "noyan", name: "نویان" },
    { system: "other", name: "سایر" },
  ],
  paraClinic: [
    { system: "doctorReferral", name: "ارجاع پزشک" },
    { system: "webform", name: "فرم سایت" },
    { system: "phone", name: "تلفن" },
    { system: "noyan", name: "نویان" },
    { system: "walkIn", name: "مراجعه‌ی حضوری" },
    { system: "other", name: "سایر" },
  ],
  insurance: [
    { system: "broker", name: "معرفی کارگزار" },
    { system: "website", name: "وب‌سایت" },
    { system: "webform", name: "فرم سایت" },
    { system: "phone", name: "تلفن" },
    { system: "event", name: "نمایشگاه و رویداد" },
    { system: "other", name: "سایر" },
  ],
};

export const LOSS_TEMPLATES: Record<Profile, SourceTpl[]> = {
  doctor: [
    { system: "price", name: "هزینه‌ی بالا" },
    { system: "fear", name: "نگرانی از درمان" },
    { system: "competitor", name: "مرکز دیگر" },
    { system: "noAnswer", name: "پاسخ نداد" },
    { system: "notCandidate", name: "شرایط پزشکی مناسب نبود" },
  ],
  clinic: [],
  hospital: [],
  pharmacy: [
    { system: "price", name: "قیمت بالا" },
    { system: "outOfStock", name: "نبود کالا" },
    { system: "competitor", name: "داروخانه‌ی دیگر" },
  ],
  paraClinic: [
    { system: "price", name: "هزینه‌ی بالا" },
    { system: "competitor", name: "مرکز دیگر" },
    { system: "noAnswer", name: "پاسخ نداد" },
    { system: "outOfArea", name: "خارج از محدوده‌ی نمونه‌گیری" },
  ],
  insurance: [
    { system: "price", name: "حق بیمه‌ی بالا" },
    { system: "coverage", name: "پوشش ناکافی" },
    { system: "competitor", name: "بیمه‌گر دیگر" },
    { system: "noBudget", name: "نبود بودجه" },
  ],
};
LOSS_TEMPLATES.clinic = [...LOSS_TEMPLATES.doctor, { system: "timing", name: "زمان مناسب نبود" }];
LOSS_TEMPLATES.hospital = LOSS_TEMPLATES.clinic;

type FieldTpl = { entity: "contact" | "lead"; label: string; type: "text" | "textarea" | "number" | "date" | "select" | "checkbox"; options?: string[]; preset: string };
// the centre's own fields made on first use (renamed, switched off or
// deleted freely afterwards)
export const FIELD_PRESETS: Record<Profile, FieldTpl[]> = {
  doctor: [
    { entity: "contact", label: "سابقه‌ی بیماری", type: "textarea", preset: "history" },
    { entity: "contact", label: "حساسیت دارویی", type: "text", preset: "allergy" },
    { entity: "lead", label: "ناحیه‌ی درمان", type: "text", preset: "area" },
  ],
  clinic: [
    { entity: "contact", label: "شماره‌ی پرونده", type: "text", preset: "fileNo" },
    { entity: "contact", label: "حساسیت دارویی", type: "text", preset: "allergy" },
    { entity: "lead", label: "نوع پذیرش", type: "select", options: ["سرپایی", "بستری"], preset: "admission" },
  ],
  hospital: [
    { entity: "contact", label: "شماره‌ی پرونده", type: "text", preset: "fileNo" },
    { entity: "contact", label: "حساسیت دارویی", type: "text", preset: "allergy" },
    { entity: "lead", label: "نوع پذیرش", type: "select", options: ["سرپایی", "بستری", "اورژانس"], preset: "admission" },
    { entity: "lead", label: "نیاز به اتاق خصوصی", type: "checkbox", preset: "privateRoom" },
  ],
  pharmacy: [
    { entity: "contact", label: "بیماری مزمن", type: "text", preset: "chronic" },
    { entity: "contact", label: "داروهای مصرفی دائم", type: "textarea", preset: "regularDrugs" },
    { entity: "contact", label: "بیمه‌ی تکمیلی", type: "text", preset: "supplementary" },
  ],
  paraClinic: [
    { entity: "contact", label: "ناشتا", type: "checkbox", preset: "fasting" },
    { entity: "lead", label: "آدرس نمونه‌گیری", type: "textarea", preset: "address" },
    { entity: "lead", label: "زمان ترجیحی", type: "text", preset: "preferredTime" },
    { entity: "lead", label: "آزمایش‌های درخواستی", type: "textarea", preset: "tests" },
  ],
  insurance: [
    { entity: "contact", label: "نام شرکت", type: "text", preset: "company" },
    { entity: "contact", label: "کد پرسنلی", type: "text", preset: "staffNo" },
    { entity: "contact", label: "نسبت با بیمه‌شده‌ی اصلی", type: "select", options: ["اصلی", "همسر", "فرزند", "والدین"], preset: "relation" },
    { entity: "lead", label: "تعداد کارکنان", type: "number", preset: "headcount" },
  ],
};
