// Bulk provider import (2026-10, owner request before the move to
// noyanai.com): the target side of the field mapping. Every profile type
// the import fills, its fields (the keys of the documented "native" JSON
// format, docs/provider-import.md) and the child lists a record may hold.
//
// The admin's mapping (Lib/providerImport/mapping.ts) turns any source JSON
// into records of this shape; Lib/providerImport/native.ts validates them
// and Services/providerImport.ts writes them through the normal save paths.
// The labels are the frontend's (Components/Admin/ProviderImport/fields.ts):
// this file only carries what the server needs and the UI shows as hints.

export const importKinds = ["doctor", "office", "clinic", "hospital", "pharmacy", "lab", "insurer"] as const;
export type ImportKind = (typeof importKinds)[number];

// lists that only exist under a parent record
export const childKinds = ["office", "hours", "visitType", "labTest"] as const;
export type ChildKind = (typeof childKinds)[number];
export type AnyKind = ImportKind | ChildKind;

export type FieldType =
  | "id"
  | "string"
  | "i18n"
  | "text"
  | "number"
  | "price"
  | "boolean"
  | "enum"
  | "list"
  | "url"
  | "phone"
  | "phoneList"
  | "lat"
  | "lng"
  | "point"
  | "day"
  | "time"
  | "timeRange"
  | "refList"
  | "ref";

export type TargetField = {
  key: string;
  type: FieldType;
  required?: boolean;
  enum?: readonly string[];
  example?: unknown;
  // other names a source file may use (auto-suggest, lower case, no spaces)
  synonyms?: string[];
};

export type ChildSpec = { key: string; kind: ChildKind; synonyms: string[] };

export const genders = ["male", "female"] as const;
export const visitTypes = ["inPerson", "videoCall", "textChat", "voiceCall"] as const;
export type ImportVisitType = (typeof visitTypes)[number];
export const weekDays = ["saturday", "sunday", "monday", "tuesday", "wednesday", "thursday", "friday"] as const;
export const samplings = ["lab", "labOrHome", "none"] as const;

const id: TargetField = {
  key: "externalId",
  type: "id",
  required: true,
  example: "dr-1001",
  synonyms: ["externalid", "id", "_id", "uid", "code", "key", "شناسه"],
};
const slug: TargetField = { key: "slug", type: "string", example: "dr-ali-rezaei", synonyms: ["slug", "permalink", "urlkey"] };
const active: TargetField = { key: "active", type: "boolean", example: true, synonyms: ["active", "isactive", "enabled", "published", "visible", "فعال"] };
const photo = (key: string): TargetField => ({
  key,
  type: "url",
  example: "https://example.com/photo.jpg",
  synonyms: ["photo", "image", "avatar", "picture", "pic", "logo", "img", "imageurl", "photourl", "عکس", "تصویر", "لوگو"],
});
const place: TargetField[] = [
  { key: "address", type: "i18n", example: "تهران، خیابان ولیعصر، پلاک ۱۲", synonyms: ["address", "addr", "fulladdress", "location", "آدرس", "نشانی"] },
  { key: "lat", type: "lat", example: 35.7448, synonyms: ["lat", "latitude", "y", "عرض"] },
  { key: "lng", type: "lng", example: 51.3753, synonyms: ["lng", "lon", "long", "longitude", "x", "طول"] },
  { key: "point", type: "point", example: "35.7448,51.3753", synonyms: ["geo", "point", "latlng", "coordinates", "coords", "location", "موقعیت", "مختصات"] },
  { key: "province", type: "string", example: "تهران", synonyms: ["province", "state", "region", "ostan", "استان"] },
  { key: "city", type: "string", example: "تهران", synonyms: ["city", "town", "shahr", "شهر"] },
];
const phone: TargetField = { key: "phone", type: "phone", example: "02188776655", synonyms: ["phone", "tel", "telephone", "landline", "phonenumber", "تلفن", "شماره تماس"] };
const privatePhones: TargetField = {
  key: "privatePhones",
  type: "phoneList",
  example: ["09121234567"],
  synonyms: ["mobile", "cell", "cellphone", "privatephone", "privatephones", "موبایل", "همراه"],
};
const insurances: TargetField = {
  key: "insurances",
  type: "list",
  example: ["تأمین اجتماعی", "بیمه سلامت"],
  synonyms: ["insurances", "insurance", "insurers", "acceptedinsurances", "بیمه", "بیمه‌ها"],
};
const website: TargetField = { key: "website", type: "url", example: "https://example.com", synonyms: ["website", "site", "url", "web", "وبسایت", "سایت"] };
const summary: TargetField = { key: "summary", type: "i18n", example: "", synonyms: ["summary", "about", "description", "desc", "intro", "bio", "معرفی", "درباره"] };
const category: TargetField = { key: "category", type: "string", example: "", synonyms: ["category", "type", "kind", "دسته", "نوع"] };
const roundTheClock: TargetField = { key: "roundTheClock", type: "boolean", example: false, synonyms: ["24h", "247", "roundtheclock", "shabanehrouzi", "شبانه‌روزی"] };
const licenseNumber: TargetField = { key: "licenseNumber", type: "string", example: "", synonyms: ["license", "licensenumber", "licence", "permit", "پروانه", "شماره پروانه"] };
const email: TargetField = { key: "email", type: "string", example: "info@example.com", synonyms: ["email", "mail", "ایمیل"] };
const centreName: TargetField = { key: "name", type: "i18n", required: true, example: "کلینیک نمونه", synonyms: ["name", "title", "fullname", "نام", "عنوان"] };

