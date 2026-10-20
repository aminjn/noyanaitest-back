import { CANONICAL_FELLOWSHIPS, CANONICAL_SPECIALITIES } from "./catalog/specialityCanonical";
import { keyOf } from "./catalog/catalogMatch";

// Which specialist fits what the patient describes (2026-10, owner report:
// the health chat sent low back pain and buttock pain to gynaecology).
//
// Benchmark: Ada and K Health do not let the language model name the
// specialist freely; "who to see" comes from the complaint and the likely
// condition, from a curated mapping. NoyanAI does the same: the model's pick
// stands only when it fits the body area the patient named, or a condition
// the site's own disease pages link to that specialty; otherwise the first
// fitting specialist the site has is used. A gender-specific field
// (gynaecology) needs a women's-health complaint.

type Rule = { words: RegExp; fits: string[] };

// a term starts a word («کمر» in «کمرم»); «=تب» is a whole word, with only
// a possessive or plural ending («تبم», not «تبریز»)
const words = (terms: string[]) =>
  new RegExp(
    `(?:^|[^\\p{L}])(?:${terms
      .map((t) => (t.startsWith("=") ? `${t.slice(1)}(?:م|ت|ش|مان|ها|ی)?(?![\\p{L}])` : t))
      .join("|")})`,
    "iu",
  );

// most specific first: the first rule the patient's words match leads
const RULES: Rule[] = [
  { words: words(["قاعدگی", "پریود", "عادت ماهانه", "بارداری", "حاملگی", "حامله", "رحم", "تخمدان", "واژن", "ترشحات زنانه", "یائسگی", "نازایی", "زایمان", "pregnan", "period", "menstrua", "vagin", "uter", "ovar"]), fits: ["زنان و زایمان", "مامایی"] },
  { words: words(["باسن", "نشیمن", "مقعد", "=کون", "بواسیر", "هموروئید", "شقاق", "فیشر", "فیستول", "کیست مویی", "دنبالچه", "خون در مدفوع", "anus", "anal", "rectal", "buttock", "hemorrhoid", "haemorrhoid", "pilonidal", "tailbone", "coccyx"]), fits: ["جراحی کولورکتال", "جراحی عمومی", "گوارش و کبد", "ارتوپدی"] },
  { words: words(["ادرار", "سنگ کلیه", "پروستات", "بیضه", "=آلت", "نعوظ", "مثانه", "urin", "bladder", "prostat", "testic", "kidney stone", "erect"]), fits: ["اورولوژی", "نفرولوژی"] },
  { words: words(["کمر", "ستون فقرات", "دیسک", "سیاتیک", "مهره", "back", "spine", "sciatic", "lumbar"]), fits: ["ارتوپدی", "طب فیزیکی و توانبخشی", "جراحی مغز و اعصاب", "روماتولوژی", "فیزیوتراپی"] },
  { words: words(["گردن", "neck"]), fits: ["ارتوپدی", "طب فیزیکی و توانبخشی", "جراحی مغز و اعصاب", "مغز و اعصاب", "گوش و حلق و بینی"] },
  { words: words(["زانو", "شانه", "آرنج", "=مچ", "مفصل", "استخوان", "لگن", "عضله", "عضلات", "رباط", "پیچ خوردگی", "شکستگی", "knee", "shoulder", "elbow", "wrist", "ankle", "joint", "bone", "hip", "muscle", "sprain", "fracture"]), fits: ["ارتوپدی", "روماتولوژی", "طب فیزیکی و توانبخشی", "پزشکی ورزشی", "فیزیوتراپی"] },
  { words: words(["قفسه سینه", "قفسه‌ی سینه", "درد سینه", "تپش قلب", "قلب", "فشار خون", "chest", "palpitat", "heart", "blood pressure"]), fits: ["قلب و عروق", "داخلی"] },
  { words: words(["سرفه", "تنگی نفس", "خس خس", "آسم", "ریه", "cough", "breath", "wheez", "asthma", "lung"]), fits: ["ریه", "داخلی", "آلرژی و ایمونولوژی بالینی", "گوش و حلق و بینی"] },
  { words: words(["سردرد", "سر درد", "سرم درد", "درد سر", "میگرن", "سرگیجه", "تشنج", "بی‌حسی", "بی حسی", "گزگز", "لرزش", "فراموشی", "headache", "migraine", "dizz", "vertigo", "seizure", "numb", "tingl", "tremor"]), fits: ["مغز و اعصاب", "گوش و حلق و بینی"] },
  { words: words(["=گوش", "گلو", "=بینی", "سینوس", "لوزه", "گرفتگی صدا", "=ear", "throat", "nose", "sinus", "tonsil"]), fits: ["گوش و حلق و بینی"] },
  { words: words(["=چشم", "بینایی", "=eye", "vision"]), fits: ["چشم‌پزشکی", "بینایی‌سنجی"] },
  { words: words(["دندان", "لثه", "=دهان", "tooth", "teeth", "=gum"]), fits: ["دندانپزشکی عمومی", "بیماری‌های دهان، فک و صورت", "جراحی دهان، فک و صورت"] },
  { words: words(["معده", "شکم", "دل درد", "دلدرد", "اسهال", "یبوست", "تهوع", "استفراغ", "سوزش سر دل", "ریفلاکس", "نفخ", "=کبد", "stomach", "abdom", "belly", "diarrh", "constipat", "nause", "vomit", "heartburn", "reflux", "bloat", "liver"]), fits: ["گوارش و کبد", "داخلی", "جراحی عمومی"] },
  { words: words(["=پوست", "=جوش", "آکنه", "خارش", "کهیر", "اگزما", "ریزش مو", "شوره", "=skin", "acne", "itch", "rash", "hives", "eczema", "hair loss"]), fits: ["پوست"] },
  { words: words(["تیروئید", "دیابت", "قند خون", "thyroid", "diabet", "blood sugar"]), fits: ["غدد درون‌ریز و متابولیسم", "داخلی"] },
  { words: words(["افسردگی", "اضطراب", "استرس", "بی‌خوابی", "بی خوابی", "وسواس", "پانیک", "depress", "anxi", "insomnia", "panic"]), fits: ["روانپزشکی", "روانشناسی", "طب خواب"] },
  { words: words(["=تب", "سرماخوردگی", "آنفولانزا", "=fever", "=cold", "=flu"]), fits: ["پزشک عمومی", "داخلی", "عفونی"] },
];

