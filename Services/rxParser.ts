// Voice / free-text prescription (2026-10, doctor panel prescription writer).
//
// The doctor dictates ("آموکسی‌سیلین ۵۰۰ هر ۸ ساعت ۷ روز، سی‌بی‌سی") or types
// the same. The clinical model only EXTRACTS what was said into a fixed
// shape; everything after that is deterministic and checked here:
//   - each medicine is matched against the Tamin service catalogue the form
//     already uses (TaminService, srvType "01"), top 3 candidates;
//   - the frequency / timing / route are mapped to the admin's Tamin
//     catalogues «مقادیر مصرف» (TaminDrugAmount), «زمان مصرف»
//     (TaminDrugInstruction) and «طریقه مصرف» (TaminDrugUsage); a code the
//     model returned that is not in the catalogue is dropped;
//   - the quantity is computed from dose x frequency x days when not said;
//   - lab / imaging orders are matched against the other service types.
// Safety flags (allergy from the pre-visit questionnaire, duplicates, the
// usual daily maximum) are hints for the doctor, never a decision.
// Nothing is saved: the result fills the form as a draft the doctor edits.
import mongoose from "mongoose";
import TaminService, { ITaminService } from "../Models/TaminService";
import TaminDrugAmount, { ITaminDrugAmount } from "../Models/TaminDrugAmount";
import TaminDrugInstruction, { ITaminDrugInstruction } from "../Models/TaminDrugInstruction";
import TaminDrugUsage, { ITaminDrugUsage } from "../Models/TaminDrugUsage";
import Reservation from "../Models/Reservation";
import VisitIntake from "../Models/VisitIntake";
import { asciiDigits, clinicalJson, num, SAFETY, str } from "../Lib/ai/panelAi";

// ---------------- text helpers ----------------

// lower case, Arabic letters to Persian, digits to ASCII, no ZWNJ / tatweel
export const normalize = (s: string) =>
  asciiDigits(String(s || ""))
    .toLowerCase()
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ۀة]/g, "ه")
    .replace(/[ً-ٟـ]/g, "")
    .replace(/‌/g, " ")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .trim();
// the same without any space, for "contains" checks across spellings
export const compact = (s: string) => normalize(s).replace(/[\s.]+/g, "");

const STOP = new Set([
  "mg", "mcg", "ml", "g", "gr", "iu", "tab", "tablet", "tabs", "cap", "caps", "capsule", "syrup", "syr", "susp", "inj",
  "injection", "drop", "drops", "cream", "oint", "ointment", "gel", "spray", "amp", "vial", "oral", "film", "coated",
  "قرص", "کپسول", "شربت", "آمپول", "قطره", "پماد", "کرم", "ژل", "اسپری", "میلی", "گرم", "میلیگرم", "عدد", "سی", "سیسی",
]);
const tokensOf = (s: string) =>
  normalize(s)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+(\.\d+)?$/.test(t));
const numbersOf = (s: string) => (normalize(s).match(/\d+(\.\d+)?/g) || []).map(Number);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// a regex that also matches the Arabic spelling of ی / ک
const looseRegex = (t: string) => escapeRegex(t).replace(/ی/g, "[یي]").replace(/ک/g, "[کك]");

const FORMS: Record<string, string[]> = {
  tablet: ["tab", "tablet", "قرص"],
  capsule: ["cap", "capsule", "کپسول"],
  syrup: ["syrup", "syr", "susp", "suspension", "شربت", "سوسپانسیون"],
  injection: ["inj", "injection", "amp", "vial", "آمپول", "ویال", "تزریقی"],
  drop: ["drop", "drops", "قطره"],
  cream: ["cream", "oint", "ointment", "کرم", "پماد"],
  gel: ["gel", "ژل"],
  spray: ["spray", "اسپری"],
};

// ---------------- what the doctor should be warned about ----------------

