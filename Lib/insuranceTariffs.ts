import mongoose, { isValidObjectId } from "mongoose";
import Insurance from "../Models/Insurance";
import InsurancePlan from "../Models/InsurancePlan";
import InsuranceTariff, { DoctorLevel, IInsuranceTariff, TariffVisitKind } from "../Models/InsuranceTariff";
import { effectiveContracts } from "./insuranceContracts";
import DoctorProfile from "../Models/DoctorProfile";
import Office from "../Models/Office";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import Reservation, { IReservationInsurerLine } from "../Models/Reservation";
import { BizInsurerKind } from "../Models/BizInvoice";
import { jalaliMonthRange, jalaliYearRange, tehranJalali } from "./tehranTime";

// Insurance tariffs in the booking price (2026-10, Models/InsuranceTariff.ts,
// docs/booking-benchmark.md «سهم بیمه»). Like Zocdoc's estimated copay and
// Doctolib's Sécu + mutuelle split: the patient picks the insurances they
// use (at most one basic - Tamin, Salamat, the armed forces' - and one
// supplementary), and only those the doctor or the doctor's centre accepts
// count. The basic insurer pays first on the visit price, the
// supplementary one on what is left; each by its most specific valid rule.
// The result is an estimate: the insurer's own review is final.

type Id = mongoose.Types.ObjectId | string;
const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");
const toman = (n: unknown) => Math.max(0, Math.round(Number(n) || 0));

export type AcceptedInsurance = {
  _id: string;
  name: string;
  image?: string;
  isBasic: boolean;
  // who accepts it: the doctor (their panel) or the centre of the office
  via: "doctor" | "centre";
  // via "centre": the clinic or hospital that holds the contract (its
  // books get the receivable, Lib/business/reservationInsurance.ts)
  centre?: { kind: "clinic" | "hospital"; id: string; name: string };
};

// the claim list's insurer kind of a Noyan insurer (Models/BizInvoice.ts)
export const insurerKindOf = (ins: { name?: string; isBasic?: boolean } | null | undefined): BizInsurerKind => {
  const name = String(ins?.name || "").replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/أ/g, "ا");
  if (/تامین\s*اجتماعی|تامین/.test(name)) return "tamin";
  if (/سلامت/.test(name)) return "salamat";
  if (/نیروهای\s*مسلح|مسلح/.test(name)) return "armed";
  return ins?.isBasic ? "other" : "supplementary";
};

// The insurances this doctor accepts, for this visit: their own effective
// insurer contracts and, for an in-person visit at a centre's office, the
// centre's (Lib/insuranceContracts.ts: only an Active contract inside its
// validity counts - the same rule as Lib/insuranceNetwork.ts).
export const acceptedInsurances = async (doctorId: Id, office?: Id | null): Promise<AcceptedInsurance[]> => {
  const ids = new Map<string, "doctor" | "centre">();
  if (isValidObjectId(String(doctorId)))
    for (const r of await effectiveContracts({ providerKind: "doctor", provider: doctorId })) ids.set(r.insurance, "doctor");
  let centreRef: AcceptedInsurance["centre"];
  if (office && isValidObjectId(String(office))) {
    const o = await Office.findById(office).select("clinic hospital").lean<{ clinic?: unknown; hospital?: unknown }>();
    // a centre that is switched off or suspended no longer lends its
    // contracts to the visit (the office keeps pointing at it)
    const centre = o?.clinic
      ? await Clinic.findOne({ _id: o.clinic, active: true }).select("name").lean<{ _id: unknown; name?: string }>()
      : o?.hospital
        ? await Hospital.findOne({ _id: o.hospital, isActive: true }).select("name").lean<{ _id: unknown; name?: string }>()
        : null;
    if (centre) {
      const kind = o?.clinic ? "clinic" : "hospital";
      centreRef = { kind, id: idOf(centre._id), name: centre.name || "" };
      for (const r of await effectiveContracts({ providerKind: kind, provider: centre._id }))
        if (!ids.has(r.insurance)) ids.set(r.insurance, "centre");
    }
  }
  if (!ids.size) return [];
  const docs = await Insurance.find({ _id: { $in: [...ids.keys()] }, active: true })
    .select("name image isBasic order")
    .sort({ order: 1, _id: 1 })
    .lean<{ _id: unknown; name?: string; image?: string; isBasic?: boolean }[]>();
  return docs.map((d) => ({
    _id: idOf(d._id),
    name: d.name || "",
    image: d.image,
    isBasic: !!d.isBasic,
    via: ids.get(idOf(d._id)) || "doctor",
    ...(ids.get(idOf(d._id)) === "centre" && centreRef ? { centre: centreRef } : {}),
  }));
};

