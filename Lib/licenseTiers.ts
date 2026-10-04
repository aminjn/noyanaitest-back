import mongoose from "mongoose";
import { LicenseKind, licenseKindList, planModelOf } from "./licenseQuote";
import { IBaseLicensePricing } from "../Models/BaseLicensePricing";

// The recommended plan lineup per provider kind (2026-10, owner decision:
// "plans by features that drive sales, with a launch discount").
//
// Benchmark (docs/market-benchmark.md): Doctolib Pro sells one base
// subscription and the AI consultation assistant as an add-on;
// Docplanner/Doctoralia sells Starter / Plus / VIP; Practo Ray a free
// listing plus paid practice software; Paziresh24 and Nobat keep booking
// "free" and earn elsewhere. NoyanAI copies the three-tier ladder with a
// free-forever entry (the Iranian doctor expects a free tool), puts the
// must-haves (online visits and payouts, patient records, e-prescription,
// Moadian invoices, CRM) in the middle "best seller" tier, and keeps the
// premium tier for the AI scribe, payroll and a large SMS quota - the
// decoy ladder where the middle plan is the obvious buy.
//
// Prices are in toman (Iranian market, autumn 2026 - see the report) and
// only seed values: the super admin edits every plan afterwards. The
// longer the period, the bigger the discount (3 / 6 / 12 months).

export type TierId = "free" | "pro" | "plus";

export interface RecommendedTier {
  tier: TierId;
  displayName: string;
  translations: Record<string, string>;
  summary: string;
  descriptions: string[];
  modules: string[];
  // monthly list price; 0 = free forever (no price options at all)
  monthly: number;
  monthlySmsQuota: number;
}

// what a provider gets when no plan is marked default (or the catalog is
// empty): the free tier's bare minimum - profile, the plans page, and for
// a doctor the dashboard and basic booking - never every module
export const minimalModules: Record<LicenseKind, string[]> = {
  doctor: ["dashboard", "profile", "office", "services", "shifts", "schedule", "settings", "licenses"],
  clinic: ["profile", "licenses"],
  hospital: ["profile", "licenses"],
  pharmacy: ["profile", "products", "incomingOrders", "licenses"],
  paraClinic: ["profile", "tests", "incomingOrders", "licenses"],
  insurance: ["profile", "licenses"],
};

// 3 / 6 / 12 months, 10 / 15 / 25 % off the monthly price, rounded to
// 10,000 toman
export const PERIOD_DISCOUNTS: { days: number; months: number; off: number }[] = [
  { days: 90, months: 3, off: 0.1 },
  { days: 180, months: 6, off: 0.15 },
  { days: 365, months: 12, off: 0.25 },
];

const round10k = (n: number) => Math.round(n / 10000) * 10000;

export const pricingFromMonthly = (monthly: number): IBaseLicensePricing[] =>
  monthly > 0
    ? PERIOD_DISCOUNTS.map(({ days, months, off }) => {
        const price = monthly * months;
        return { days, isActive: true, price, discount: price - round10k(price * (1 - off)) };
      })
    : [];

const FREE_NAMES = {
  en: "Free", ar: "مجاني", zh: "免费版", hi: "निःशुल्क", es: "Gratis", fr: "Gratuit", ru: "Бесплатный",
  pt: "Grátis", de: "Kostenlos", tr: "Ücretsiz", ur: "مفت", bn: "ফ্রি", id: "Gratis", ja: "無料",
};
const PRO_NAMES = {
  en: "Professional", ar: "احترافي", zh: "专业版", hi: "प्रोफेशनल", es: "Profesional", fr: "Professionnel",
  ru: "Профессиональный", pt: "Profissional", de: "Professional", tr: "Profesyonel", ur: "پروفیشنل",
  bn: "প্রফেশনাল", id: "Profesional", ja: "プロフェッショナル",
};
const PREMIUM_NAMES = {
  en: "Premium", ar: "مميز", zh: "尊享版", hi: "प्रीमियम", es: "Premium", fr: "Premium", ru: "Премиум",
  pt: "Premium", de: "Premium", tr: "Premium", ur: "پریمیم", bn: "প্রিমিয়াম", id: "Premium", ja: "プレミアム",
};
const plusNames = (en: string, ar: string, zh: string) => ({
  en, ar, zh, hi: `${en}`, es: en, fr: en, ru: en, pt: en, de: en, tr: en, ur: en, bn: en, id: en, ja: en,
});

