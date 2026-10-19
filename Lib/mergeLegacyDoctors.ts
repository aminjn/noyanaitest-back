import Doctor from "../Models/Doctor";
import DoctorProfile from "../Models/DoctorProfile";
import Redirection from "../Models/Redirection";
import { resolveGeo } from "./geoResolve";

// One doctor entity (2026-09 owner decision): every entry of the old public
// directory (the `Doctor` model - no account, no booking) becomes a
// DoctorProfile with claimed: false. It is listed, searched and shown with
// the same card and page as every other doctor, only without online booking
// until the doctor claims it. Its old /doctor/<slug> URL answers with a 301
// to the new /dr/<slug>. Idempotent: a merged Doctor carries `mergedInto`.

const splitName = (raw?: string) => {
  const name = (raw || "").replace(/^\s*(دکتر|Dr\.?)\s+/i, "").trim();
  const [firstName = "", ...rest] = name.split(/\s+/);
  return { firstName, lastName: rest.join(" ") };
};

const freeSlug = async (base: string) => {
  let slug = base;
  let n = 2;
  while (await DoctorProfile.exists({ slug })) slug = `${base}-${n++}`;
  return slug;
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
};

// what a profile made from a legacy directory doctor holds (also used by the
// old-site import, Services/oldSiteImport.ts, to refresh an unclaimed one)
export const legacyProfileFields = async (d: any) => {
  const geo = await resolveGeo(d.province, d.city);
  const lat = num(d.lat);
  const lng = num(d.lng);
  const specialities = (d.specialities || []).map(String);
  const main = d.speciality ? String(d.speciality) : specialities[0];
  return {
    ...splitName(d.name),
    avatar: d.image,
    ...(main && { mainSpeciality: main }),
    specialities: [...new Set([main, ...specialities].filter(Boolean))],
    // both of the old texts: the summary first, unless the description has it
    introduction:
      d.summary && d.description && !String(d.description).includes(String(d.summary).trim())
        ? `${String(d.summary).trim()}\n\n${String(d.description).trim()}`
        : d.description || d.summary,
    medicalSystemCode: d.code,
    address: d.address,
    landLine: d.landLine,
    website: d.site,
    ...(lat && lng && { lat, lng, location: { type: "Point", coordinates: [lng, lat] } }),
    ...(geo.province ? { province: geo.province } : {}),
    ...(geo.city ? { city: geo.city } : {}),
    order: d.order || 0,
    active: !!d.active,
  };
};

const DIGITS: Record<string, string> = {};
"۰۱۲۳۴۵۶۷۸۹".split("").forEach((c, i) => (DIGITS[c] = String(i)));
"٠١٢٣٤٥٦٧٨٩".split("").forEach((c, i) => (DIGITS[c] = String(i)));
const digits = (v: unknown) => String(v ?? "").replace(/[۰-۹٠-٩]/g, (c) => DIGITS[c]).replace(/\D/g, "");
const phoneKey = (v: unknown) => {
  let p = digits(v);
  if (p.startsWith("0098")) p = p.slice(2);
  if (p.startsWith("98") && p.length >= 11) p = `0${p.slice(2)}`;
  if (p.length === 10 && !p.startsWith("0")) p = `0${p}`;
  return p.length >= 8 ? p : "";
};
const nameKey = (v: unknown) =>
  String(v ?? "")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u200c\s]+/g, "")
    .trim();
const same = (a: unknown, b: unknown) => !!a && !!b && String(a) === String(b);

