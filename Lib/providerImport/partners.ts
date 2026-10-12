import { Mapping } from "./mapping";

// Built-in mapping templates of the bulk provider import (2026-10): the
// directories NoyanAI exchanges data with. Seeded into
// Models/ProviderImportTemplate.ts at boot (Services/providerImport.ts
// ensureBuiltinTemplates; a newer shipped version replaces the stored one),
// and picked automatically when an uploaded file is recognised as the
// partner's.
//
// DrDr (دکتر دکتر): each record's fields go straight to one place on the
// doctor's profile, nothing more is read out of them (the owner's rule,
// 2026-10):
//   «نام»         -> first / last name («دکتر» dropped)
//   «تخصص»        -> specialities («تخصص X» -> X; a fellowship or «فوق
//                    تخصص» is an extra one; missing ones are created)
//   «تلفن»        -> the office's public phone
//   «معرفی پزشک»  -> the introduction, as written
//   «بیماری ها»   -> the conditions the doctor treats
//   «خدمات»       -> the doctor's services
//   «لوکیشن»      -> the office's map pin (province / city follow from it)
//   «آدرس»        -> the office's address
//   «عکس»         -> the photo (downloaded, stored as ours)
//   «لینک پروفایل» -> ignored: not stored anywhere
// The file's own metadata (site, section, contract_ref, generated_at,
// total) is ignored too. The records have no id of their own: a doctor is
// keyed by a hash of the normalised name and phone, so the same doctor in
// a later file updates the same page.

// where each field of a partner's record goes (the panel's read-only table;
// `to` is a key the panel labels)
export type PartnerField = { source: string; to: "name" | "speciality" | "phone" | "bio" | "diseases" | "services" | "location" | "address" | "photo" | "ignored" };
export type BuiltinTemplate = { key: string; name: string; version: number; mapping: Mapping; fields: PartnerField[] };

const DRDR_DESTINATIONS: PartnerField[] = [
  { source: "نام", to: "name" },
  { source: "تخصص", to: "speciality" },
  { source: "تلفن", to: "phone" },
  { source: "معرفی پزشک", to: "bio" },
  { source: "بیماری ها", to: "diseases" },
  { source: "خدمات", to: "services" },
  { source: "لوکیشن", to: "location" },
  { source: "آدرس", to: "address" },
  { source: "عکس", to: "photo" },
  { source: "لینک پروفایل", to: "ignored" },
];
// the fixed field names of a DrDr record
export const DRDR_FIELDS = DRDR_DESTINATIONS.map((f) => f.source);
export const DRDR_LIST_PATH = "groups[].items[]";

const drdrMapping: Mapping = {
  version: 1,
  options: { autoCreate: true },
  lists: [
    {
      path: DRDR_LIST_PATH,
      kind: "doctor",
      fields: {
        externalId: { sources: ["نام", "تلفن"], join: "|", extract: "hashId", prefix: "drdr:" },
        firstName: { source: "نام", transforms: ["trim", "stripTitle"], split: { by: " ", index: 0 } },
        lastName: { source: "نام", transforms: ["trim", "stripTitle"], split: { by: " ", index: 1, rest: true } },
        medicalTitle: { constant: "پزشکی" },
        mainSpeciality: { source: "تخصص" },
        bio: { source: "معرفی پزشک" },
        photo: { source: "عکس", extract: "imageUrl" },
        phone: { source: "تلفن", transforms: ["phone"] },
        address: { source: "آدرس", transforms: ["trim"] },
        point: { source: "لوکیشن" },
        services: { source: "خدمات", extract: "joinedList" },
        diseases: { source: "بیماری ها", extract: "joinedList" },
      },
      children: [],
    },
  ],
};

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [{ key: "drdr", name: "DrDr (دکتر دکتر)", version: 2, mapping: drdrMapping, fields: DRDR_DESTINATIONS }];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// which built-in template an uploaded file belongs to: by the records'
// fixed field names (the file's metadata is not relied on)
export const detectBuiltinTemplate = (root: unknown): string | undefined => {
  if (!isObject(root) || !Array.isArray(root.groups)) return undefined;
  const items = root.groups.flatMap((g) => (isObject(g) && Array.isArray(g.items) ? g.items.filter(isObject) : [])).slice(0, 20);
  if (!items.length) return undefined;
  const fits = items.filter((r) => DRDR_FIELDS.filter((f) => f in r).length >= 6).length;
  return fits >= Math.ceil(items.length / 2) ? "drdr" : undefined;
};
