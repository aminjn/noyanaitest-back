import Redirection from "../Models/Redirection";
import PageMeta from "../Models/PageMeta";
import { normalizePath } from "./normalizePath";

export { normalizePath };

// Public page of each model with a slug - the frontend route prefix and the
// PageMeta resourceType of its node page.
const publicPages: Record<string, { prefix: string; pageMeta?: string }> = {
  Blog: { prefix: "/mag", pageMeta: "/mag/[blogSlug]" },
  DoctorProfile: { prefix: "/dr", pageMeta: "/dr/[slug]" },
  Disease: { prefix: "/disease", pageMeta: "/disease/[slug]" },
  Drug: { prefix: "/drug", pageMeta: "/drug/[slug]" },
  Speciality: { prefix: "/speciality", pageMeta: "/speciality/[slug]" },
  Clinic: { prefix: "/clinic", pageMeta: "/clinic/[slug]" },
  Hospital: { prefix: "/hospital", pageMeta: "/hospital/[slug]" },
  ParaClinic: { prefix: "/paraClinic", pageMeta: "/paraClinic/[slug]" },
  Pharmacy: { prefix: "/pharmacy", pageMeta: "/pharmacy/[slug]" },
  Product: { prefix: "/product", pageMeta: "/product/[slug]" },
  ProductPackage: { prefix: "/productPackage", pageMeta: "/productPackage/[slug]" },
  Symptom: { prefix: "/symptom", pageMeta: "/symptom/[slug]" },
  Service: { prefix: "/service", pageMeta: "/service/[slug]" },
  ServicePackage: { prefix: "/servicePackage", pageMeta: "/servicePackage/[slug]" },
  Insurance: { prefix: "/insurance", pageMeta: "/insurance/[slug]" },
};

export const hasPublicPage = (modelName: string) => !!publicPages[modelName];


// A renamed slug must not break links and search results: the old URL gets
// a 301 to the new one (earlier redirects to the old URL are re-pointed, so
// there is never a chain or a loop) and the page's SEO meta moves with it.
export const recordSlugChange = async (
  modelName: string,
  oldSlug: string,
  newSlug: string,
) => {
  const page = publicPages[modelName];
  if (!page || !oldSlug || !newSlug || oldSlug === newSlug) return;
  const from = normalizePath(`${page.prefix}/${oldSlug}`);
  const to = normalizePath(`${page.prefix}/${newSlug}`);
  await Redirection.deleteOne({ old: to });
  await Redirection.updateMany({ current: from }, { $set: { current: to } });
  await Redirection.updateOne(
    { old: from },
    { $set: { current: to, statusCode: 301 } },
    { upsert: true },
  );
  if (page.pageMeta)
    await PageMeta.updateMany(
      { resourceType: page.pageMeta, slug: oldSlug },
      { $set: { slug: newSlug } },
    );
};
