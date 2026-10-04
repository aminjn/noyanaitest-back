import type mongoose from "mongoose";

// The medical directory's letter / facet cache (2026-10, Lib/medicalDirectory
// .ts), in its own import-free module so the models it counts can clear it
// on every write without a circular import: an admin's new disease, part or
// class shows in the directory at once instead of after the 5-minute TTL.
export const directoryCache = new Map<string, { at: number; value: unknown }>();
export const clearDirectoryCache = () => directoryCache.clear();

export const clearsDirectoryCache = (schema: mongoose.Schema) => {
  for (const op of [
    "save",
    "insertMany",
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "findOneAndDelete",
    "deleteOne",
    "deleteMany",
  ] as const)
    schema.post(op as any, clearDirectoryCache);
};