const hoursChild: ChildSpec = {
  key: "hours",
  kind: "hours",
  synonyms: ["hours", "times", "schedule", "schedules", "workinghours", "openinghours", "shifts", "timetable", "ساعات", "ساعت کاری"],
};

export const kindFields: Record<AnyKind, TargetField[]> = {
  doctor: [
    id,
    { key: "firstName", type: "i18n", required: true, example: "علی", synonyms: ["firstname", "fname", "givenname", "name", "نام"] },
    { key: "lastName", type: "i18n", required: true, example: "رضایی", synonyms: ["lastname", "lname", "surname", "familyname", "family", "نام خانوادگی"] },
    { key: "fullName", type: "string", example: "دکتر علی رضایی", synonyms: ["fullname", "displayname", "name", "نام کامل"] },
    {
      key: "medicalCode",
      type: "string",
      example: "123456",
      synonyms: ["medicalcode", "medicalsystemcode", "nezam", "nezamcode", "mcode", "msc", "councilnumber", "council", "license", "نظام", "شماره نظام پزشکی", "کد نظام"],
    },
    { key: "medicalTitle", type: "string", example: "پزشکی", synonyms: ["medicaltitle", "councilfield", "field", "رشته"] },
    { key: "gender", type: "enum", enum: genders, example: "male", synonyms: ["gender", "sex", "جنسیت"] },
    {
      key: "mainSpeciality",
      type: "string",
      example: "قلب و عروق",
      synonyms: ["mainspeciality", "speciality", "specialty", "expertise", "spec", "تخصص", "تخصص اصلی"],
    },
    {
      key: "specialities",
      type: "list",
      example: ["قلب و عروق", "داخلی"],
      synonyms: ["specialities", "specialties", "expertise", "expertises", "specs", "تخصص‌ها"],
    },
    { key: "bio", type: "i18n", example: "", synonyms: ["bio", "biography", "about", "introduction", "description", "summary", "معرفی", "درباره"] },
    { key: "education", type: "list", example: ["دکترای پزشکی، دانشگاه تهران"], synonyms: ["education", "degrees", "achievements", "awards", "تحصیلات", "سوابق"] },
    photo("photo"),
    website,
    { ...phone, synonyms: [...(phone.synonyms || []), "officephone"] },
    privatePhones,
    insurances,
    { key: "services", type: "list", example: [], synonyms: ["services", "treatments", "خدمات"] },
    // the conditions the doctor treats (Disease catalogue, shown on the page)
    { key: "diseases", type: "list", example: ["دیابت بارداری"], synonyms: ["diseases", "conditions", "illnesses", "بیماری‌ها", "بیماریها", "بیماری ها"] },
    // a hint for the speciality when the title does not name it (a partner's
    // category slug: specialties/obstetrics-and-gynecology)
    { key: "specialityHint", type: "string", example: "specialties/cardiology", synonyms: ["specialityhint", "category", "section"] },
    { key: "instagram", type: "string", example: "dr.example", synonyms: ["instagram", "insta", "اینستاگرام"] },
    // the weekly hours written as text («شنبه تا چهارشنبه ۱۷ تا ۲۱»): read
    // into the office's hours
    { key: "officeHours", type: "text", example: "شنبه تا چهارشنبه ۱۷ تا ۲۱", synonyms: ["officehours", "workinghours", "ساعت کاری"] },
    // where the record came from (kept on the import link, never shown)
    { key: "sourceUrl", type: "url", example: "https://partner.example/dr/1001", synonyms: ["profileurl", "profilelink", "sourceurl", "لینک پروفایل"] },
    // a text ending in the city («زنان مراغه»): the last fallback for the city
    { key: "cityHint", type: "string", example: "زنان مراغه", synonyms: ["cityhint"] },
    {
      key: "memberships",
      type: "refList",
      example: ["clinic-1"],
      synonyms: ["memberships", "centres", "centers", "clinicids", "hospitalids", "worksat", "مراکز"],
    },
    // a doctor with one address and no office list: it becomes their office
    ...place,
    slug,
    active,
  ],
  office: [
    { key: "externalId", type: "id", example: "dr-1001-office-1", synonyms: ["externalid", "id", "_id", "officeid", "شناسه"] },
    { key: "doctor", type: "ref", example: "dr-1001", synonyms: ["doctor", "doctorid", "doctorexternalid", "physician", "پزشک"] },
    { key: "name", type: "string", example: "مطب ولیعصر", synonyms: ["name", "title", "officename", "clinicname", "نام", "عنوان"] },
    ...place,
    { key: "addressDetail", type: "string", example: "طبقه ۳، واحد ۷", synonyms: ["addressdetail", "unit", "floor", "plaque", "پلاک", "واحد"] },
    phone,
    { key: "centre", type: "ref", example: "clinic-1", synonyms: ["centre", "center", "clinic", "clinicid", "hospital", "hospitalid", "مرکز"] },
    active,
  ],
  hours: [
    { key: "day", type: "day", required: true, example: "saturday", synonyms: ["day", "weekday", "dayofweek", "dow", "روز"] },
    { key: "from", type: "time", example: "09:00", synonyms: ["from", "start", "open", "opens", "starttime", "begin", "از", "شروع"] },
    { key: "to", type: "time", example: "13:00", synonyms: ["to", "end", "close", "closes", "endtime", "finish", "تا", "پایان"] },
    { key: "range", type: "timeRange", example: "09:00-13:00", synonyms: ["range", "time", "hours", "times", "ساعت"] },
    { key: "slotMinutes", type: "number", example: 15, synonyms: ["slotminutes", "slot", "duration", "interval", "مدت"] },
    { key: "visitTypes", type: "list", example: ["inPerson"], synonyms: ["visittypes", "types", "sessiontypes", "نوع ویزیت"] },
  ],
  visitType: [
    { key: "type", type: "enum", enum: visitTypes, required: true, example: "inPerson", synonyms: ["type", "kind", "visittype", "service", "name", "نوع"] },
    { key: "price", type: "price", required: true, example: 500000, synonyms: ["price", "fee", "cost", "amount", "tariff", "قیمت", "هزینه", "تعرفه"] },
    { key: "duration", type: "number", example: 15, synonyms: ["duration", "minutes", "length", "slot", "مدت"] },
    active,
  ],
  labTest: [
    { key: "name", type: "string", required: true, example: "قند خون ناشتا", synonyms: ["name", "title", "test", "testname", "نام", "آزمایش"] },
    { key: "price", type: "price", required: true, example: 150000, synonyms: ["price", "fee", "cost", "amount", "قیمت", "هزینه"] },
    { key: "readyTime", type: "string", example: "۱ روز", synonyms: ["readytime", "turnaround", "tat", "result", "جواب"] },
    { key: "sampling", type: "enum", enum: samplings, example: "lab", synonyms: ["sampling", "homesampling", "نمونه‌گیری"] },
  ],
  clinic: [
    id, centreName, slug, summary, category, ...place, phone, privatePhones, website, email, photo("logo"),
    roundTheClock, insurances,
    { key: "services", type: "list", example: ["ویزیت عمومی", "تزریقات"], synonyms: ["services", "departments", "خدمات", "بخش‌ها"] },
    licenseNumber,
    { key: "personnelCount", type: "number", example: 12, synonyms: ["personnel", "staff", "staffcount", "پرسنل"] },
    active,
  ],
  hospital: [
    id, centreName, slug, summary, category, ...place, phone, privatePhones, website, email, photo("logo"),
    roundTheClock, insurances,
    { key: "services", type: "list", example: ["اورژانس", "آزمایشگاه"], synonyms: ["services", "departments", "wards", "خدمات", "بخش‌ها"] },
    licenseNumber,
    { key: "beds", type: "number", example: 120, synonyms: ["beds", "bedcount", "تخت"] },
    { key: "personnelCount", type: "number", example: 300, synonyms: ["personnel", "staff", "staffcount", "پرسنل"] },
    active,
  ],
  pharmacy: [
    id, centreName, slug, summary, ...place, phone, privatePhones, photo("logo"),
    roundTheClock, insurances, licenseNumber, active,
  ],
  lab: [
    id, centreName, slug, summary, category, ...place, phone, privatePhones, photo("logo"),
    roundTheClock, insurances, licenseNumber,
    { key: "onlineResults", type: "boolean", example: true, synonyms: ["onlineresults", "onlineresponse", "جواب آنلاین"] },
    { key: "personnelCount", type: "number", example: 10, synonyms: ["personnel", "staff", "پرسنل"] },
    active,
  ],
  insurer: [
    id, centreName, slug, summary, category,
    { key: "basic", type: "boolean", example: true, synonyms: ["basic", "isbasic", "پایه"] },
    phone, website, { ...place[0] }, place[1], place[2], place[3], photo("logo"), licenseNumber,
    { key: "coverages", type: "list", example: ["بستری", "دندانپزشکی"], synonyms: ["coverages", "coverage", "پوشش‌ها"] },
    { key: "advantages", type: "list", example: [], synonyms: ["advantages", "benefits", "مزایا"] },
    active,
  ],
};