// a field and the field it grows out of (a spine surgeon fits «ارتوپدی»)
const PARENT = new Map<string, string>(
  [...CANONICAL_SPECIALITIES, ...CANONICAL_FELLOWSHIPS]
    .filter((c) => c.parent)
    .map((c) => [keyOf("speciality", c.fa), keyOf("speciality", c.parent as string)]),
);
const GYNAE = keyOf("speciality", "زنان و زایمان");
const rootOf = (key: string) => {
  let k = key;
  for (let i = 0; i < 4 && PARENT.has(k); i++) k = PARENT.get(k) as string;
  return k;
};

export type SiteSpeciality = { _id: string; name: string; slug?: string };

// the specialists that fit what the patient wrote, best first
export const fittingFields = (patientText: string): string[] => {
  const out: string[] = [];
  for (const r of RULES) if (r.words.test(patientText)) for (const f of r.fits) if (!out.includes(f)) out.push(f);
  return out;
};

// the specialist to show: the model's pick when it fits, else one that does
export const chooseSpeciality = ({
  picked,
  patientText,
  fromDiseases,
  specialities,
}: {
  picked?: SiteSpeciality;
  patientText: string;
  // specialities the site's pages for the named conditions link to
  fromDiseases: SiteSpeciality[];
  specialities: SiteSpeciality[];
}): SiteSpeciality | undefined => {
  const fits = fittingFields(patientText).map((f) => keyOf("speciality", f));
  const womens = RULES[0].words.test(patientText);
  const allowed = (s: SiteSpeciality) => womens || rootOf(keyOf("speciality", s.name)) !== GYNAE;
  const fitting = (s: SiteSpeciality) => {
    const k = keyOf("speciality", s.name);
    return fits.includes(k) || fits.includes(rootOf(k));
  };
  const backedByDisease = (s: SiteSpeciality) => fromDiseases.some((d) => d._id === s._id);

  if (picked && allowed(picked) && (!fits.length || fitting(picked) || backedByDisease(picked))) return picked;
  // a condition page's specialist that also fits the complaint, then any
  // fitting specialist the site has (in the guide's order)
  const fromPages = fromDiseases.filter(allowed);
  const both = fromPages.find(fitting);
  if (both) return both;
  for (const f of fits) {
    const hit = specialities.find((s) => keyOf("speciality", s.name) === f);
    if (hit && allowed(hit)) return hit;
  }
  if (!fits.length && fromPages.length) return fromPages[0];
  return specialities.find((s) => keyOf("speciality", s.name) === keyOf("speciality", "پزشک عمومی"));
};

// a line for the model: the same guide, so its own pick is right more often
export const specialityGuide = () =>
  [
    "Choose the specialist from the body area and the likely condition, for example:",
    "low back pain → ارتوپدی / طب فیزیکی و توانبخشی (kidney pain with urinary symptoms → اورولوژی);",
    "buttock, anal pain, haemorrhoids, pilonidal cyst → جراحی کولورکتال / جراحی عمومی;",
    "headache, dizziness, numbness → مغز و اعصاب; chest pain, palpitations → قلب و عروق;",
    "stomach, bowel → گوارش و کبد; skin → پوست; ear, nose, throat → گوش و حلق و بینی; urinary → اورولوژی.",
    "Suggest زنان و زایمان only for pregnancy, periods, or female reproductive organs, never for back or buttock pain.",
  ].join(" ");