// The doctor's level for a tariff: their main speciality's, else guessed
// from its name («پزشک عمومی» / «فوق تخصص» / anything else a specialist).
export const levelFromSpeciality = (sp: { name?: string; level?: string } | null | undefined): DoctorLevel => {
  if (sp?.level === "general" || sp?.level === "specialist" || sp?.level === "subspecialist") return sp.level;
  const name = String(sp?.name || "");
  if (!name || /عمومی|general/i.test(name)) return "general";
  if (/فوق\s*تخصص|فلوشیپ|subspecial|fellow/i.test(name)) return "subspecialist";
  return "specialist";
};

export const doctorTariffProfile = async (doctorId: Id) => {
  const d = await DoctorProfile.findById(doctorId)
    .select("mainSpeciality specialities")
    .populate({ path: "mainSpeciality", select: "name level" })
    .lean<{ mainSpeciality?: { _id?: unknown; name?: string; level?: string } | null; specialities?: unknown[] }>();
  const main = d?.mainSpeciality && typeof d.mainSpeciality === "object" ? d.mainSpeciality : null;
  return {
    level: levelFromSpeciality(main),
    specialities: new Set([idOf(main?._id), ...(d?.specialities || []).map(idOf)].filter(Boolean)),
  };
};

export const visitKindOf = (sessionType: string): Exclude<TariffVisitKind, "any"> =>
  sessionType === "inPerson" ? "inPerson" : "online";

// is the rule valid on that day (its dates are whole Tehran days)
const validOn = (t: Pick<IInsuranceTariff, "validFrom" | "validTo" | "active">, at: Date) =>
  t.active !== false && (!t.validFrom || t.validFrom <= at) && (!t.validTo || t.validTo >= at);

// how specific a matching rule is (higher wins; null: it does not apply)
const specificity = (
  t: IInsuranceTariff,
  q: { plan?: string | null; visitKind: string; level: DoctorLevel; specialities: Set<string>; service?: string | null; servicePackage?: string | null },
) => {
  let s = 0;
  if (t.plan) {
    if (!q.plan || idOf(t.plan) !== q.plan) return null;
    s += 16;
  }
  if (t.service || t.servicePackage) {
    const hit = (t.service && q.service && idOf(t.service) === q.service) || (t.servicePackage && q.servicePackage && idOf(t.servicePackage) === q.servicePackage);
    if (!hit) return null;
    s += 8;
  } else if (q.service || q.servicePackage) {
    // a visit rule is the fallback for a service with none of its own
    s += 0;
  }
  if (t.speciality) {
    if (!q.specialities.has(idOf(t.speciality))) return null;
    s += 4;
  }
  if (t.level && t.level !== "any") {
    if (t.level !== q.level) return null;
    s += 2;
  }
  if (t.visitKind && t.visitKind !== "any") {
    if (t.visitKind !== q.visitKind) return null;
    s += 1;
  }
  return s;
};

