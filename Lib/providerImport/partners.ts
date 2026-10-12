import { Mapping } from "./mapping";
import { matchKey } from "./textExtract";

// Built-in mapping templates of the bulk provider import (2026-10): the
// directories NoyanAI has a data-exchange contract with. Seeded into
// Models/ProviderImportTemplate.ts at boot (Services/providerImport.ts
// ensureBuiltinTemplates), editable like any template, never deleted by
// accident (only reset to what ships here), and picked automatically when
// an uploaded file is recognised as the partner's.
//
// DrDr (دکتر دکتر, drdr.ir) - contract: NoyanAI gives DrDr a diagnosis API,
// DrDr shares its doctor directory. Their file:
//   { site: "دکتر دکتر", section: "زنان مراغه", contract_ref, generated_at,
//     groups: [ { source: "specialties/obstetrics-and-gynecology",
//       items: [ { نام, تخصص, تلفن, معرفی پزشک, بیماری ها, خدمات, لوکیشن,
//                  آدرس, عکس, لینک پروفایل } ] } ] }
// The introduction holds the council number, the office hours, the
// insurers and an Instagram handle among DrDr's own booking promotion; the
// conditions and services are names joined by spaces.

export type BuiltinTemplate = { key: string; name: string; version: number; mapping: Mapping };

const DRDR_PROMO = [
  "دکتردکتر",
  "دکتر دکتر مراجعه",
  "سایت دکتر دکتر",
  "drdr",
  "سامانه آنلاین",
  "سامانه نوبت",
  "سیستم نوبت",
  "نوبت",
  "زمان انتظار",
  "نوبت‌دار شد",
  "خبرم کن",
  "به سایت",
  "در این سایت",
  "پروفایل ایشان",
  "پروفایل او",
  "پروفایل دکتر",
  "نوبت‌دهی",
  "نوبت دهی",
  "رزرو نوبت",
  "دریافت نوبت",
  "نوبت اینترنتی",
  "نوبت آنلاین",
  "نوبت خود را",
  "نوبت ویزیت",
  "نوبت‌های فعال",
  "کلیک",
  "مالیات",
  "خدمات پیامکی",
  "مشاهده تمام نظرات",
  "نظرات مراجعان قبلی",
  "قبل از مراجعه به مطب از نوع بیمه",
];

const DRDR_DROP_SECTIONS = [
  "نظرات درباره دکتر",
  "نظرات در مورد دکتر",
  "نظرات بیماران درباره",
  "نظرات کاربران",
  "بیمه‌های طرف قرارداد",
  "بیمه های طرف قرارداد",
  "آدرس مطب",
  "آدرس و تلفن",
  "آدرس و شماره",
  "شماره مطب",
  "ساعت کاری",
  "ساعت کار مطب",
  "ساعات کاری",
  "ساعت حضور",
  "دسترسی به مطب",
  "نحوه دسترسی",
  "آدرس اینستاگرام",
  "صفحه اینستاگرام",
  "نوبت‌دهی دکتر",
  "نوبت‌دهی اینترنتی",
  "نوبت دهی دکتر",
  "در کدام بیمارستان",
  "هزینه ویزیت",
];

const DRDR_KEEP_SECTIONS = [
  "سوابق دکتر",
  "سوابق خانم دکتر",
  "سوابق آقای دکتر",
  "سوابق ایشان",
  "سوابق تحصیلی",
  "سوابق کاری",
  "سوابق و افتخارات",
  "افتخارات دکتر",
  "خدمات ارائه شده",
  "خدمات ارائه‌شده",
  "خدمات تخصصی دکتر",
  "خدمات پزشکی",
  "خدمات مطب",
  "تحصیلات",
];

