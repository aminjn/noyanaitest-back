import mongoose from "mongoose";
import Province from "../Models/Geo/Province";
import City from "../Models/Geo/City";
import District from "../Models/Geo/District";
import {
  getNexaMapSettings,
  LatLng,
  resolveDivisions,
  reverseGeocode,
  DivisionRef,
  ReverseResult,
} from "./nexamap";
import { clearGeoCandidateCache, divisionsForPoint, matchDivision } from "./geoFromPoint";

// Everything a form needs from one map pin (2026-10): the written address,
// province / city / neighbourhood as our records, the postal code when
// NexaMap knows it, and the traffic zone. Used by the user's addresses and
// every provider location form, so a person only types what the map can't
// know (plaque, unit, postal code).
//
// NexaMap first (reverse geocode + divisions). A province or city NexaMap
// names that we have no record for yet is created on the spot (NexaMap's
// country divisions are the reference), so an address always gets both.
// With NexaMap off or failing, our own drawn boundaries answer.

export type LocatedPoint = {
  address: string | null;
  components: Record<string, string>;
  postalCode: string | null;
  plusCode: string | null;
  trafficZone: string | null;
  province: { _id: string; name: string } | null;
  city: { _id: string; name: string } | null;
  district: { _id: string; name: string } | null;
  source: "nexamap" | "local";
};

const POSTAL_KEYS = ["postal_code", "postcode", "postalCode", "zip"];

const ensureDivision = async (
  kind: "province" | "city" | "district",
  ref: DivisionRef | null | undefined,
  parent?: mongoose.Types.ObjectId,
): Promise<mongoose.Types.ObjectId | undefined> => {
  if (!ref?.name) return undefined;
  const found = await matchDivision(kind, ref, parent);
  if (found) return found;
  if (kind !== "province" && !parent) return undefined;
  const doc: Record<string, unknown> = { name: ref.name, nexamapId: ref.id || undefined, isActive: true };
  if (kind === "city") doc.province = parent;
  if (kind === "district") doc.city = parent;
  const model = kind === "province" ? Province : kind === "city" ? City : District;
  try {
    const created = await (model as unknown as mongoose.Model<{ _id: mongoose.Types.ObjectId }>).create(doc);
    clearGeoCandidateCache();
    return created._id;
  } catch {
    return undefined;
  }
};

const nameOf = async (
  model: mongoose.Model<any>,
  id?: mongoose.Types.ObjectId,
): Promise<{ _id: string; name: string } | null> => {
  if (!id) return null;
  const doc = await model.findById(id).select("name").lean<{ _id: unknown; name?: string }>();
  return doc ? { _id: String(doc._id), name: doc.name || "" } : null;
};

export const locatePoint = async (point: LatLng): Promise<LocatedPoint> => {
  let reverse: ReverseResult | null = null;
  let source: LocatedPoint["source"] = "local";
  let ids: { province?: mongoose.Types.ObjectId; city?: mongoose.Types.ObjectId; district?: mongoose.Types.ObjectId } = {};

  const settings = await getNexaMapSettings().catch(() => null);
  if (settings?.enabled) {
    const [rev, div] = await Promise.allSettled([reverseGeocode(point), resolveDivisions(point)]);
    if (rev.status === "fulfilled") {
      reverse = rev.value;
      source = "nexamap";
    }
    if (div.status === "fulfilled" && div.value) {
      source = "nexamap";
      const province = await ensureDivision("province", div.value.province);
      const city = await ensureDivision("city", div.value.city, province);
      const district = city ? await ensureDivision("district", div.value.district, city) : undefined;
      ids = { province, city, district };
    }
  }
  // whatever NexaMap couldn't give, from our own boundaries
  if (!ids.province || !ids.city || !ids.district) {
    const own = await divisionsForPoint(point);
    ids = {
      province: ids.province || own.province,
      city: ids.city || own.city,
      district: ids.district || (ids.city && own.city && String(own.city) !== String(ids.city) ? undefined : own.district),
    };
  }

  const [province, city, district] = await Promise.all([
    nameOf(Province, ids.province),
    nameOf(City, ids.city),
    nameOf(District, ids.district),
  ]);

  const components = (reverse?.components || {}) as Record<string, string>;
  const postal = POSTAL_KEYS.map((k) => components[k]).find((v) => typeof v === "string" && v.trim());
  const postalDigits = postal ? postal.replace(/\D/g, "") : "";

  // no written address from NexaMap: the divisions are still a start
  const composed = [province?.name, city?.name !== province?.name ? city?.name : null, district?.name]
    .filter(Boolean)
    .join("، ");

  return {
    address: reverse?.formatted_address || composed || null,
    components,
    postalCode: postalDigits.length === 10 ? postalDigits : null,
    plusCode: reverse?.plus_code || null,
    trafficZone: reverse?.extras?.in_traffic_zone || null,
    province,
    city,
    district,
    source,
  };
};
