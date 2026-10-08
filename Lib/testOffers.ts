import mongoose from "mongoose";
import ParaClinicTest from "../Models/ParaClinicTest";
import ParaClinic from "../Models/Paraclinic";

// The labs that offer one test right now (2026-10, the /test/<slug> page,
// its SEO and the lab list opened for a test): an offer the lab has not
// paused, with a real price, at a lab that is public. One rule for the
// page, its structured data and its "from X toman" title.

export type LiveTestOffer = {
  _id: mongoose.Types.ObjectId;
  price: number;
  readyTime?: string;
  paraClinic: Record<string, any>;
};

const LAB_FIELDS =
  "name slug image province city district address phone location averageScore commentCount reviewCount translations";

// a lab's review score and count, whichever field the reviews module fills
// (reviewCount is the newer one; commentCount the older)
export const labRating = (lab: Record<string, any> | null | undefined) => {
  const count = Number(lab?.reviewCount ?? lab?.commentCount ?? 0) || 0;
  const score = Number(lab?.averageScore ?? 0) || 0;
  return count > 0 && score > 0 ? { score, count } : { score: 0, count: 0 };
};

export const liveTestOffers = async (
  testId: unknown,
  { city }: { city?: string } = {},
): Promise<LiveTestOffer[]> => {
  const labFilter: Record<string, unknown> = { active: true };
  if (city && mongoose.isValidObjectId(city)) labFilter.city = new mongoose.Types.ObjectId(city);
  const rows = (await ParaClinicTest.find({
    test: testId,
    isActive: { $ne: false },
    price: { $gte: 1 },
  })
    .select("price readyTime paraClinic")
    .populate({
      path: "paraClinic",
      match: labFilter,
      select: LAB_FIELDS,
      populate: [
        { path: "province", select: "name translations" },
        { path: "city", select: "name translations" },
        { path: "district", select: "name translations" },
      ],
    })
    .lean()) as unknown as LiveTestOffer[];
  return rows.filter((r) => r.paraClinic && typeof r.paraClinic === "object");
};

export type TestOfferSort = "price" | "rating";

// cheapest first; "rating": the best-reviewed first (a lab with no reviews
// yet after every reviewed one), then the cheaper
export const sortTestOffers = <T extends { price: number; paraClinic: Record<string, any> }>(
  offers: T[],
  sort: TestOfferSort = "price",
): T[] =>
  [...offers].sort((a, b) => {
    if (sort === "rating") {
      const ra = labRating(a.paraClinic);
      const rb = labRating(b.paraClinic);
      if (rb.score !== ra.score) return rb.score - ra.score;
      if (rb.count !== ra.count) return rb.count - ra.count;
    }
    return (Number(a.price) || 0) - (Number(b.price) || 0);
  });

// the cities the test is offered in (for the page's city filter), by name
export const offerCities = async (testId: unknown) => {
  const labs = await ParaClinicTest.distinct("paraClinic", {
    test: testId,
    isActive: { $ne: false },
    price: { $gte: 1 },
  });
  if (!labs.length) return [];
  const cities = await ParaClinic.distinct("city", { _id: { $in: labs }, active: true, city: { $ne: null } });
  if (!cities.length) return [];
  return mongoose
    .model("City")
    .find({ _id: { $in: cities } })
    .select("name translations")
    .sort({ name: 1 })
    .lean();
};
