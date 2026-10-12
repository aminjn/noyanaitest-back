import crypto from "crypto";
import mongoose from "mongoose";
import SeoTemplate from "../Models/SeoTemplate";
import AutoFaqOverride, { AutoFaqOwnerType } from "../Models/AutoFaqOverride";
import DoctorInsurance from "../Models/DoctorInsurance";
import ClinicDoctor from "../Models/ClinicDoctor";
import HospitalDoctor from "../Models/HospitalDoctor";
import Disease from "../Models/Disease";
import Office from "../Models/Office";
import User from "../Models/User";
import City from "../Models/Geo/City";
import { PUBLIC_MEDICAL } from "./medicalContent";
import { doctorOffers, OfferType, offerTypes } from "./doctorOffer";
import { nextFreeSlots } from "./nextSlot";
import { getBookingHorizonDays } from "./appConfig";
import { sessionSettingsModels } from "./bookingFlow";
import { PublicPhone, publicPhones } from "./contactLinks";
import { SOURCE_LOCALE } from "./locales";
import { AutoFaqPage } from "./seo/autoFaqPages";
export { autoFaqPages, isAutoFaqPage } from "./seo/autoFaqPages";
export type { AutoFaqPage } from "./seo/autoFaqPages";


// The automatic FAQ of a public profile (2026-10, SEO; DrDr / Paziresh24 /
// Doctoreto / Zocdoc all close a doctor page with "how do I book Dr X,
// what does a visit cost, where is the office"). The backend gathers the
// FACTS each question is answered from - only real data, a question whose
// data is missing is not asked - and the frontend words them in the page's
// language (Components/Seo/autoFaq: message keys with ${n} placeholders,
// numbers and dates through Intl), the same items for the visible block and
// the FAQPage structured data.
//
// The doctor may change any item from their panel (AutoFaqOverride): only
// the change is stored, so an untouched item keeps following the data.

export const isAutoFaqOn = async (path: AutoFaqPage) =>
  !(await SeoTemplate.exists({ resourceType: path, autoFaq: false }));

// the doctor's questions, in the order the page shows them
export const doctorFaqKeys = [
  "booking",
  "speciality",
  "services",
  "fee",
  "address",
  "phone",
  "workplaces",
  "online",
  "nextSlot",
  "rating",
  "insurance",
] as const;
export type DoctorFaqKey = (typeof doctorFaqKeys)[number];
export const isDoctorFaqKey = (key: string): key is DoctorFaqKey =>
  (doctorFaqKeys as readonly string[]).includes(key);

// a catalogue record as the page names it: the public response puts
// `name` / `title` in the page's language (its `translations` bag)
type Named = { name: string; slug?: string; translations?: unknown };
type Titled = { title: string; translations?: unknown };

export type DoctorFaqFacts = {
  // always: how a patient reaches this doctor
  booking: {
    claimed: boolean;
    bookable: boolean;
    sessionTypes: OfferType[];
    hasPhone: boolean;
  };
  speciality?: {
    main?: Named;
    extra: Named[];
    // «پزشکی / دندانپزشکی ...» (the frontend words it per language)
    title?: string;
    code?: string;
  };
  services?: { services: Titled[]; diseases: Named[] };
  // per visit type, as offered (a hidden in-person price is left out)
  fee?: { prices: { type: OfferType; price: number }[] };
  address?: { offices: { name?: string; address: string }[]; city?: Named };
  // the public phones: each office's (with its name), then the profile's
  // land line - never the account's mobile
  phone?: { phones: PublicPhone[] };
  workplaces?: { items: (Named & { kind: "clinic" | "hospital" })[] };
  online?: { types: OfferType[] };
  // the first free time (Tehran wall clock), or none within `days`
  nextSlot?: { ymd: string; start: number; type: OfferType } | { none: true; days: number };
  rating?: { average: number; count: number };
  insurance?: { items: Named[] };
};

const TOP_SERVICES = 6;
const TOP_DISEASES = 5;
const TOP_INSURERS = 8;
const TOP_WORKPLACES = 6;

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// an office's translations reshaped for a row the FAQ builds from it
// (`pick` maps one language's bag to the row's fields), so the public
// response's overlay puts the row in the page's language
const bagOf = (
  translations: unknown,
  pick: (t: Record<string, unknown>) => Record<string, string>,
): Record<string, Record<string, string>> | undefined => {
  if (!translations || typeof translations !== "object") return undefined;
  const out: Record<string, Record<string, string>> = {};
  for (const [locale, t] of Object.entries(translations as Record<string, unknown>))
    if (t && typeof t === "object") {
      const row = Object.fromEntries(Object.entries(pick(t as Record<string, unknown>)).filter(([, v]) => !!v));
      if (Object.keys(row).length) out[locale] = row;
    }
  return Object.keys(out).length ? out : undefined;
};
const idOf = (v: unknown) => String((v as { _id?: unknown })?._id ?? v ?? "");