// The profile some other source already made for this legacy doctor (the
// partner import, a doctor who signed up on the new site), so the move from
// the old site does not list the same doctor twice (2026-10): the council
// number first, then a phone with the same surname, then the same full name
// with the same main speciality (and the same city when both have one).
// Only a profile no other legacy doctor holds; more than one candidate is no
// match. A match is filled in its empty fields only (Services/oldSiteImport).
export const findSameDoctor = async (d: any): Promise<any | null> => {
  const free = { legacyDoctor: null };
  const code = digits(d.code);
  if (code) {
    const byCode = await DoctorProfile.collection.find({ ...free, medicalSystemCode: { $in: [code, String(d.code).trim()] } }).limit(2).toArray();
    if (byCode.length === 1) return byCode[0];
  }
  const { firstName, lastName } = splitName(d.name);
  if (!lastName) return null;
  const last = nameKey(lastName);
  const persian = lastName.replace(/ي/g, "ی").replace(/ك/g, "ک");
  const lastVariants = [...new Set([lastName, persian, persian.replace(/ی/g, "ي").replace(/ک/g, "ك")])];
  const candidates = (await DoctorProfile.collection
    .find({ ...free, lastName: { $in: lastVariants } }, { projection: { firstName: 1, lastName: 1, landLine: 1, mainSpeciality: 1, city: 1, medicalSystemCode: 1, claimed: 1, slug: 1 } })
    .limit(50)
    .toArray()) as any[];
  const sameLast = candidates.filter((c) => nameKey(c.lastName) === last);
  // a different council number is a different doctor
  const fits = sameLast.filter((c) => !(code && c.medicalSystemCode && digits(c.medicalSystemCode) !== code));
  const phones = new Set([phoneKey(d.landLine), phoneKey(d.mobile)].filter(Boolean));
  const byPhone = fits.filter((c) => phones.has(phoneKey(c.landLine)));
  if (byPhone.length === 1) return byPhone[0];
  const first = nameKey(firstName);
  const main = d.speciality || d.specialities?.[0];
  const city = (await resolveGeo(d.province, d.city)).city;
  const byName = fits.filter(
    (c) => nameKey(c.firstName) === first && same(c.mainSpeciality, main) && !(c.city && city && !same(c.city, city)),
  );
  return byName.length === 1 ? byName[0] : null;
};

// one legacy doctor -> its profile (created once, or the same doctor's
// profile from another source), the 301 from its old URL and the
// `mergedInto` mark; returns the profile
export const mergeLegacyDoctor = async (d: any) => {
  let profile = await DoctorProfile.findOne({ legacyDoctor: d._id }).select("_id slug");
  if (!profile) {
    const match = await findSameDoctor(d);
    if (match) {
      await DoctorProfile.collection.updateOne({ _id: match._id }, { $set: { legacyDoctor: d._id } });
      profile = await DoctorProfile.findById(match._id).select("_id slug");
    }
  }
  if (!profile) {
    const fields: Record<string, any> = await legacyProfileFields(d);
    // a directory entry without a surname or a speciality is kept, hidden
    // until the admin completes it (a page on the site needs both)
    if (!fields.firstName || !fields.lastName || !fields.specialities?.length) fields.active = false;
    // a council code another profile already holds stays on the legacy record
    if (fields.medicalSystemCode && (await DoctorProfile.exists({ medicalSystemCode: String(fields.medicalSystemCode).trim() })))
      delete fields.medicalSystemCode;
    profile = await DoctorProfile.create({
      ...fields,
      slug: d.slug ? await freeSlug(d.slug) : undefined,
      claimed: false,
      legacyDoctor: d._id,
    });
  }
  const from = `/doctor/${d.slug || d._id}`;
  const to = `/dr/${profile.slug || profile._id}`;
  await Redirection.updateOne(
    { old: from },
    { $set: { current: to, statusCode: 301 } },
    { upsert: true },
  );
  await Doctor.collection.updateOne(
    { _id: d._id },
    { $set: { mergedInto: profile._id } },
  );
  return profile;
};

export const mergeLegacyDoctors = async () => {
  const legacy = await Doctor.collection
    .find({ mergedInto: { $exists: false } })
    .toArray();
  let merged = 0;
  let failed = 0;
  for (const d of legacy as any[]) {
    // one bad entry never stops the other 20k
    try {
      await mergeLegacyDoctor(d);
      merged++;
    } catch (err) {
      if (++failed <= 20) console.log(`[doctors] legacy doctor ${d._id} not merged:`, (err as Error)?.message);
    }
    // a whole old directory (20k+) takes minutes: say how far it is
    if ((merged + failed) % 1000 === 0) console.log(`[doctors] merging legacy directory doctors: ${merged + failed}/${legacy.length}`);
  }
  if (merged || failed) console.log(`[doctors] merged ${merged} legacy directory doctor(s) into profiles, ${failed} failed`);
};