type Known = { names: string[]; cls?: string; maxDailyMg?: number };
// a short list of common generics: their spellings, class and usual adult
// daily maximum (mg) - only to flag a number that looks off, not to decide
const KNOWN: Record<string, Known> = {
  amoxicillin: { names: ["amoxicillin", "amoxi", "آموکسیسیلین", "اموکسیسیلین", "آموکسی"], cls: "penicillin", maxDailyMg: 4000 },
  coamoxiclav: { names: ["coamoxiclav", "amoxiclav", "augmentin", "کوآموکسیکلاو", "کواموکسیکلاو"], cls: "penicillin", maxDailyMg: 4000 },
  ampicillin: { names: ["ampicillin", "آمپیسیلین"], cls: "penicillin" },
  penicillin: { names: ["penicillin", "پنیسیلین", "پنسیلین"], cls: "penicillin" },
  cloxacillin: { names: ["cloxacillin", "کلوگزاسیلین"], cls: "penicillin" },
  cefalexin: { names: ["cefalexin", "cephalexin", "سفالکسین"], cls: "cephalosporin", maxDailyMg: 4000 },
  cefixime: { names: ["cefixime", "سفیکسیم", "سفکسیم"], cls: "cephalosporin", maxDailyMg: 400 },
  azithromycin: { names: ["azithromycin", "آزیترومایسین", "ازیترومایسین"], cls: "macrolide", maxDailyMg: 500 },
  clarithromycin: { names: ["clarithromycin", "کلاریترومایسین"], cls: "macrolide", maxDailyMg: 1000 },
  ciprofloxacin: { names: ["ciprofloxacin", "سیپروفلوکساسین"], cls: "quinolone", maxDailyMg: 1500 },
  cotrimoxazole: { names: ["cotrimoxazole", "sulfamethoxazole", "کوتریموکسازول"], cls: "sulfa" },
  ibuprofen: { names: ["ibuprofen", "ایبوپروفن", "بروفن"], cls: "nsaid", maxDailyMg: 3200 },
  diclofenac: { names: ["diclofenac", "دیکلوفناک"], cls: "nsaid", maxDailyMg: 150 },
  naproxen: { names: ["naproxen", "ناپروکسن"], cls: "nsaid", maxDailyMg: 1500 },
  aspirin: { names: ["aspirin", "acetylsalicylic", "asa", "آسپرین", "اسپرین"], cls: "nsaid", maxDailyMg: 4000 },
  celecoxib: { names: ["celecoxib", "سلکوکسیب"], cls: "nsaid", maxDailyMg: 400 },
  mefenamic: { names: ["mefenamic", "مفنامیک"], cls: "nsaid", maxDailyMg: 1500 },
  acetaminophen: { names: ["acetaminophen", "paracetamol", "استامینوفن", "پاراستامول"], cls: "analgesic", maxDailyMg: 4000 },
  metformin: { names: ["metformin", "متفورمین"], cls: "biguanide", maxDailyMg: 2550 },
  losartan: { names: ["losartan", "لوزارتان"], cls: "arb", maxDailyMg: 100 },
  valsartan: { names: ["valsartan", "والسارتان"], cls: "arb", maxDailyMg: 320 },
  amlodipine: { names: ["amlodipine", "آملودیپین", "املودیپین"], cls: "ccb", maxDailyMg: 10 },
  atorvastatin: { names: ["atorvastatin", "آتورواستاتین"], cls: "statin", maxDailyMg: 80 },
  omeprazole: { names: ["omeprazole", "امپرازول"], cls: "ppi", maxDailyMg: 80 },
  pantoprazole: { names: ["pantoprazole", "پنتوپرازول", "پانتوپرازول"], cls: "ppi", maxDailyMg: 80 },
  tramadol: { names: ["tramadol", "ترامادول"], cls: "opioid", maxDailyMg: 400 },
  codeine: { names: ["codeine", "کدئین"], cls: "opioid", maxDailyMg: 240 },
  warfarin: { names: ["warfarin", "وارفارین"], cls: "anticoagulant" },
  prednisolone: { names: ["prednisolone", "پردنیزولون"], cls: "steroid" },
};
// allergy words for a whole class
const CLASS_WORDS: Record<string, string[]> = {
  penicillin: ["penicillin", "پنیسیلین", "پنسیلین"],
  cephalosporin: ["cephalosporin", "سفالوسپورین"],
  sulfa: ["sulfa", "سولفا", "سولفونامید"],
  nsaid: ["nsaid", "nsaids", "ضدالتهاب", "ضدالتهابغیراستروئیدی"],
  macrolide: ["macrolide", "ماکرولید"],
  quinolone: ["quinolone", "کینولون"],
  opioid: ["opioid", "مخدر", "اپیوئید"],
};
// a penicillin allergy is also a (smaller) warning for cephalosporins
const CROSS: Record<string, string> = { cephalosporin: "penicillin" };