export const kindChildren: Record<AnyKind, ChildSpec[]> = {
  doctor: [
    {
      key: "offices",
      kind: "office",
      synonyms: ["offices", "office", "clinics", "addresses", "locations", "places", "branches", "مطب", "مطب‌ها"],
    },
    {
      key: "visitTypes",
      kind: "visitType",
      synonyms: ["visittypes", "visits", "visit", "visittype", "services", "prices", "fees", "consultations", "ویزیت", "خدمات"],
    },
  ],
  office: [hoursChild],
  clinic: [hoursChild],
  hospital: [hoursChild],
  pharmacy: [hoursChild],
  lab: [hoursChild, { key: "tests", kind: "labTest", synonyms: ["tests", "services", "items", "pricelist", "آزمایش‌ها"] }],
  insurer: [],
  hours: [],
  visitType: [],
  labTest: [],
};

// the native file's top-level keys
export const nativeListKeys: Record<string, ImportKind> = {
  doctors: "doctor",
  offices: "office",
  clinics: "clinic",
  hospitals: "hospital",
  pharmacies: "pharmacy",
  paraclinics: "lab",
  labs: "lab",
  insurances: "insurer",
  insurers: "insurer",
};

// how a source list is recognised as one kind (its path's last segment)
export const kindSynonyms: Record<ImportKind, string[]> = {
  doctor: ["doctors", "doctor", "physicians", "physician", "practitioners", "providers", "pezeshk", "پزشکان", "پزشک"],
  office: ["offices", "office", "مطب‌ها"],
  clinic: ["clinics", "clinic", "polyclinics", "کلینیک", "کلینیک‌ها", "درمانگاه"],
  hospital: ["hospitals", "hospital", "بیمارستان", "بیمارستان‌ها"],
  pharmacy: ["pharmacies", "pharmacy", "drugstores", "داروخانه", "داروخانه‌ها"],
  lab: ["labs", "lab", "laboratories", "paraclinics", "paraclinic", "imaging", "آزمایشگاه", "پاراکلینیک"],
  insurer: ["insurers", "insurances", "insurance", "insurancecompanies", "بیمه", "بیمه‌ها"],
};

// the order records are written in: what others point at comes first
export const applyOrder: ImportKind[] = ["insurer", "clinic", "hospital", "lab", "pharmacy", "doctor", "office"];

export const IMPORT_FORMAT_VERSION = 1;
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
export const IMPORT_MAX_RECORDS = 50_000;