// DrDr's category slugs -> our usual speciality names (fuzzy matched to the
// catalogue, so a name spelled a little differently still finds it)
const DRDR_SPECIALITY_HINTS: Record<string, string> = {
  "obstetrics-and-gynecology": "زنان و زایمان",
  gynecology: "زنان و زایمان",
  infertility: "ناباروری",
  cardiology: "قلب و عروق",
  dermatology: "پوست و مو",
  pediatrics: "کودکان",
  "internal-medicine": "داخلی",
  ophthalmology: "چشم پزشکی",
  otolaryngology: "گوش و حلق و بینی",
  ent: "گوش و حلق و بینی",
  orthopedics: "ارتوپدی",
  urology: "کلیه و مجاری ادراری",
  neurology: "مغز و اعصاب",
  psychiatry: "روانپزشکی",
  psychology: "روانشناسی",
  "general-surgery": "جراحی عمومی",
  neurosurgery: "جراحی مغز و اعصاب",
  "plastic-surgery": "جراحی پلاستیک",
  dentistry: "دندانپزشکی",
  dentist: "دندانپزشکی",
  endocrinology: "غدد و متابولیسم",
  gastroenterology: "گوارش و کبد",
  nephrology: "کلیه",
  rheumatology: "روماتولوژی",
  "infectious-diseases": "عفونی",
  "general-practitioner": "پزشک عمومی",
  nutrition: "تغذیه",
  physiotherapy: "فیزیوتراپی",
  radiology: "رادیولوژی",
  oncology: "انکولوژی",
  hematology: "خون و انکولوژی",
  pulmonology: "ریه",
  anesthesiology: "بیهوشی",
  midwifery: "مامایی",
  "speech-therapy": "گفتار درمانی",
  optometry: "بینایی سنجی",
  audiology: "شنوایی سنجی",
};

const drdrMapping: Mapping = {
  version: 1,
  options: {
    source: { key: "drdr", label: "دکتر دکتر (drdr.ir)", refPath: "contract_ref", generatedAtPath: "generated_at" },
    bio: { dropPhrases: DRDR_PROMO, dropSections: DRDR_DROP_SECTIONS, keepSections: DRDR_KEEP_SECTIONS },
    specialityHints: DRDR_SPECIALITY_HINTS,
  },
  lists: [
    {
      path: "groups[].items[]",
      kind: "doctor",
      fields: {
        externalId: { source: "لینک پروفایل", extract: "urlId", prefix: "drdr:" },
        firstName: { source: "نام", transforms: ["trim", "stripTitle"], split: { by: " ", index: 0 } },
        lastName: { source: "نام", transforms: ["trim", "stripTitle"], split: { by: " ", index: 1, rest: true } },
        medicalCode: { source: "معرفی پزشک", extract: "councilNumber" },
        medicalTitle: { constant: "پزشکی" },
        mainSpeciality: { source: "تخصص" },
        specialities: { source: "تخصص" },
        specialityHint: { source: "$parent.source" },
        bio: { source: "معرفی پزشک", extract: "cleanBio" },
        photo: { source: "عکس", extract: "imageUrl" },
        phone: { source: "تلفن", transforms: ["phone"] },
        address: { source: "آدرس", transforms: ["trim"] },
        point: { source: "لوکیشن" },
        insurances: { source: "معرفی پزشک", extract: "insurersInText" },
        services: { source: "خدمات", extract: "joinedList" },
        diseases: { source: "بیماری ها", extract: "joinedList" },
        instagram: { source: "معرفی پزشک", extract: "instagram" },
        officeHours: { source: "معرفی پزشک", extract: "hoursText" },
        sourceUrl: { source: "لینک پروفایل" },
        cityHint: { source: "$root.section" },
      },
      children: [],
    },
  ],
};

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [{ key: "drdr", name: "DrDr (قرارداد)", version: 1, mapping: drdrMapping }];

// which built-in template an uploaded file belongs to: the file names the
// partner (`site`), or its profile links point at the partner's domain
export const detectBuiltinTemplate = (root: unknown): string | undefined => {
  if (!root || typeof root !== "object") return undefined;
  const site = (root as Record<string, unknown>).site;
  if (typeof site === "string" && ["دکتردکتر", "drdr", "drdrir"].includes(matchKey(site))) return "drdr";
  // a few records are enough: any string field holding a drdr.ir link
  const text = JSON.stringify(root).slice(0, 200_000);
  if (/https?:\/\/(?:www\.)?drdr\.ir\//i.test(text)) return "drdr";
  return undefined;
};