const knownOf = (...texts: string[]): string | undefined => {
  const hay = texts.map(compact).join("|");
  return Object.keys(KNOWN).find((k) => KNOWN[k].names.some((n) => hay.includes(compact(n))));
};

export type RxWarning =
  | { code: "allergy"; params: [string, string] }
  | { code: "allergyClass"; params: [string, string] }
  | { code: "duplicateInList"; params: [string] }
  | { code: "duplicateExisting"; params: [string] }
  | { code: "currentMedication"; params: [string] }
  | { code: "sameClass"; params: [string, string] }
  | { code: "doseHigh"; params: [string, string, string] }
  | { code: "frequencyHigh"; params: [string] }
  | { code: "durationLong"; params: [string] }
  | { code: "quantityHigh"; params: [string] }
  | { code: "quantityMissing" }
  | { code: "unmatched" }
  | { code: "warfarinNsaid"; params: [string] };

// ---------------- catalogues ----------------

type Catalogs = {
  amounts: ITaminDrugAmount[];
  instructions: ITaminDrugInstruction[];
  usages: ITaminDrugUsage[];
};
let cache: { at: number; data: Catalogs } | null = null;
const loadCatalogs = async (): Promise<Catalogs> => {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.data;
  const [amounts, instructions, usages] = await Promise.all([
    TaminDrugAmount.find().lean<ITaminDrugAmount[]>(),
    TaminDrugInstruction.find().lean<ITaminDrugInstruction[]>(),
    TaminDrugUsage.find().lean<ITaminDrugUsage[]>(),
  ]);
  const data = { amounts: amounts || [], instructions: instructions || [], usages: usages || [] };
  cache = { at: Date.now(), data };
  return data;
};

const catalogLines = (rows: { code?: string; text: string }[], max = 150) =>
  rows
    .filter((r) => r.code)
    .slice(0, max)
    .map((r) => `${r.code}: ${r.text}`)
    .join("\n") || "(empty)";

// frequency words a Tamin "amount" row may carry
const freqPatterns = (timesPerDay: number | null, everyHours: number | null) => {
  const out: string[] = [];
  const h = everyHours || (timesPerDay ? Math.round(24 / timesPerDay) : null);
  const t = timesPerDay || (everyHours ? Math.round(24 / everyHours) : null);
  if (h) out.push(`هر${h}ساعت`, `q${h}h`, `${h}ساعت`, `every${h}h`);
  if (t) {
    const word = ["", "یک", "دو", "سه", "چهار", "پنج", "شش"][t] || "";
    out.push(`روزی${t}بار`, `${t}باردرروز`, `روزانه${t}بار`, `${t}times`, `${t}بار`);
    if (word) out.push(`روزی${word}بار`, `${word}باردرروز`, `روزانه${word}بار`);
    out.push(...({ 1: ["daily", "qd", "od", "روزییکبار", "روزانه"], 2: ["bid", "bd"], 3: ["tid", "tds"], 4: ["qid"] }[t] || []));
  }
  return out;
};
const TIMING: [string[], string[]][] = [
  [["بعدازغذا", "aftermeal", "pc"], ["بعدازغذا", "pc", "aftermeal"]],
  [["قبلازغذا", "beforemeal", "ac"], ["قبلازغذا", "ac", "beforemeal"]],
  [["ناشتا", "emptystomach"], ["ناشتا"]],
  [["قبلازخواب", "شب", "bedtime", "hs"], ["قبلازخواب", "hs", "bedtime", "شب"]],
  [["هنگامنیاز", "درصورتنیاز", "موقعدرد", "prn"], ["هنگامنیاز", "درصورتنیاز", "prn"]],
  [["همراهغذا", "withmeal"], ["همراهغذا", "withmeal"]],
];

