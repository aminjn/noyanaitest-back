import mongoose from "mongoose";
import City from "../Models/Geo/City";
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