// The best rule of an insurer for this visit, or null.
export const findTariff = (
  tariffs: IInsuranceTariff[],
  q: { insurance: string; plan?: string | null; visitKind: string; level: DoctorLevel; specialities: Set<string>; service?: string | null; servicePackage?: string | null; at: Date },
) => {
  let best: { t: IInsuranceTariff; s: number } | null = null;
  for (const t of tariffs) {
    if (idOf(t.insurance) !== q.insurance || !validOn(t, q.at)) continue;
    // a cart order's drug / lab rule (Lib/cartInsurance.ts) never prices a visit
    if (t.target && t.target !== "visit") continue;
    const s = specificity(t, q);
    if (s === null) continue;
    // ties: the newest rule
    if (!best || s > best.s || (s === best.s && new Date(t.updatedAt || 0) > new Date(best.t.updatedAt || 0))) best = { t, s };
  }
  return best?.t || null;
};

// The share of one rule on what is still unpaid (`left`), before limits.
export const shareOf = (t: Pick<IInsuranceTariff, "method" | "percent" | "amount" | "govTariff" | "ceiling" | "copay">, left: number) => {
  const base = toman(left);
  if (base <= 0) return 0;
  const pct = Math.min(100, Math.max(0, Number(t.percent) || 0));
  let share =
    t.method === "fixed"
      ? toman(t.amount)
      : t.method === "govTariff"
        ? Math.round((Math.min(base, toman(t.govTariff) || base) * pct) / 100)
        : Math.round((base * pct) / 100);
  if (toman(t.ceiling) > 0) share = Math.min(share, toman(t.ceiling));
  // the patient always pays at least the copay
  share = Math.min(share, Math.max(0, base - toman(t.copay)));
  return Math.max(0, Math.min(base, share));
};

// What this patient has already used of a rule's monthly / yearly limit
// with this insurer (their other bookings in that Jalali month or year,
// cancelled ones and this one left out).
const usageOf = async (patient: Id, insurance: string, period: "month" | "year", at: Date, exclude?: Id | null) => {
  const j = tehranJalali(at);
  const range = period === "month" ? jalaliMonthRange(j.jy, j.jm) : jalaliYearRange(j.jy);
  const rows = await Reservation.find({
    patient,
    status: { $ne: "cancelled" },
    ...(exclude ? { _id: { $ne: exclude } } : {}),
    date: { $gte: range.start, $lt: range.end },
    "insuranceQuote.lines.insurance": insurance,
  })
    .select("insuranceQuote.lines")
    .lean<{ insuranceQuote?: { lines?: IReservationInsurerLine[] } }[]>();
  let count = 0;
  let amount = 0;
  for (const r of rows)
    for (const l of r.insuranceQuote?.lines || [])
      if (idOf(l.insurance) === insurance && l.share > 0 && !["cancelled", "reversed"].includes(l.status)) {
        count += 1;
        amount += l.share;
      }
  return { count, amount };
};

export type InsurancePick = { insurance: string; plan?: string | null };

export type InsuranceOption = AcceptedInsurance & {
  // its plans with a rule of their own (the patient picks theirs)
  plans: { _id: string; name: string }[];
  // a valid rule exists for this visit (the share can be estimated)
  covered: boolean;
};

export type InsuranceQuote = {
  lines: (Omit<IReservationInsurerLine, "status" | "insurance" | "plan" | "tariff" | "claim" | "centre"> & {
    insurance: string;
    plan?: string | null;
    tariff?: string | null;
    centre?: string;
  })[];
  insurerShare: number;
  options: InsuranceOption[];
  // picked (or saved on the patient) but not accepted by this doctor
  notAccepted: { _id: string; name: string }[];
  // the patient's saved insurances (preselected when the doctor accepts them)
  saved: InsurancePick[];
  error?: string;
};

type QuoteLine = InsuranceQuote["lines"][number];