const amountText = (r: ITaminDrugAmount) => [r.drugAmntConcept, r.drugAmntSumry, r.drugAmntLatin].filter(Boolean).join(" / ");
const instructionText = (r: ITaminDrugInstruction) =>
  [r.drugInstConcept, r.drugInstSumry, r.drugInstLatin].filter(Boolean).join(" / ");
const usageText = (r: ITaminDrugUsage) => [r.drugUsageConcept, r.drugUsageSumry, r.drugUsageLatin].filter(Boolean).join(" / ");

const pickAmount = (rows: ITaminDrugAmount[], code: string, timesPerDay: number | null, everyHours: number | null) => {
  const byCode = code ? rows.find((r) => r.drugAmntCode === code) : undefined;
  if (byCode) return byCode;
  const pats = freqPatterns(timesPerDay, everyHours).map(compact).filter(Boolean);
  if (!pats.length) return undefined;
  return rows.find((r) => pats.some((p) => compact(amountText(r)).includes(p)));
};
const pickInstruction = (rows: ITaminDrugInstruction[], code: string, said: string) => {
  const byCode = code ? rows.find((r) => r.drugInstCode === code) : undefined;
  if (byCode) return byCode;
  const hay = compact(said);
  if (!hay) return undefined;
  for (const [words, rowWords] of TIMING)
    if (words.some((w) => hay.includes(w)))
      return rows.find((r) => rowWords.some((w) => compact(instructionText(r)).includes(w)));
  // the row's own concept said word for word
  return rows.find((r) => r.drugInstConcept && compact(r.drugInstConcept).length >= 4 && hay.includes(compact(r.drugInstConcept)));
};
const pickUsage = (rows: ITaminDrugUsage[], code: string, route: string) => {
  const byCode = code ? rows.find((r) => r.drugUsageCode === code) : undefined;
  if (byCode) return byCode;
  const hay = compact(route);
  if (!hay) return undefined;
  const words: Record<string, string[]> = {
    oral: ["خوراکی", "oral", "po"],
    topical: ["موضعی", "topical"],
    injection: ["تزریق", "عضلانی", "وریدی", "im", "iv", "injection"],
    inhalation: ["استنشاق", "inhal"],
    eye: ["چشمی", "eye", "ophthalmic"],
  };
  for (const list of Object.values(words))
    if (list.some((w) => hay.includes(compact(w))))
      return rows.find((r) => list.some((w) => compact(usageText(r)).includes(compact(w))));
  return undefined;
};

// ---------------- matching against the Tamin services ----------------

export type ServiceCandidate = Pick<ITaminService, "srvType" | "srvCode" | "srvName" | "srvName2"> & {
  _id: string;
  score: number;
};

const SERVICE_FIELDS = "_id srvType srvCode srvName srvName2 gSrvCode";

const scoreService = (s: ITaminService, tokens: string[], strengths: number[], form?: string) => {
  const name = normalize(`${s.srvName || ""} ${s.srvName2 || ""}`);
  const nameTokens = name.split(/\s+/);
  let score = 0;
  for (const t of tokens) {
    if (nameTokens.includes(t)) score += 4;
    else if (nameTokens.some((n) => n.startsWith(t) || t.startsWith(n) && n.length >= 4)) score += 3;
    else if (name.includes(t)) score += 2;
  }
  if (!score) return 0;
  const nums = numbersOf(name);
  if (strengths.length && strengths.some((x) => nums.includes(x))) score += 3;
  else if (strengths.length && nums.length) score -= 1;
  if (form && FORMS[form]?.some((f) => nameTokens.includes(normalize(f)))) score += 1;
  return score;
};

