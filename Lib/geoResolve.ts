import { provinces } from "./Provinces";
import { cities } from "./Cities";
import Province from "../Models/Geo/Province";
import City from "../Models/Geo/City";

const clean = (value: string) =>
  value.replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/[-_\s‌]+/g, " ").trim();

// The become-X forms store province/city as slugs of the static lists
// (Lib/Provinces.ts, Lib/Cities.ts), while profiles reference the Geo
// collections by id. This maps one to the other (by slug, then by name), so
// the location given at sign-up is kept when a profile is created from it.
export const resolveGeo = async (provinceSlug?: string, citySlug?: string) => {
  let province: { _id: unknown } | null = null;
  let city: { _id: unknown } | null = null;
  if (provinceSlug) {
    const name = provinces.find((p) => p.slug === provinceSlug)?.name || provinceSlug;
    province =
      (await Province.findOne({ slug: provinceSlug }).select("_id").lean()) ||
      (await Province.findOne({ name: { $in: [name, clean(name)] } }).select("_id").lean());
  }
  if (citySlug) {
    const name = cities.find((c) => c.slug === citySlug)?.name || citySlug;
    city = await City.findOne({
      name: { $in: [name, clean(name)] },
      ...(province ? { province: province._id } : {}),
    })
      .select("_id")
      .lean();
  }
  return { province: province?._id, city: city?._id };
};