// `doctor` is the public profile as the page gets it (populated
// mainSpeciality, specialities, serviceCategories, mcCode, offices)
export const doctorFaqFacts = async (doctor: Record<string, any>): Promise<DoctorFaqFacts> => {
  const id = new mongoose.Types.ObjectId(idOf(doctor));
  const claimed = doctor.claimed !== false;
  const [offers, slots, horizon, insurers, clinics, hospitals, offices, cityDoc, owner, ...settings] = await Promise.all([
    doctorOffers([id]).catch(() => new Map()),
    claimed ? nextFreeSlots([id]).catch(() => new Map()) : Promise.resolve(new Map()),
    getBookingHorizonDays().catch(() => 30),
    DoctorInsurance.find({ doctor: id })
      .populate({ path: "insurance", match: { active: true }, select: "name translations" })
      .lean(),
    ClinicDoctor.find({ doctor: id })
      .populate({ path: "clinic", match: { active: true }, select: "name slug translations" })
      .lean(),
    HospitalDoctor.find({ doctor: id })
      .populate({ path: "hospital", match: { isActive: true }, select: "name slug translations" })
      .lean(),
    Office.find({ doctor: id, active: true })
      .sort({ order: 1, _id: 1 })
      .select("name address addressDetail tel translations")
      .lean(),
    doctor.city
      ? City.findById(idOf(doctor.city)).select("name translations").lean<{ name?: string; translations?: unknown }>()
      : null,
    doctor.user ? User.findById(idOf(doctor.user)).select("phone").lean<{ phone?: string }>() : null,
    ...offerTypes.map((t) =>
      sessionSettingsModels[t].findOne({ doctor: id, active: true, price: { $gt: 0 } }).select("price hidePrice").lean(),
    ),
  ]);
  const offer = offers.get(String(id));
  const sessionTypes: OfferType[] = claimed ? offer?.sessionTypes || [] : [];
  const bookable =
    claimed && doctor.active !== false && doctor.status !== "suspended" && sessionTypes.length > 0;

  // the phones the page shows: each office's (the office card) and the
  // profile's land line (the contact section) - offices are public places;
  // the account's mobile never is
  const phones = publicPhones(
    [
      ...(offices as { name?: string; tel?: string; translations?: unknown }[]).map((o) => ({
        name: o.name,
        phone: o.tel,
        translations: bagOf(o.translations, (t) => ({ name: text(t.name) })),
      })),
      { phone: doctor.landLine },
    ],
    [owner?.phone],
  );

  const facts: DoctorFaqFacts = {
    booking: { claimed, bookable, sessionTypes, hasPhone: phones.length > 0 },
  };

  const main =
    doctor.mainSpeciality && typeof doctor.mainSpeciality === "object" && text(doctor.mainSpeciality.name)
      ? {
          name: text(doctor.mainSpeciality.name),
          slug: doctor.mainSpeciality.slug || idOf(doctor.mainSpeciality),
          translations: doctor.mainSpeciality.translations,
        }
      : undefined;
  const extra: Named[] = (Array.isArray(doctor.specialities) ? doctor.specialities : [])
    .filter((s: any) => s && typeof s === "object" && text(s.name) && idOf(s) !== idOf(doctor.mainSpeciality))
    .filter((s: any, i: number, all: any[]) => all.findIndex((o) => idOf(o) === idOf(s)) === i)
    .map((s: any) => ({ name: text(s.name), translations: s.translations }));
  const title = text(doctor.medicalSystemTitle);
  const code = text(doctor.medicalSystemCode);
  if (main || extra.length || title || code)
    facts.speciality = { ...(main && { main }), extra, ...(title && { title }), ...(code && { code }) };

  const services = (Array.isArray(doctor.serviceCategories) ? doctor.serviceCategories : [])
    .filter((s: any) => s && typeof s === "object" && text(s.title))
    .map((s: any) => ({ title: text(s.title), translations: s.translations }))
    .slice(0, TOP_SERVICES) as Titled[];
  const diseases = main
    ? (
        await Disease.find({ specialities: idOf(doctor.mainSpeciality), ...PUBLIC_MEDICAL })
          .sort({ order: 1, _id: 1 })
          .limit(TOP_DISEASES)
          .select("name slug translations")
          .lean<{ _id: unknown; name?: string; slug?: string; translations?: unknown }[]>()
      )
        .filter((d) => text(d.name))
        .map((d) => ({ name: text(d.name), slug: d.slug || idOf(d), translations: d.translations }))
    : [];
  if (services.length || diseases.length)
    facts.services = { services, diseases };

  // the price of each bookable type; an in-person price the doctor hides
  // stays hidden here too
  const prices = offerTypes
    .map((type, i) => ({ type, s: settings[i] as { price?: number; hidePrice?: boolean } | null }))
    .filter(({ type, s }) => sessionTypes.includes(type) && Number(s?.price) > 0 && !s?.hidePrice)
    .map(({ type, s }) => ({ type, price: Number(s?.price) }));
  if (prices.length) facts.fee = { prices };

  const officeRows = (offices as any[])
    .map((o) => {
      const address = [text(o.address), text(o.addressDetail)].filter(Boolean).join(" · ");
      const translations = bagOf(o.translations, (t) => ({
        ...(text(o.name) && { name: text(t.name) }),
        ...((text(t.address) || text(t.addressDetail)) && {
          address: [text(t.address) || text(o.address), text(t.addressDetail) || text(o.addressDetail)]
            .filter(Boolean)
            .join(" · "),
        }),
      }));
      return { ...(text(o.name) && { name: text(o.name) }), address, ...(translations && { translations }) };
    })
    .filter((o) => o.address);
  const legacyAddress = text(doctor.address);
  const city: Named | undefined =
    cityDoc && text(cityDoc.name) ? { name: text(cityDoc.name), translations: cityDoc.translations } : undefined;
  if (officeRows.length || legacyAddress)
    facts.address = {
      offices: officeRows.length ? officeRows : [{ address: legacyAddress }],
      ...(city && { city }),
    };

  if (phones.length) facts.phone = { phones };

  const workplaces = [
    ...(clinics as any[])
      .filter((r) => r.clinic && typeof r.clinic === "object" && text(r.clinic.name))
      .map((r) => ({ kind: "clinic" as const, name: text(r.clinic.name), slug: r.clinic.slug || idOf(r.clinic), translations: r.clinic.translations })),
    ...(hospitals as any[])
      .filter((r) => r.hospital && typeof r.hospital === "object" && text(r.hospital.name))
      .map((r) => ({ kind: "hospital" as const, name: text(r.hospital.name), slug: r.hospital.slug || idOf(r.hospital), translations: r.hospital.translations })),
  ].slice(0, TOP_WORKPLACES);
  if (workplaces.length) facts.workplaces = { items: workplaces };

  if (bookable) facts.online = { types: sessionTypes.filter((t) => t !== "inPerson") };

  if (bookable) {
    const slot = slots.get(String(id));
    facts.nextSlot = slot
      ? { ymd: slot.ymd, start: slot.start, type: slot.sessionType as OfferType }
      : { none: true, days: Math.min(60, Math.max(1, Number(horizon) || 30)) };
  }

  const count = Number(doctor.feedbackCount) || 0;
  const average = Number(doctor.averageScore) || 0;
  if (count > 0 && average > 0) facts.rating = { average: Math.round(average * 10) / 10, count };

  const insurerItems: Named[] = (insurers as any[])
    .filter((r) => r.insurance && typeof r.insurance === "object" && text(r.insurance.name))
    .slice(0, TOP_INSURERS)
    .map((r) => ({ name: text(r.insurance.name), translations: r.insurance.translations }));
  if (insurerItems.length) facts.insurance = { items: insurerItems };

  return facts;
};

