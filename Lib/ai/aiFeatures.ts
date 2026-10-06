// The AI feature registry (2026-10, owner decision): every AI entry point of
// NoyanAI in one list, so the super admin can make each one free, sold by
// plan or off, and give it its own limits («سیاست هوش مصنوعی», system
// settings -> AI; Lib/ai/aiPolicy.ts). The one enforcement function is
// checkAndConsumeAi (Lib/ai/aiGate.ts); every route, background job and
// copilot tool that calls a model names its feature here.
//
// Benchmark (docs/market-benchmark.md): Doctolib sells its consultation
// assistant as a paid add-on of Doctolib Pro; K Health and Ada keep the
// symptom checker free with limits; QuickBooks Intuit Assist, Canva and
// Notion give each plan its AI credits and limit each AI feature on its
// own. NoyanAI copies the per-feature switch and limits, keeps the
// patient's assistant free with a daily allowance (Pro raises it), sells
// the clinical tools by plan, and keeps the platform's own content tools
// (translation, medical texts) outside the paywall with a budget of their
// own.
//
// Nothing here names a model: which provider and model serve a feature is
// Lib/aiSettings.ts (clinical, translation, speech-to-text).

import type { LicenseKind } from "../licenseQuote";

// the provider kinds (Lib/licenseQuote.ts licenseKindList; kept here so the
// registry loads without the plan models)
const licenseKindList: readonly LicenseKind[] = ["doctor", "clinic", "hospital", "pharmacy", "paraClinic", "insurance"];

// who uses a feature: a patient (any signed-in user on their own
// dashboard), a provider panel (doctor or an organisation kind), the
// platform's staff (the admin panel copilot) or the super admin's content
// tools (platform-internal, never behind the user-facing paywall)
export type AiAudience = LicenseKind | "patient" | "staff" | "admin";
export const aiAudiences: readonly AiAudience[] = [...licenseKindList, "patient", "staff", "admin"];
export const providerAudiences: readonly LicenseKind[] = licenseKindList;
export const isProviderAudience = (a: string): a is LicenseKind => (licenseKindList as readonly string[]).includes(a);
export const userFacingAudiences: readonly AiAudience[] = [...licenseKindList, "patient"];

export const aiGroups = ["assistant", "clinical", "crm", "finance", "content"] as const;
export type AiGroup = (typeof aiGroups)[number];

// what one use costs: a request, or a started minute of audio (speech to
// text)
export type AiUnit = "request" | "minute";

export const aiAccessModes = ["free", "plan", "off"] as const;
export type AiAccess = (typeof aiAccessModes)[number];

// a limit set: per user per day, per user per month (Jalali), per
// organisation per month; 0 = unlimited
export type AiLimitSet = { day: number; month: number; orgMonth: number };

export type AiFeatureDef = {
  key: string;
  group: AiGroup;
  audiences: AiAudience[];
  unit: AiUnit;
  // Persian title and description for the admin (ta() in the admin panel)
  title: string;
  description: string;
  // the default policy, chosen so nothing changes for anyone until the
  // super admin edits it (see each entry's comment)
  defaults: {
    access: AiAccess;
    // plan modules that unlock it ("paid" tier), per provider kind
    modules: Partial<Record<LicenseKind, string[]>>;
    // an active patient Pro membership unlocks it
    pro: boolean;
    // free / paid tier limits; `legacy` = AppConfig.panelAiDailyLimit (the
    // old single per-user daily cap, 200), "patientFree" / "patientPro" =
    // PatientProPlan.freeAiDailyLimit / proAiDailyLimit
    day: { free: number | "legacy" | "patientFree"; paid: number | "legacy" | "patientPro" };
  };
  // the counter name this feature had in PanelAiUsage.features (today's
  // counts are carried over once, Lib/migrateAiPolicy.ts)
  legacy?: string[];
};