export const searchServices = async (
  names: string[],
  { drugs, strengths = [], form }: { drugs: boolean; strengths?: number[]; form?: string },
): Promise<ServiceCandidate[]> => {
  const tokens = Array.from(new Set(names.flatMap(tokensOf))).slice(0, 8);
  if (!tokens.length) return [];
  // the longest words find the rows; all words rank them
  const keys = [...tokens].sort((a, b) => b.length - a.length).slice(0, 3);
  const or = keys.flatMap((t) => {
    const re = { $regex: looseRegex(t), $options: "i" };
    return [{ srvName: re }, { srvName2: re }];
  });
  const rows = await TaminService.find({ $or: or, ...(drugs ? { srvType: "01" } : { srvType: { $ne: "01" } }) })
    .select(SERVICE_FIELDS)
    .limit(120)
    .lean<ITaminService[]>();
  return (rows || [])
    .map((s) => ({ s, score: scoreService(s, tokens, strengths, form) }))
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ s, score }) => ({
      _id: String(s._id),
      srvType: s.srvType,
      srvCode: s.srvCode,
      srvName: s.srvName,
      srvName2: s.srvName2,
      score,
    }));
};

// ---------------- the parser ----------------

export type RxParseInput = {
  text: string;
  // the patient's UserIdentity id (the writer's selected patient)
  patient?: string;
  // what is already on the form: duplicates are flagged
  existing?: { service?: string; name?: string }[];
  doctorId: unknown;
};

export type RxDraftItem = {
  key: string;
  spoken: string;
  latin: string;
  strength: string;
  form: string;
  route: string;
  matched: ServiceCandidate | null;
  candidates: ServiceCandidate[];
  timesADay: ITaminDrugAmount | null;
  drugInstruction: ITaminDrugInstruction | null;
  usage: ITaminDrugUsage | null;
  dosePerTake: number | null;
  timesPerDay: number | null;
  everyHours: number | null;
  durationDays: number | null;
  qty: number | null;
  // the text for the item's description field (route, duration, notes)
  dose: string;
  warnings: RxWarning[];
};

export type RxDraftOrder = {
  key: string;
  spoken: string;
  latin: string;
  kind: string;
  notes: string;
  matched: ServiceCandidate | null;
  candidates: ServiceCandidate[];
};

const clampInt = (n: number | null, lo: number, hi: number) =>
  n === null || !Number.isFinite(n) ? null : Math.min(hi, Math.max(lo, Math.round(n)));

// the patient's answers to the latest pre-visit questionnaire with this doctor
const patientContext = async (patient: string | undefined, doctorId: unknown) => {
  if (!patient || !mongoose.isValidObjectId(patient)) return { allergies: "", medications: "" };
  const reservations = await Reservation.find({ patient, doctor: doctorId }).select("_id").sort({ date: -1 }).limit(30).lean();
  if (!reservations.length) return { allergies: "", medications: "" };
  const intake = await VisitIntake.findOne({ reservation: { $in: reservations.map((r) => r._id) } })
    .sort({ updatedAt: -1 })
    .select("allergies medications")
    .lean<{ allergies?: string; medications?: string }>();
  return { allergies: intake?.allergies || "", medications: intake?.medications || "" };
};

const SYSTEM = (cat: Catalogs) => `${SAFETY}
A physician in Iran dictated or typed a prescription, in Persian, possibly with Latin drug names and Persian numbers.
Extract every medicine and every lab / imaging / physiotherapy order exactly as said. Do not add, remove, correct or suggest anything.
For each medicine also write its generic or brand name in Latin letters ("latin"), as best you can.
Numbers are digits. Leave a field empty ("" or null) when it was not said.
Choose amountCode / instructionCode / usageCode ONLY from these lists (the code before the colon), or "" if none fits:
AMOUNTS (frequency / dose per time):
${catalogLines(cat.amounts.map((r) => ({ code: r.drugAmntCode, text: amountText(r) })))}
INSTRUCTIONS (when to take):
${catalogLines(cat.instructions.map((r) => ({ code: r.drugInstCode, text: instructionText(r) })))}
USAGES (route):
${catalogLines(cat.usages.map((r) => ({ code: r.drugUsageCode, text: usageText(r) })))}
JSON shape:
{"items":[{"spoken":string,"latin":string,"strength":string,"strengthMg":number|null,"form":"tablet"|"capsule"|"syrup"|"injection"|"drop"|"cream"|"gel"|"spray"|"",
"route":string,"dosePerTake":number|null,"timesPerDay":number|null,"everyHours":number|null,"durationDays":number|null,"quantity":number|null,
"timing":string,"amountCode":string,"instructionCode":string,"usageCode":string,"notes":string}],
"orders":[{"spoken":string,"latin":string,"kind":"lab"|"imaging"|"physio"|"other","notes":string}]}`;