const free = (kind: LicenseKind, modules: string[], descriptions: string[]): RecommendedTier => ({
  tier: "free",
  displayName: "رایگان",
  translations: FREE_NAMES,
  summary: "برای همیشه رایگان؛ حضور در نویان و دریافت نوبت بدون هزینه‌ی اشتراک",
  descriptions,
  modules: Array.from(new Set([...minimalModules[kind], ...modules])),
  monthly: 0,
  monthlySmsQuota: 0,
});

const tiers: Record<LicenseKind, RecommendedTier[]> = {
  doctor: (() => {
    const f = free("doctor", ["articles", "accounting"], [
      "پروفایل عمومی در جستجوی نویان",
      "نوبت‌دهی حضوری با شیفت و برنامه‌ی زمانی",
      "تنظیم نوع و قیمت ویزیت",
      "انتشار مقاله",
      "دفتر درآمد و هزینه (حسابداری ساده)",
    ]);
    const proModules = [
      ...f.modules,
      "servicePackages", "incomingOrders", "financialMangement", "secrataries", "patients",
      "patientDocuments", "chatWithPatients", "drugsAndPrescriptions", "insurances", "clinics",
      "hospitals", "phrmaciesAndLabs", "offers", "discounts", "crm", "moadian",
    ];
    return [
      f,
      {
        tier: "pro",
        displayName: "حرفه‌ای",
        translations: PRO_NAMES,
        summary: "پرفروش‌ترین پلن: ویزیت آنلاین، پرداخت و تسویه، پرونده‌ی بیمار و نسخه‌ی الکترونیک",
        descriptions: [
          "همه‌ی امکانات رایگان",
          "ویزیت آنلاین متنی، صوتی و تصویری و گفتگو با بیمار",
          "دریافت آنلاین و تسویه‌ی درآمد، گزارش مالی",
          "پرونده و مدارک بیمار، نسخه‌ی الکترونیک",
          "منشی، بیمه‌ها، همکاری با کلینیک، بیمارستان و داروخانه",
          "پکیج خدمات، تخفیف و پیشنهاد ویژه",
          "ارتباط با بیماران و ۳۰۰ پیامک کمپین در ماه",
          "صورتحساب الکترونیکی سامانه‌ی مودیان",
        ],
        modules: proModules,
        monthly: 690000,
        monthlySmsQuota: 300,
      },
      {
        tier: "plus",
        displayName: "ویژه",
        translations: PREMIUM_NAMES,
        summary: "همه‌چیز به‌علاوه‌ی دستیار هوش مصنوعی ویزیت و کسب‌وکار نویان",
        descriptions: [
          "همه‌ی امکانات حرفه‌ای",
          "دستیار هوش مصنوعی ویزیت: پیش‌نویس یادداشت از گفتگو",
          "حقوق و دستمزد کارکنان مطب",
          "۱۵۰۰ پیامک کمپین در ماه",
          "پشتیبانی اولویت‌دار",
        ],
        modules: [...proModules, "payroll", "aiAssistant"],
        monthly: 1490000,
        monthlySmsQuota: 1500,
      },
    ];
  })(),
  clinic: (() => {
    const f = free("clinic", ["articles", "accounting"], [
      "صفحه‌ی عمومی کلینیک و پزشکان آن",
      "انتشار مقاله",
      "حسابداری پایه",
    ]);
    const pro = [...f.modules, "secrataries", "prescriptions", "crm", "moadian"];
    return [
      f,
      {
        tier: "pro",
        displayName: "حرفه‌ای",
        translations: PRO_NAMES,
        summary: "پرفروش‌ترین پلن: منشی، نسخه، ارتباط با بیماران و مودیان",
        descriptions: [
          "همه‌ی امکانات رایگان",
          "منشی‌ها و دسترسی‌ها",
          "نسخه‌های الکترونیک",
          "ارتباط با بیماران و ۱۰۰۰ پیامک کمپین در ماه",
          "صورتحساب الکترونیکی سامانه‌ی مودیان",
        ],
        modules: pro,
        monthly: 1900000,
        monthlySmsQuota: 1000,
      },
      {
        tier: "plus",
        displayName: "کلینیک‌پلاس",
        translations: plusNames("Clinic Plus", "عيادة بلس", "诊所增强版"),
        summary: "همه‌ی امکانات به‌علاوه‌ی انبار، خرید و حقوق و دستمزد",
        descriptions: [
          "همه‌ی امکانات حرفه‌ای",
          "انبار مصرفی و خرید",
          "حقوق و دستمزد، بیمه و مالیات کارکنان",
          "۳۰۰۰ پیامک کمپین در ماه",
          "پشتیبانی اولویت‌دار",
        ],
        modules: [...pro, "inventory", "payroll"],
        monthly: 3900000,
        monthlySmsQuota: 3000,
      },
    ];
  })(),
  hospital: (() => {
    const f = free("hospital", ["articles", "accounting"], [
      "صفحه‌ی عمومی بیمارستان",
      "انتشار مقاله",
      "حسابداری پایه",
    ]);
    const pro = [...f.modules, "secrataries", "crm", "moadian"];
    return [
      f,
      {
        tier: "pro",
        displayName: "حرفه‌ای",
        translations: PRO_NAMES,
        summary: "پرفروش‌ترین پلن: کارکنان پذیرش، ارتباط با بیماران و مودیان",
        descriptions: [
          "همه‌ی امکانات رایگان",
          "کارکنان پذیرش و دسترسی‌ها",
          "ارتباط با بیماران و ۲۰۰۰ پیامک کمپین در ماه",
          "صورتحساب الکترونیکی سامانه‌ی مودیان",
        ],
        modules: pro,
        monthly: 4900000,
        monthlySmsQuota: 2000,
      },
      {
        tier: "plus",
        displayName: "بیمارستان‌پلاس",
        translations: plusNames("Hospital Plus", "مستشفى بلس", "医院增强版"),
        summary: "همه‌ی امکانات به‌علاوه‌ی انبار، خرید و حقوق و دستمزد",
        descriptions: [
          "همه‌ی امکانات حرفه‌ای",
          "انبار مصرفی و خرید",
          "حقوق و دستمزد، بیمه و مالیات کارکنان",
          "۶۰۰۰ پیامک کمپین در ماه",
          "پشتیبانی اولویت‌دار",
        ],
        modules: [...pro, "inventory", "payroll"],
        monthly: 9900000,
        monthlySmsQuota: 6000,
      },
    ];
  })(),
  pharmacy: (() => {
    const f = free("pharmacy", ["articles", "accounting"], [
      "صفحه‌ی عمومی داروخانه",
      "ثبت محصول و دریافت سفارش آنلاین",
      "انتشار مقاله",
      "حسابداری پایه",
    ]);
    const pro = [...f.modules, "productPackages", "prescriptions", "tamin", "secrataries", "inventory", "crm", "moadian"];
    return [
      f,
      {
        tier: "pro",
        displayName: "حرفه‌ای",
        translations: PRO_NAMES,
        summary: "پرفروش‌ترین پلن: نسخه‌ی الکترونیک تأمین، انبار با بچ و انقضا و مودیان",
        descriptions: [
          "همه‌ی امکانات رایگان",
          "نسخه‌های الکترونیک و تأمین اجتماعی",
          "انبار با بچ و تاریخ انقضا",
          "پکیج محصولات، مسئول فنی و کارکنان",
          "ارتباط با مشتریان و ۵۰۰ پیامک کمپین در ماه",
          "صورتحساب الکترونیکی سامانه‌ی مودیان",
        ],
        modules: pro,
        monthly: 990000,
        monthlySmsQuota: 500,
      },
      {
        tier: "plus",
        displayName: "ویژه",
        translations: PREMIUM_NAMES,
        summary: "همه‌ی امکانات به‌علاوه‌ی حقوق و دستمزد و سهمیه‌ی پیامک بیشتر",
        descriptions: [
          "همه‌ی امکانات حرفه‌ای",
          "حقوق و دستمزد، بیمه و مالیات کارکنان",
          "۱۵۰۰ پیامک کمپین در ماه",
          "پشتیبانی اولویت‌دار",
        ],
        modules: [...pro, "payroll"],
        monthly: 1990000,
        monthlySmsQuota: 1500,
      },
    ];
  })(),
  paraClinic: (() => {
    const f = free("paraClinic", ["articles", "accounting"], [
      "صفحه‌ی عمومی آزمایشگاه یا مرکز تصویربرداری",
      "ثبت آزمایش‌ها و دریافت سفارش آنلاین",
      "انتشار مقاله",
      "حسابداری پایه",
    ]);
    const pro = [...f.modules, "tamin", "secrataries", "crm", "moadian"];
    return [
      f,
      {
        tier: "pro",
        displayName: "حرفه‌ای",
        translations: PRO_NAMES,
        summary: "پرفروش‌ترین پلن: نسخه‌ی تأمین، کارکنان، ارتباط با بیماران و مودیان",
        descriptions: [
          "همه‌ی امکانات رایگان",
          "نسخه‌های تأمین اجتماعی",
          "کارکنان و دسترسی‌ها",
          "ارتباط با بیماران و ۵۰۰ پیامک کمپین در ماه",
          "صورتحساب الکترونیکی سامانه‌ی مودیان",
        ],
        modules: pro,
        monthly: 1290000,
        monthlySmsQuota: 500,
      },
      {
        tier: "plus",
        displayName: "ویژه",
        translations: PREMIUM_NAMES,
        summary: "همه‌ی امکانات به‌علاوه‌ی انبار کیت و مواد و حقوق و دستمزد",
        descriptions: [
          "همه‌ی امکانات حرفه‌ای",
          "انبار کیت و مواد مصرفی و خرید",
          "حقوق و دستمزد، بیمه و مالیات کارکنان",
          "۱۵۰۰ پیامک کمپین در ماه",
          "پشتیبانی اولویت‌دار",
        ],
        modules: [...pro, "inventory", "payroll"],
        monthly: 2490000,
        monthlySmsQuota: 1500,
      },
    ];
  })(),
  insurance: (() => {
    const f = free("insurance", ["articles", "accounting"], [
      "صفحه‌ی عمومی بیمه و شبکه‌ی مراکز طرف قرارداد",
      "انتشار مقاله",
      "حسابداری پایه",
    ]);
    const pro = [...f.modules, "secrataries", "crm", "moadian"];
    return [
      f,
      {
        tier: "pro",
        displayName: "حرفه‌ای",
        translations: PRO_NAMES,
        summary: "پرفروش‌ترین پلن: کارشناسان، ارتباط با بیمه‌شدگان و مودیان",
        descriptions: [
          "همه‌ی امکانات رایگان",
          "کارشناسان و دسترسی‌ها",
          "ارتباط با بیمه‌شدگان و ۱۰۰۰ پیامک کمپین در ماه",
          "صورتحساب الکترونیکی سامانه‌ی مودیان",
        ],
        modules: pro,
        monthly: 2900000,
        monthlySmsQuota: 1000,
      },
      {
        tier: "plus",
        displayName: "ویژه",
        translations: PREMIUM_NAMES,
        summary: "همه‌ی امکانات به‌علاوه‌ی حقوق و دستمزد و سهمیه‌ی پیامک بیشتر",
        descriptions: [
          "همه‌ی امکانات حرفه‌ای",
          "حقوق و دستمزد، بیمه و مالیات کارکنان",
          "۳۰۰۰ پیامک کمپین در ماه",
          "پشتیبانی اولویت‌دار",
        ],
        modules: [...pro, "payroll"],
        monthly: 5900000,
        monthlySmsQuota: 3000,
      },
    ];
  })(),
};