// the module that opened panel AI until 2026-10 (Lib/ai/panelAi.ts
// PLAN_MODULE): the doctor's AI scribe module, an organisation's CRM
const PANEL_MODULES: Partial<Record<LicenseKind, string[]>> = {
  doctor: ["aiAssistant"],
  clinic: ["crm"],
  hospital: ["crm"],
  pharmacy: ["crm"],
  paraClinic: ["crm"],
  insurance: ["crm"],
};
const DOCTOR_ONLY: Partial<Record<LicenseKind, string[]>> = { doctor: ["aiAssistant"] };
const PROVIDERS: AiAudience[] = [...licenseKindList];

// panel AI gated by the plan module as before, under the old shared cap
const panelPlan = { access: "plan" as const, modules: PANEL_MODULES, pro: false, day: { free: "legacy" as const, paid: "legacy" as const } };
// finance AI: the route needs the "accounting" module (Routers/
// businessRoutes.ts); no AI module was asked for, under the old shared cap
const financeFree = { access: "free" as const, modules: PANEL_MODULES, pro: false, day: { free: "legacy" as const, paid: "legacy" as const } };
// was never counted
const uncounted = { day: { free: 0, paid: 0 } };

export const AI_FEATURES: AiFeatureDef[] = [
  // ---------------------------------------------------------------- patient
  {
    key: "assistant.health",
    group: "assistant",
    audiences: ["patient"],
    unit: "request",
    title: "دستیار هوشمند سلامت (ویزارد)",
    description: "گفتگوی بیمار با دستیار سلامت در صفحه‌ی /wizard",
    // free for everyone with a daily allowance; Pro raises it
    defaults: { access: "free", modules: {}, pro: true, day: { free: "patientFree", paid: "patientPro" } },
  },
  {
    key: "assistant.copilot.patient",
    group: "assistant",
    audiences: ["patient"],
    unit: "request",
    title: "دستیار نویان در داشبورد کاربر",
    description: "پرسش و کار با دستیار نویان در داشبورد بیمار",
    defaults: { access: "free", modules: {}, pro: true, day: { free: "patientFree", paid: "patientPro" } },
  },
  {
    key: "assistant.voice.patient",
    group: "assistant",
    audiences: ["patient"],
    unit: "minute",
    title: "گفتار به متن در داشبورد کاربر",
    description: "پرسیدن با صدا از دستیار در داشبورد بیمار (دقیقه)",
    defaults: { access: "free", modules: {}, pro: true, day: { free: "patientFree", paid: "patientPro" } },
  },
  // ---------------------------------------------------------------- panels
  {
    key: "assistant.copilot",
    group: "assistant",
    audiences: PROVIDERS,
    unit: "request",
    title: "دستیار نویان در پنل‌ها",
    description: "دستیار شناور پنل پزشک و مراکز: پرسش، گزارش و پیش‌نویس کارها",
    defaults: panelPlan,
    legacy: ["copilot"],
  },
  {
    key: "assistant.voice",
    group: "assistant",
    audiences: PROVIDERS,
    unit: "minute",
    title: "گفتار به متن در پنل‌ها",
    description: "دکمه‌ی میکروفون دستیار و فرم‌های پنل (دقیقه)",
    defaults: panelPlan,
    legacy: ["transcribe"],
  },
  // ---------------------------------------------------------------- clinical
  {
    key: "clinical.scribe",
    group: "clinical",
    audiences: ["doctor"],
    unit: "minute",
    title: "نسخه‌نویس ویزیت (ضبط و تبدیل گفتار)",
    description: "ضبط گفتگوی ویزیت و تبدیل آن به متن (دقیقه)",
    defaults: { access: "plan", modules: DOCTOR_ONLY, pro: false, ...uncounted },
  },
  {
    key: "clinical.noteDraft",
    group: "clinical",
    audiences: ["doctor"],
    unit: "request",
    title: "پیش‌نویس یادداشت ویزیت (SOAP)",
    description: "ساخت پیش‌نویس یادداشت ویزیت از متن گفتگو",
    defaults: { access: "plan", modules: DOCTOR_ONLY, pro: false, ...uncounted },
  },
  {
    key: "clinical.intakeSummary",
    group: "clinical",
    audiences: ["doctor"],
    unit: "request",
    title: "خلاصه‌ی پرسش‌نامه‌ی پیش از ویزیت",
    description: "خلاصه و پرسش‌های پیشنهادی از پاسخ‌های بیمار، برای پزشک",
    // ran for every visit whatever the doctor's plan
    defaults: { access: "free", modules: DOCTOR_ONLY, pro: false, ...uncounted },
  },
  {
    key: "clinical.rx",
    group: "clinical",
    audiences: ["doctor"],
    unit: "request",
    title: "نسخه با صدا",
    description: "تبدیل نسخه‌ی گفته‌شده یا نوشته‌شده به فرم نسخه",
    defaults: { ...panelPlan, modules: DOCTOR_ONLY },
    legacy: ["rx"],
  },
  {
    key: "clinical.chatSuggest",
    group: "clinical",
    audiences: ["doctor"],
    unit: "request",
    title: "پیشنهاد پاسخ گفتگو",
    description: "خلاصه‌ی گفتگو با بیمار و پیشنهاد پاسخ",
    defaults: { ...panelPlan, modules: DOCTOR_ONLY },
    legacy: ["chat"],
  },
  {
    key: "clinical.patientSummary",
    group: "clinical",
    audiences: ["doctor"],
    unit: "request",
    title: "خلاصه‌ی پرونده‌ی بیمار",
    description: "خلاصه‌ی بالینی پرونده‌ی بیمار برای پزشک",
    defaults: { ...panelPlan, modules: DOCTOR_ONLY },
    legacy: ["summary"],
  },
  // ---------------------------------------------------------------- CRM
  {
    key: "crm.template",
    group: "crm",
    audiences: PROVIDERS,
    unit: "request",
    title: "نوشتن متن پیامک با هوش مصنوعی",
    description: "پیش‌نویس قالب پیامک کمپین از هدف آن",
    defaults: panelPlan,
    legacy: ["crmText"],
  },
  {
    key: "crm.plan",
    group: "crm",
    audiences: PROVIDERS,
    unit: "request",
    title: "برنامه‌ی اقدام روزانه‌ی ارتباط با بیماران",
    description: "پیگیری‌ها و تماس‌های پیشنهادی امروز",
    defaults: panelPlan,
    legacy: ["crmPlan"],
  },
  {
    key: "crm.contactInsight",
    group: "crm",
    audiences: PROVIDERS,
    unit: "request",
    title: "نگاه به پرونده‌ی مخاطب",
    description: "خلاصه‌ی رابطه با یک مخاطب و پیام پیگیری پیشنهادی",
    defaults: panelPlan,
    legacy: ["contactInsight"],
  },
  {
    key: "crm.callAnalysis",
    group: "crm",
    audiences: PROVIDERS,
    unit: "request",
    title: "تحلیل تماس تلفنی",
    description: "متن و تحلیل تماس ضبط‌شده با بیمار",
    defaults: panelPlan,
    legacy: ["call"],
  },
  // ---------------------------------------------------------------- finance
  {
    key: "finance.receipt",
    group: "finance",
    audiences: PROVIDERS,
    unit: "request",
    title: "خواندن رسید و فاکتور (OCR)",
    description: "عکس یا PDF رسید به پیش‌نویس هزینه",
    defaults: financeFree,
    legacy: ["finance.receipt"],
  },
  {
    key: "finance.entry",
    group: "finance",
    audiences: PROVIDERS,
    unit: "request",
    title: "ثبت با جمله",
    description: "یک جمله یا یادداشت صوتی به سند مالی مناسب",
    defaults: financeFree,
    legacy: ["finance.entry"],
  },
  {
    key: "finance.journal",
    group: "finance",
    audiences: PROVIDERS,
    unit: "request",
    title: "سند حسابداری از شرح رویداد",
    description: "شرح یک رویداد مالی به سند دوطرفه",
    defaults: financeFree,
  },
  {
    key: "finance.copilot",
    group: "finance",
    audiences: PROVIDERS,
    unit: "request",
    title: "دستیار مالی (پرسش از دفاتر)",
    description: "پرسش و پاسخ چندمرحله‌ای روی دفاتر خود پنل",
    defaults: financeFree,
    legacy: ["finance.ask"],
  },
  {
    key: "finance.insight",
    group: "finance",
    audiences: PROVIDERS,
    unit: "request",
    title: "تحلیل صفحه‌های مالی و توضیح پیش‌بینی",
    description: "تحلیل ارقام هر صفحه‌ی مالی، پیش‌بینی نقدینگی و ناهنجاری‌ها",
    defaults: financeFree,
    legacy: ["finance.narrative"],
  },
  {
    key: "finance.categorize",
    group: "finance",
    audiences: PROVIDERS,
    unit: "request",
    title: "دسته‌بندی ردیف‌های بانک و هزینه‌ها",
    description: "پیشنهاد حساب برای ردیف‌های صورت‌حساب و «سایر هزینه‌ها»",
    defaults: financeFree,
    legacy: ["finance.categorize"],
  },
  {
    key: "finance.payslip",
    group: "finance",
    audiences: PROVIDERS,
    unit: "request",
    title: "توضیح و بررسی فیش حقوقی",
    description: "توضیح فیش حقوقی و هشدارهای آن",
    defaults: financeFree,
  },
  {
    key: "finance.voice",
    group: "finance",
    audiences: PROVIDERS,
    unit: "minute",
    title: "یادداشت صوتی مالی",
    description: "تبدیل یادداشت صوتی به متن برای ثبت با جمله (دقیقه)",
    defaults: { ...financeFree, ...uncounted },
  },
  // ---------------------------------------------------------------- staff
  {
    key: "staff.copilot",
    group: "assistant",
    audiences: ["staff"],
    unit: "request",
    title: "دستیار نویان در پنل مدیریت",
    description: "دستیار کارکنان و مدیر سایت",
    defaults: { access: "free", modules: {}, pro: false, day: { free: "legacy", paid: "legacy" } },
  },
  {
    key: "staff.voice",
    group: "assistant",
    audiences: ["staff"],
    unit: "minute",
    title: "گفتار به متن در پنل مدیریت",
    description: "پرسیدن با صدا از دستیار پنل مدیریت (دقیقه)",
    defaults: { access: "free", modules: {}, pro: false, day: { free: "legacy", paid: "legacy" } },
  },
  // ---------------------------------------------------------------- content
  {
    key: "content.translation",
    group: "content",
    audiences: ["admin"],
    unit: "request",
    title: "ترجمه‌ی خودکار محتوا",
    description: "ترجمه‌ی ماشینی محتوای سایت به زبان‌های دیگر (ابزار داخلی)",
    defaults: { access: "free", modules: {}, pro: false, ...uncounted },
  },
  {
    key: "content.medical",
    group: "content",
    audiences: ["admin"],
    unit: "request",
    title: "پیش‌نویس و بررسی محتوای پزشکی",
    description: "پیش‌نویس و بررسی متن بیماری، علائم و دارو (ابزار داخلی)",
    defaults: { access: "free", modules: {}, pro: false, ...uncounted },
  },
];

export type AiFeatureKey = string;

const byKey = new Map(AI_FEATURES.map((f) => [f.key, f]));
export const aiFeature = (key: string) => byKey.get(key);
export const isAiFeatureKey = (key: unknown): key is AiFeatureKey => typeof key === "string" && byKey.has(key);
export const aiFeatureKeys = () => AI_FEATURES.map((f) => f.key);

// features a provider kind (or the patient) can use: what a plan of that
// kind may include
export const featuresFor = (audience: AiAudience) => AI_FEATURES.filter((f) => f.audiences.includes(audience));

// outside the user-facing paywall: no plans, one limit set
export const isInternal = (f: AiFeatureDef) => f.audiences.every((a) => a === "staff" || a === "admin");

// the old PanelAiUsage feature names (and finance.<name>) -> registry keys
export const legacyFeatureKey = (name: string): string | undefined =>
  AI_FEATURES.find((f) => f.legacy?.includes(name))?.key;
