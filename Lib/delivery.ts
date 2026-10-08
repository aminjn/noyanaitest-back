import mongoose from "mongoose";
import City from "../Models/Geo/City";
import Province from "../Models/Geo/Province";
import { divisionsForPoint } from "./geoFromPoint";
import { fromCoordinates } from "./nexamap";
import DeliverySettings, {
  DEFAULT_TAPSI_FLAT_FEE,
} from "../Models/DeliverySettings";

export const deliveryMethods = ["tapsi", "tipax"] as const;
export type DeliveryMethod = (typeof deliveryMethods)[number];

type Id = mongoose.Types.ObjectId | string;
type Place = {
  city?: unknown;
  location?: { coordinates?: number[] } | null;
};

export type ShipmentPlan = {
  pharmacy: Id;
  method: DeliveryMethod;
  // what the buyer pays on the site for this shipment
  fee: number;
  // the part of fee the platform pays for a «پرو» member (Lib/patientPro.ts)
  proDiscount?: number;
  // Tipax "pas-kerayeh": the buyer pays the courier on delivery
  payOnDelivery: boolean;
  originCity?: Id;
  destinationCity?: Id;
};

const idOf = (value: unknown) =>
  value ? String((value as { _id?: unknown })?._id ?? value) : undefined;

export const getDeliverySettings = async () => {
  const saved = await DeliverySettings.findOne({ singleton: "SINGLETON" }).lean();
  return {
    tapsiFlatFee: saved?.tapsiFlatFee ?? DEFAULT_TAPSI_FLAT_FEE,
    defaultOriginCity: saved?.defaultOriginCity,
  };
};

// the city a place is in: the one it names, else the city whose drawn shape
// holds its map pin, else the city NexaMap puts the pin in (matched to ours
// by NexaMap id / name, Lib/geoFromPoint.ts)
const resolveCity = async (place?: Place | null) => {
  if (!place) return undefined;
  const named = idOf(place.city);
  if (named) return named;
  const coords = place.location?.coordinates;
  if (!coords || coords.length !== 2) return undefined;
  const city = await City.findOne({
    geometry: {
      $geoIntersects: { $geometry: { type: "Point", coordinates: coords } },
    },
  })
    .select("_id")
    .lean();
  if (city) return String(city._id);
  const point = fromCoordinates(coords);
  if (!point) return undefined;
  // never throws: NexaMap down -> undefined (Tipax, as before)
  const found = await divisionsForPoint(point);
  return found.city ? String(found.city) : undefined;
};

// Owner decision (2026-09), like Digikala / Snappbox: every pharmacy in the
// cart is its own shipment.
//   same city as the buyer -> Tapsi, a flat fee (0 when the pharmacy offers
//     free delivery on everything it ships in this order)
//   another city, or a city we can't tell -> Tipax pay-on-delivery: the buyer
//     pays the courier, nothing is charged on the site
// A pharmacy without a city ships from the default origin (Tehran).
export const planDelivery = async (
  sellers: { pharmacy: Place & { _id: unknown }; freeDelivery: boolean }[],
  address?: Place | null,
): Promise<ShipmentPlan[]> => {
  if (!sellers.length) return [];
  const settings = await getDeliverySettings();
  let fallbackOrigin = idOf(settings.defaultOriginCity);
  if (!fallbackOrigin) {
    const tehran = await City.findOne({ name: "تهران" }).select("_id").lean();
    fallbackOrigin = tehran ? String(tehran._id) : undefined;
  }
  const destination = await resolveCity(address);
  const plans: ShipmentPlan[] = [];
  for (const { pharmacy, freeDelivery } of sellers) {
    const origin = (await resolveCity(pharmacy)) || fallbackOrigin;
    const sameCity = !!origin && !!destination && origin === destination;
    plans.push({
      pharmacy: String(pharmacy._id),
      method: sameCity ? "tapsi" : "tipax",
      fee: sameCity && !freeDelivery ? settings.tapsiFlatFee : 0,
      payOnDelivery: !sameCity,
      originCity: origin,
      destinationCity: destination,
    });
  }
  return plans;
};

// ---------------------------------------------------------------------------
// Delivery area (owner decision 2026-10), like Digikala's "ارسال به شهر شما"
// and Halodoc's per-pharmacy coverage: each pharmacy chooses where it ships
// (Models/Pharmacy.ts shippingScope):
//   city        only its own city (Tapsi)
//   selected    its own city plus the cities / provinces it picked
//   nationwide  anywhere (the default, how every pharmacy shipped before)
// Prescription-only items never travel between cities (no Tipax): they ship
// only to an address in the pharmacy's own city, whatever the scope.
// Checked on the server at checkout; the public pages only show a hint.

export type DeliveryBlockReason = "rxOwnCity" | "outsideArea" | "unknownCity";

export type DeliveryBlock = {
  pharmacy: string;
  reason: DeliveryBlockReason;
  // the pharmacy's city (where an Rx / city-only shipment can go)
  originCity?: string;
  // the buyer's city
  destinationCity?: string;
};

type AreaPharmacy = Place & {
  _id: unknown;
  shippingScope?: string;
  shipCities?: unknown[];
  shipProvinces?: unknown[];
};

const idsOf = (list: unknown) =>
  new Set((Array.isArray(list) ? list : []).map(idOf).filter((el): el is string => !!el));