export const parsePrescription = async ({ text, patient, existing = [], doctorId }: RxParseInput) => {
  const [cat, ctx] = await Promise.all([loadCatalogs(), patientContext(patient, doctorId)]);
  const obj = await clinicalJson(SYSTEM(cat), `Prescription:\n${text.slice(0, 4000)}`, { maxTokens: 2500 });
  const rawItems = Array.isArray(obj.items) ? obj.items.slice(0, 25) : [];
  const rawOrders = Array.isArray(obj.orders) ? obj.orders.slice(0, 25) : [];

  const items: RxDraftItem[] = [];
  for (const [i, raw] of rawItems.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const spoken = str(o.spoken, 200);
    const latin = str(o.latin, 200);
    if (!spoken && !latin) continue;
    const strength = str(o.strength, 60);
    const form = Object.keys(FORMS).find((f) => f === o.form) || "";
    const strengthMg = num(o.strengthMg) ?? numbersOf(strength)[0] ?? null;
    const strengths = [strengthMg, ...numbersOf(strength)].filter((x): x is number => typeof x === "number" && x > 0);
    const candidates = await searchServices([latin, spoken], { drugs: true, strengths, form });
    const matched = candidates[0] && candidates[0].score >= 5 ? candidates[0] : null;
    const timesPerDay = clampInt(num(o.timesPerDay), 1, 24);
    const everyHours = clampInt(num(o.everyHours), 1, 168);
    const durationDays = clampInt(num(o.durationDays), 1, 365);
    const dosePerTake = num(o.dosePerTake);
    let qty = clampInt(num(o.quantity), 1, 10000);
    const perDay = timesPerDay || (everyHours ? 24 / everyHours : null);
    // tablets / capsules: dose x times a day x days, when it was not said
    if (!qty && perDay && durationDays && (!form || form === "tablet" || form === "capsule"))
      qty = clampInt(Math.ceil((dosePerTake && dosePerTake > 0 ? dosePerTake : 1) * perDay * durationDays), 1, 10000);
    const timing = str(o.timing, 200);
    const notes = str(o.notes, 300);
    const route = str(o.route, 60);
    const timesADay = pickAmount(cat.amounts, str(o.amountCode, 20), timesPerDay, everyHours) || null;
    const drugInstruction = pickInstruction(cat.instructions, str(o.instructionCode, 20), `${timing} ${notes}`) || null;
    const usage = pickUsage(cat.usages, str(o.usageCode, 20), route) || null;
    const dose = [
      route && !usage ? route : usage?.drugUsageConcept || "",
      timesADay ? "" : everyHours ? `q${everyHours}h` : timesPerDay ? `${timesPerDay}x/day` : "",
      durationDays ? `${durationDays}d` : "",
      timing && !drugInstruction ? timing : "",
      notes,
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 400);
    items.push({
      key: `rx${i}`,
      spoken,
      latin,
      strength,
      form,
      route,
      matched,
      candidates,
      timesADay,
      drugInstruction,
      usage,
      dosePerTake,
      timesPerDay,
      everyHours,
      durationDays,
      qty,
      dose,
      warnings: [],
    });
  }

  // ---- safety flags (hints, not decisions) ----
  const allergyText = compact(ctx.allergies);
  const medsText = compact(ctx.medications);
  const existingNames = existing.map((e) => e.name || "").filter(Boolean);
  const existingIds = new Set(existing.map((e) => e.service).filter(Boolean));
  const seen = new Map<string, string>();
  const classSeen = new Map<string, string>();
  const allKnown = items.map((it) => knownOf(it.latin, it.spoken, it.matched?.srvName || "", it.matched?.srvName2 || ""));
  const existingKnown = existingNames.map((n) => knownOf(n)).filter(Boolean) as string[];
  for (const [i, it] of items.entries()) {
    const label = it.spoken || it.latin;
    const k = allKnown[i];
    const known = k ? KNOWN[k] : undefined;
    if (!it.matched) it.warnings.push({ code: "unmatched" });
    if (!it.qty) it.warnings.push({ code: "quantityMissing" });
    // allergy: the drug itself, or its class, named in the questionnaire
    if (allergyText && known) {
      if (known.names.some((n) => allergyText.includes(compact(n))))
        it.warnings.push({ code: "allergy", params: [ctx.allergies.slice(0, 120), label] });
      else if (known.cls) {
        const words = [...(CLASS_WORDS[known.cls] || []), ...(CROSS[known.cls] ? CLASS_WORDS[CROSS[known.cls]] || [] : [])];
        const classDrugs = Object.values(KNOWN)
          .filter((x) => x.cls === known.cls || x.cls === CROSS[known.cls!])
          .flatMap((x) => x.names);
        if ([...words, ...classDrugs].some((w) => allergyText.includes(compact(w))))
          it.warnings.push({ code: "allergyClass", params: [ctx.allergies.slice(0, 120), label] });
      }
    }
    // duplicates: in this list, on the form already, or a current medicine
    const dupKey = it.matched?._id || k || compact(it.latin || it.spoken);
    if (seen.has(dupKey)) it.warnings.push({ code: "duplicateInList", params: [seen.get(dupKey)!] });
    else seen.set(dupKey, label);
    if ((it.matched && existingIds.has(it.matched._id)) || (k && existingKnown.includes(k)))
      it.warnings.push({ code: "duplicateExisting", params: [label] });
    if (medsText && ((known && known.names.some((n) => medsText.includes(compact(n)))) || (it.spoken && medsText.includes(compact(it.spoken)))))
      it.warnings.push({ code: "currentMedication", params: [ctx.medications.slice(0, 120)] });
    if (known?.cls && !["analgesic"].includes(known.cls)) {
      const other = classSeen.get(known.cls);
      if (other && other !== label) it.warnings.push({ code: "sameClass", params: [other, label] });
      else classSeen.set(known.cls, label);
    }
    if (k === "warfarin" || known?.cls === "nsaid") {
      const partner = items.find((x, j) => j !== i && (k === "warfarin" ? KNOWN[allKnown[j] || ""]?.cls === "nsaid" : allKnown[j] === "warfarin"));
      if (partner || (k !== "warfarin" && (medsText.includes("وارفارین") || medsText.includes("warfarin"))))
        it.warnings.push({ code: "warfarinNsaid", params: [label] });
    }
    // numbers that look off
    const perDay = it.timesPerDay || (it.everyHours ? 24 / it.everyHours : null);
    const strengthMg = numbersOf(it.strength)[0] || numbersOf(it.matched?.srvName || "")[0];
    if (known?.maxDailyMg && perDay && strengthMg) {
      const mg = Math.round(strengthMg * (it.dosePerTake && it.dosePerTake > 0 ? it.dosePerTake : 1) * perDay);
      if (mg > known.maxDailyMg) it.warnings.push({ code: "doseHigh", params: [label, String(mg), String(known.maxDailyMg)] });
    }
    if (perDay && perDay > 6) it.warnings.push({ code: "frequencyHigh", params: [label] });
    if (it.durationDays && it.durationDays > 90) it.warnings.push({ code: "durationLong", params: [label] });
    if (it.qty && it.qty > 300) it.warnings.push({ code: "quantityHigh", params: [label] });
  }

  const orders: RxDraftOrder[] = [];
  for (const [i, raw] of rawOrders.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const spoken = str(o.spoken, 200);
    const latin = str(o.latin, 200);
    if (!spoken && !latin) continue;
    const candidates = await searchServices([latin, spoken], { drugs: false });
    orders.push({
      key: `or${i}`,
      spoken,
      latin,
      kind: ["lab", "imaging", "physio", "other"].includes(String(o.kind)) ? String(o.kind) : "other",
      notes: str(o.notes, 300),
      matched: candidates[0] && candidates[0].score >= 4 ? candidates[0] : null,
      candidates,
    });
  }

  return {
    items,
    orders,
    patient: { allergies: ctx.allergies, medications: ctx.medications },
    catalogs: { amounts: cat.amounts.length, instructions: cat.instructions.length, usages: cat.usages.length },
  };
};
