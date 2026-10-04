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
    introduction: d.description || d.summary,
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

// one legacy doctor -> its profile (created once), the 301 from its old URL
// and the `mergedInto` mark; returns the profile
export const mergeLegacyDoctor = async (d: any) => {
  let profile = await DoctorProfile.findOne({ legacyDoctor: d._id }).select("_id slug");
  if (!profile) {
    profile = await DoctorProfile.create({
      ...(await legacyProfileFields(d)),
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
  for (const d of legacy as any[]) {
    await mergeLegacyDoctor(d);
    merged++;
  }
  if (merged) console.log(`[doctors] merged ${merged} legacy directory doctor(s) into profiles`);
};