const fallbackOriginCity = async () => {
  const settings = await getDeliverySettings();
  const saved = idOf(settings.defaultOriginCity);
  if (saved) return saved;
  const tehran = await City.findOne({ name: "تهران" }).select("_id").lean();
  return tehran ? String(tehran._id) : undefined;
};

// the province of the buyer's city: the address's own, else the city's
const provinceOf = async (address: (Place & { province?: unknown }) | null | undefined, city?: string) => {
  const named = idOf(address?.province);
  if (named) return named;
  if (!city) return undefined;
  const found = await City.findById(city).select("province").lean();
  return found ? idOf(found.province) : undefined;
};

// Can `pharmacy` ship to a buyer in `destination` (city id; undefined = we
// can't tell)? `rx`: the shipment holds a prescription-only item.
export const deliveryAreaReason = (
  pharmacy: AreaPharmacy,
  origin: string | undefined,
  destination: string | undefined,
  destinationProvince: string | undefined,
  rx: boolean,
): DeliveryBlockReason | null => {
  const scope = pharmacy.shippingScope || "nationwide";
  if (!rx && scope === "nationwide") return null;
  if (!destination) return "unknownCity";
  const sameCity = !!origin && origin === destination;
  if (rx) return sameCity ? null : "rxOwnCity";
  if (sameCity) return null;
  if (scope === "selected") {
    if (idsOf(pharmacy.shipCities).has(destination)) return null;
    if (destinationProvince && idsOf(pharmacy.shipProvinces).has(destinationProvince)) return null;
  }
  return "outsideArea";
};

// every shipment of the cart that can't go to `address` (empty = all fine)
export const deliveryAreaBlocks = async (
  sellers: { pharmacy: AreaPharmacy; rx?: boolean }[],
  address?: (Place & { province?: unknown }) | null,
): Promise<DeliveryBlock[]> => {
  if (!sellers.length || !address) return [];
  const destination = await resolveCity(address);
  const destinationProvince = await provinceOf(address, destination);
  let fallback: string | undefined | null = null;
  const blocks: DeliveryBlock[] = [];
  for (const { pharmacy, rx } of sellers) {
    let origin = await resolveCity(pharmacy);
    if (!origin) {
      if (fallback === null) fallback = await fallbackOriginCity();
      origin = fallback;
    }
    const reason = deliveryAreaReason(pharmacy, origin, destination, destinationProvince, !!rx);
    if (reason)
      blocks.push({
        pharmacy: String(pharmacy._id),
        reason,
        originCity: origin,
        destinationCity: destination,
      });
  }
  return blocks;
};

// What a public page shows about where a pharmacy ships: its scope, its own
// city and, for "selected", the cities / provinces it covers (names in the
// request's language through the translatable plugin's populate).
export type DeliveryAreaSummary = {
  scope: string;
  city?: { _id: string; name?: string };
  cities: { _id: string; name?: string }[];
  provinces: { _id: string; name?: string }[];
};

export const deliveryAreasOf = async (
  pharmacies: AreaPharmacy[],
): Promise<Map<string, DeliveryAreaSummary>> => {
  const cityIds = new Set<string>();
  const provinceIds = new Set<string>();
  for (const el of pharmacies) {
    const own = idOf(el.city);
    if (own) cityIds.add(own);
    if (el.shippingScope === "selected") {
      idsOf(el.shipCities).forEach((id) => cityIds.add(id));
      idsOf(el.shipProvinces).forEach((id) => provinceIds.add(id));
    }
  }
  const [cities, provinces] = await Promise.all([
    cityIds.size
      ? City.find({ _id: { $in: [...cityIds] } }).select("name")
      : Promise.resolve([]),
    provinceIds.size
      ? Province.find({ _id: { $in: [...provinceIds] } }).select("name")
      : Promise.resolve([]),
  ]);
  const cityName = new Map(
    cities.map((el) => [String(el._id), (el.toJSON() as { name?: string }).name]),
  );
  const provinceName = new Map(
    provinces.map((el) => [String(el._id), (el.toJSON() as { name?: string }).name]),
  );
  const out = new Map<string, DeliveryAreaSummary>();
  for (const el of pharmacies) {
    const scope = el.shippingScope || "nationwide";
    const own = idOf(el.city);
    out.set(String(el._id), {
      scope,
      city: own && cityName.has(own) ? { _id: own, name: cityName.get(own) } : undefined,
      cities:
        scope === "selected"
          ? [...idsOf(el.shipCities)].filter((id) => cityName.has(id)).map((id) => ({ _id: id, name: cityName.get(id) }))
          : [],
      provinces:
        scope === "selected"
          ? [...idsOf(el.shipProvinces)]
              .filter((id) => provinceName.has(id))
              .map((id) => ({ _id: id, name: provinceName.get(id) }))
          : [],
    });
  }
  return out;
};

// Pharmacies saved before the delivery-area setting keep shipping the way
// they did: anywhere (Tapsi in their city, Tipax elsewhere). Idempotent.
export const migratePharmacyShippingScope = async () => {
  const { default: Pharmacy } = await import("../Models/Pharmacy");
  await Pharmacy.updateMany(
    { shippingScope: { $exists: false } },
    { $set: { shippingScope: "nationwide" } },
  );
};