// the fingerprint of each item's facts (language-independent: the
// translations bags are left out)
const stripTranslations = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(stripTranslations);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .filter(([k]) => k !== "translations" && k !== "_id")
      .map(([k, val]) => [k, stripTranslations(val)]),
  );
};
export const factsHashes = (facts: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(facts)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [
        k,
        crypto.createHash("sha1").update(JSON.stringify(stripTranslations(v))).digest("hex").slice(0, 16),
      ]),
  );

export const loadOverrides = (ownerType: AutoFaqOwnerType, owner: unknown) =>
  AutoFaqOverride.find({ ownerType, owner: idOf(owner) })
    .select("key customQuestion customAnswer hidden order factsHash translations")
    .lean();

// The owner's wording is written in the source language. On a page in
// another language it is used only where it was translated; elsewhere the
// automatic text (worded in that language) stays - a Persian answer under
// an English question helps no reader and no search engine.
const forLocale = (rows: Record<string, any>[], locale: string) =>
  locale === SOURCE_LOCALE
    ? rows
    : rows.map((o) => {
        const own = (o.translations && typeof o.translations === "object" ? o.translations[locale] : null) || {};
        const has = (f: string) => typeof own[f] === "string" && own[f].trim();
        const { translations: _t, ...rest } = o;
        return {
          ...rest,
          customQuestion: has("customQuestion") ? own.customQuestion : undefined,
          customAnswer: has("customAnswer") ? own.customAnswer : undefined,
        };
      });

// what the public page and the panel get: the facts, their fingerprints and
// the owner's changes; `publicLocale` = the public page's language (the
// panel edits the source wording)
export const doctorAutoFaq = async (doctor: Record<string, any>, opts: { publicLocale?: string } = {}) => {
  const facts = await doctorFaqFacts(doctor);
  const overrides = (await loadOverrides("doctor", doctor._id)) as Record<string, any>[];
  return {
    facts,
    hashes: factsHashes(facts),
    overrides: opts.publicLocale ? forLocale(overrides, opts.publicLocale) : overrides,
  };
};