// The insurer lines of one visit. `net` is the price after the club
// discount (what the insurers' rules apply to; the visit tax is the
// patient's). Picks the doctor does not accept are left out and reported.
export const quoteInsurance = async ({
  doctorId,
  sessionType,
  office,
  net,
  picks,
  patient,
  at = new Date(),
  exclude,
  service,
  servicePackage,
}: {
  doctorId: Id;
  sessionType: string;
  office?: Id | null;
  net: number;
  picks: InsurancePick[];
  patient?: Id | null;
  at?: Date;
  exclude?: Id | null;
  service?: string | null;
  servicePackage?: string | null;
}): Promise<InsuranceQuote> => {
  const accepted = await acceptedInsurances(doctorId, sessionType === "inPerson" ? office : null);
  const acceptedIds = new Set(accepted.map((a) => a._id));
  const [profile, tariffs, saved] = await Promise.all([
    doctorTariffProfile(doctorId),
    accepted.length
      ? InsuranceTariff.find({ insurance: { $in: accepted.map((a) => a._id) }, active: true }).lean<IInsuranceTariff[]>()
      : Promise.resolve([] as IInsuranceTariff[]),
    patient && isValidObjectId(String(patient))
      ? mongoose
          .model("UserIdentity")
          .findById(patient)
          .select("insurances")
          .lean<{ insurances?: { insurance?: unknown; plan?: unknown; expiresAt?: Date | null }[] }>()
          .then((p) =>
            (Array.isArray(p?.insurances) ? p!.insurances! : [])
              // an expired card is not preselected («بیمه‌های من»)
              .filter((i) => !!i?.insurance && (!i.expiresAt || new Date(i.expiresAt) >= at))
              .map((i) => ({ insurance: idOf(i.insurance), plan: i.plan ? idOf(i.plan) : null })),
          )
      : Promise.resolve([] as InsurancePick[]),
  ]);
  const visitKind = visitKindOf(sessionType);
  const q = { visitKind, level: profile.level, specialities: profile.specialities, service: service || null, servicePackage: servicePackage || null, at };
  // the plans that carry a rule of their own, per insurer
  const planIds = [...new Set(tariffs.filter((t) => t.plan).map((t) => idOf(t.plan)))];
  const plans = planIds.length
    ? await InsurancePlan.find({ _id: { $in: planIds } }).select("name insurance order").sort({ order: 1, _id: 1 }).lean<{ _id: unknown; name?: string; insurance?: unknown }[]>()
    : [];
  const options: InsuranceOption[] = accepted.map((a) => {
    const own = plans.filter((p) => idOf(p.insurance) === a._id).map((p) => ({ _id: idOf(p._id), name: p.name || "" }));
    const covered =
      !!findTariff(tariffs, { ...q, insurance: a._id, plan: null }) ||
      own.some((p) => !!findTariff(tariffs, { ...q, insurance: a._id, plan: p._id }));
    return { ...a, plans: own, covered };
  });

  // the picks: known ids, no repeats, at most one basic and one
  // supplementary, the basic one first
  const names = new Map<string, { name?: string; isBasic?: boolean }>();
  const pickIds = [...new Set(picks.map((p) => p.insurance).filter((i) => isValidObjectId(i)))];
  const savedIds = saved.map((s) => s.insurance).filter((i) => !acceptedIds.has(i));
  if (pickIds.length || savedIds.length)
    for (const d of await Insurance.find({ _id: { $in: [...pickIds, ...savedIds] } }).select("name isBasic").lean<{ _id: unknown; name?: string; isBasic?: boolean }[]>())
      names.set(idOf(d._id), d);
  const notAccepted = [...new Set([...pickIds, ...savedIds])]
    .filter((i) => !acceptedIds.has(i) && names.has(i))
    .map((i) => ({ _id: i, name: names.get(i)?.name || "" }));
  const chosen = pickIds
    .filter((i) => acceptedIds.has(i))
    .map((i) => ({ opt: options.find((o) => o._id === i)!, plan: picks.find((p) => p.insurance === i)?.plan || null }));
  const basics = chosen.filter((c) => c.opt.isBasic);
  const supps = chosen.filter((c) => !c.opt.isBasic);
  let error: string | undefined;
  if (basics.length > 1) error = "فقط یک بیمه‌ی پایه را می‌توانید انتخاب کنید";
  else if (supps.length > 1) error = "فقط یک بیمه‌ی تکمیلی را می‌توانید انتخاب کنید";
  const ordered = [...basics.slice(0, 1), ...supps.slice(0, 1)];

  let left = toman(net);
  const lines: QuoteLine[] = [];
  const { checkEligibility } = await import("./insuranceEligibility");
  for (const { opt, plan } of ordered) {
    const planOk = plan && opt.plans.some((p) => p._id === plan) ? plan : null;
    const rule = findTariff(tariffs, { ...q, insurance: opt._id, plan: planOk }) || null;
    const base = left;
    let share = rule ? shareOf(rule, left) : 0;
    let reason: string | undefined = rule ? undefined : "noTariff";
    let method: string | undefined = rule?.method;
    if (rule && share > 0 && rule.limitPeriod !== "none" && patient && (rule.limitCount > 0 || rule.limitAmount > 0)) {
      const used = await usageOf(patient, opt._id, rule.limitPeriod, at, exclude);
      if (rule.limitCount > 0 && used.count >= rule.limitCount) share = 0;
      if (rule.limitAmount > 0) share = Math.min(share, Math.max(0, rule.limitAmount - used.amount));
      if (share <= 0) reason = "limit";
    }
    // the live eligibility check, where the admin turned a provider on
    // (Lib/insuranceEligibility.ts): a confirmed card may carry the
    // insurer's own coverage, which then replaces the tariff estimate; an
    // insurer that says the patient is not covered pays nothing; no answer
    // (off, not configured, an error) keeps the estimate
    const e = patient
      ? await checkEligibility({ _id: opt._id, name: opt.name, isBasic: opt.isBasic }, { identity: patient }, { doctorId }).catch(() => null)
      : null;
    let eligibility: QuoteLine["eligibility"];
    if (e && (e.status === "verified" || e.status === "notEligible")) {
      const coverage = e.coverage?.percent ?? e.coverage?.amount;
      eligibility = { provider: e.provider, status: e.status, checkedAt: new Date(), ...(coverage != null ? { coverage } : {}) };
      if (e.status === "notEligible") {
        share = 0;
        reason = "notEligible";
      } else if (e.coverage) {
        const pct = Math.min(100, Math.max(0, Number(e.coverage.percent) || 0));
        const byInsurer = e.coverage.amount != null ? toman(e.coverage.amount) : Math.round((left * pct) / 100);
        share = Math.max(0, Math.min(left, byInsurer));
        method = "eligibility";
        reason = share > 0 ? undefined : "noTariff";
      }
    }
    left -= share;
    lines.push({
      insurance: opt._id,
      name: opt.name,
      role: opt.isBasic ? "basic" : "supplementary",
      kind: insurerKindOf(opt),
      plan: planOk,
      // the plan named only when its own rule priced the visit
      planName: planOk && rule?.plan && idOf(rule.plan) === planOk ? opt.plans.find((p) => p._id === planOk)?.name : undefined,
      tariff: rule ? idOf(rule._id) : null,
      method,
      ...(eligibility ? { eligibility } : {}),
      base,
      share,
      ...(reason ? { reason } : {}),
      // the receivable's books: the centre that holds the contract, else
      // the doctor
      holder: opt.via === "centre" && opt.centre ? "centre" : "doctor",
      ...(opt.via === "centre" && opt.centre
        ? { centreKind: opt.centre.kind, centre: opt.centre.id, centreName: opt.centre.name }
        : {}),
    });
  }
  return {
    lines,
    insurerShare: lines.reduce((s, l) => s + l.share, 0),
    options,
    notAccepted,
    saved,
    ...(error ? { error } : {}),
  };
};

// The insurances a booking used, remembered on the patient for next time
// (Lib/patientInsurances.ts: never over what the patient saved themselves)
export const rememberInsurances = async (patient: Id, picks: InsurancePick[]) => {
  const { rememberBookingInsurances } = await import("./patientInsurances");
  await rememberBookingInsurances(patient, picks).catch(() => undefined);
};