// a tier's modules kept to the kind's own enum (a key renamed later must
// not make the seed fail validation)
const enumOf = (kind: LicenseKind): string[] => {
  const path = planModelOf(kind).schema.path("modules") as unknown as {
    caster?: { enumValues?: string[] };
    $embeddedSchemaType?: { enumValues?: string[] };
  };
  return path?.caster?.enumValues || path?.$embeddedSchemaType?.enumValues || [];
};

export const recommendedTiers = (kind: LicenseKind): RecommendedTier[] => {
  const allowed = new Set(enumOf(kind));
  return (tiers[kind] || []).map((t) => ({
    ...t,
    modules: Array.from(new Set(t.modules)).filter((m) => !allowed.size || allowed.has(m)),
  }));
};

const docOf = (kind: LicenseKind, t: RecommendedTier, order: number) => ({
  displayName: t.displayName,
  translations: Object.fromEntries(Object.entries(t.translations).map(([l, v]) => [l, { displayName: v }])),
  order,
  // the free tier is what every provider without a paid plan runs on
  isDefault: t.tier === "free",
  isActive: true,
  isPrimary: true,
  // "پرفروش" on the middle tier, the gold card on the top one
  isRecommended: t.tier === "pro",
  isGolden: t.tier === "plus",
  isDiscounted: false,
  monthlySmsQuota: t.monthlySmsQuota,
  pricing: pricingFromMonthly(t.monthly),
  descriptions: t.descriptions,
  summary: t.summary,
  modules: t.modules,
  details: "",
  recommendedTier: `${kind}:${t.tier}`,
});

