import mongoose from "mongoose";
import ServiceCategory from "../Models/ServiceCategory";

// The service catalogue (owner decision 2026-10, doctor audit 3.2e): a
// doctor's services are ServiceCategory references, the same records the
// `/book` service filter, the header search and the services page read. A
// doctor adds a missing one inline from the profile; it is live on that
// doctor's own page at once and stays out of the global lists (filters,
// header menu, search) until an admin approves it or merges it into an
// existing entry (Controllers/serviceCatalogController.ts).

// what the global lists show: active and reviewed
export const PUBLIC_SERVICE_CATEGORY = {
  isActive: true,
  pendingReview: { $ne: true },
} as const;

const ZERO_WIDTH = /[​-‏‪-‮⁠﻿]/g;
const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;

// the stored form: Persian letters, one space between words
export const cleanServiceTitle = (value: unknown) =>
  typeof value !== "string"
    ? ""
    : value
        .normalize("NFKC")
        .replace(/[يى]/g, "ی")
        .replace(/ك/g, "ک")
        .replace(/ـ/g, "")
        .replace(/[​‍-‏‪-‮⁠﻿]/g, "")
        .replace(/\s+/g, " ")
        .trim();

// the comparison key: also blind to case, spaces, half-spaces (ZWNJ) and
// diacritics - «لیزر موهای‌زائد», «ليزر  موهاي زائد» and «لیزرموهایزائد»
// are one service
export const serviceNameKey = (value: unknown) =>
  cleanServiceTitle(value)
    .replace(ZERO_WIDTH, "")
    .replace(DIACRITICS, "")
    .replace(/\s+/g, "")
    .toLowerCase();

// a typed search that ignores the ی/ي and ک/ك variants and half-spaces
// (a literal U+200C: MongoDB's PCRE does not read the JS \u escape)
export const looseServiceRegex = (query: string) => {
  const key = cleanServiceTitle(query).replace(ZERO_WIDTH, "");
  return key
    .split("")
    .map((ch) => {
      if (ch === "ی") return "[یيى]";
      if (ch === "ک") return "[کك]";
      if (/\s/.test(ch)) return "[\\s\u200c]*";
      return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("\u200c?");
};

type CatalogRow = {
  _id: mongoose.Types.ObjectId;
  title?: string;
  isActive?: boolean;
  pendingReview?: boolean;
  suggestedBy?: mongoose.Types.ObjectId;
  translations?: Record<string, { title?: unknown } | undefined>;
};

const keysOf = (row: CatalogRow) => [
  serviceNameKey(row.title),
  ...Object.values(row.translations || {}).map((t) => serviceNameKey(t?.title)),
];

// the catalogue entry with this name (its Persian title or any of its
// translations), if there is one - an active one first
export const findServiceCategoryByName = async (
  title: string,
  exceptId?: unknown,
): Promise<CatalogRow | null> => {
  const key = serviceNameKey(title);
  if (!key) return null;
  const rows = await ServiceCategory.find(
    exceptId ? { _id: { $ne: exceptId } } : {},
  )
    .select("title isActive pendingReview suggestedBy translations")
    .sort({ isActive: -1, pendingReview: 1, order: 1, _id: 1 })
    .lean<CatalogRow[]>();
  return rows.find((row) => keysOf(row).includes(key)) || null;
};

// the entry for a name: the existing one, or a new one under review that
// the doctor who typed it already holds
export const ensureServiceCategory = async (
  rawTitle: unknown,
  suggestedBy?: unknown,
): Promise<{ node: CatalogRow; created: boolean } | null> => {
  const title = cleanServiceTitle(rawTitle);
  if (!serviceNameKey(title)) return null;
  const existing = await findServiceCategoryByName(title);
  if (existing) return { node: existing, created: false };
  const created = await ServiceCategory.create({
    title,
    isActive: true,
    pendingReview: true,
    ...(suggestedBy ? { suggestedBy } : {}),
  });
  return { node: created.toObject() as unknown as CatalogRow, created: true };
};

// one id list, unique, order kept; bad entries (an old free-text string, a
// null) dropped
export const serviceIdList = (value: unknown): mongoose.Types.ObjectId[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: mongoose.Types.ObjectId[] = [];
  for (const el of value) {
    const raw = (el as { _id?: unknown })?._id ?? el;
    const id = String(raw ?? "");
    if (!mongoose.isValidObjectId(id) || !/^[a-f\d]{24}$/i.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(new mongoose.Types.ObjectId(id));
  }
  return out;
};
