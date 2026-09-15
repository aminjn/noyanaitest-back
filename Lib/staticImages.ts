import StaticImages, { IStaticImages } from "../Models/StaticImages";

// Small read helper for the public-facing pages (home/about/onboarding -
// see Controllers/publicController.ts) that display the admin-managed
// static image slots from Models/StaticImages.ts. The admin panel itself
// reads/writes the singleton via the generic route (/auto/staticImages,
// see Routers/autoRouter.ts), which upserts the doc on first access; until
// an admin visits that page at least once this returns null, and callers
// should treat every field as optional.
export const getStaticImages = async (): Promise<IStaticImages | null> =>
  StaticImages.findOne();