// Creates the recommended plans a kind is missing (the admin button
// «ساخت پلن‌های پیشنهادی»). A tier counts as present when a plan carries
// its marker or the same Persian name - an existing plan is never touched.
// The free tier becomes the default only when the kind has no default yet.
export const seedRecommendedPlans = async (kind: LicenseKind) => {
  const model = planModelOf(kind);
  const existing = await model
    .find({})
    .select("displayName recommendedTier isDefault order")
    .lean<{ displayName?: string; recommendedTier?: string; isDefault?: boolean; order?: number }[]>();
  const hasDefault = existing.some((p) => p.isDefault);
  const names = new Set(existing.map((p) => (p.displayName || "").trim()));
  const markers = new Set(existing.map((p) => p.recommendedTier).filter(Boolean));
  const maxOrder = existing.reduce((m, p) => Math.max(m, Number(p.order) || 0), 0);
  const created: string[] = [];
  let i = 0;
  for (const t of recommendedTiers(kind)) {
    i++;
    if (markers.has(`${kind}:${t.tier}`) || names.has(t.displayName)) continue;
    const doc = docOf(kind, t, existing.length ? maxOrder + i : i);
    if (hasDefault) doc.isDefault = false;
    // raw insert: the model's save hook would clear the kind's other
    // defaults, and translations are written as given
    await model.collection.insertOne({ ...doc, _id: new mongoose.Types.ObjectId() });
    created.push(t.displayName);
  }
  return created;
};

// Boot seed (2026-10): a kind with no plans at all gets the recommended
// lineup; a kind that has any plan is left exactly as it is.
export const seedRecommendedPlansIfEmpty = async () => {
  for (const kind of licenseKindList) {
    const model = planModelOf(kind);
    if (await model.exists({})) continue;
    const created = await seedRecommendedPlans(kind);
    if (created.length) console.log(`[plans] ${kind}: recommended plans created (${created.join("، ")})`);
  }
};
