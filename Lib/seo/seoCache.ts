import type mongoose from "mongoose";

// The resolved-SEO cache (2026-10), kept in its own import-free module so
// the models that feed it (PageMeta, SeoTemplate) can clear it on every
// write without a circular import through the resolver.
export const seoCache = new Map<string, { at: number; value: unknown }>();
export const clearSeoCache = () => seoCache.clear();

// any write to the schema's documents drops the cache, so an admin's edit
// shows on the public page at once instead of after the 5-minute TTL.
export const clearsSeoCache = (schema: mongoose.Schema) => {
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
    schema.post(op as any, clearSeoCache);
};
