import mongoose from "mongoose";

// Tipax delivery confirmation (2026-10), the pure lookups - the actions,
// the auto-confirm sweep and the migration are in
// Services/shipmentDeliveryService.ts.
//
// An inter-city Tipax parcel (Lib/delivery.ts) is "delivered" only once it
// is confirmed: by the buyer, automatically some days after it was sent, or
// by support. Until then the pharmacy's fulfilled lines in it are prepared
// and on their way, not delivered: no payout (no settlement hold yet), no
// "rate this pharmacy" ask, and they do not back a verified review. A Tapsi
// (same-city) shipment has no such step: its lines count when fulfilled, as
// before (the Snapp Box ride state is only polled on demand, it is not a
// delivery signal anyone confirms).

type Id = mongoose.Types.ObjectId | string;

export type ShipmentLike = {
  _id?: unknown;
  pharmacy?: unknown;
  method?: string;
  shippedAt?: Date | string;
  deliveredAt?: Date | string;
  returnedAt?: Date | string;
};

const idOf = (value: unknown) =>
  value ? String((value as { _id?: unknown })?._id ?? value) : "";

// a Tipax shipment that has not been confirmed delivered (sent or not yet)
export const awaitsDelivery = (shipment: ShipmentLike | null | undefined) =>
  !!shipment && shipment.method === "tipax" && !shipment.deliveredAt;

// the pharmacies of an order whose Tipax parcel still awaits its delivery
export const undeliveredPharmacies = (shipments: unknown): Set<string> =>
  new Set(
    (Array.isArray(shipments) ? (shipments as ShipmentLike[]) : [])
      .filter(awaitsDelivery)
      .map((s) => idOf(s.pharmacy))
      .filter(Boolean),
  );

// the pharmacy a products / productPackages line was bought from
export const pharmacyOfLine = async (
  model: string,
  itemId: Id,
): Promise<string> => {
  if (model === "products") {
    const doc = await mongoose
      .model("ProductSeller")
      .findById(itemId)
      .select("seller")
      .lean<{ seller?: unknown }>();
    return idOf(doc?.seller);
  }
  if (model === "productPackages") {
    const doc = await mongoose
      .model("ProductPackage")
      .findById(itemId)
      .select("owner")
      .lean<{ owner?: unknown }>();
    return idOf(doc?.owner);
  }
  return "";
};

// A fulfilled pharmacy line whose Tipax parcel is not confirmed delivered:
// its payout and review ask wait for the delivery. Reads the order's
// shipments fresh, so a line fulfilled at the moment its parcel is
// confirmed is settled by one of the two (both paths are idempotent).
export const lineAwaitsDelivery = async (
  orderId: unknown,
  model: string,
  itemId: Id,
): Promise<boolean> => {
  if (model !== "products" && model !== "productPackages") return false;
  const order = await mongoose
    .model("Order")
    .findById(orderId)
    .select("shipments")
    .lean<{ shipments?: ShipmentLike[] }>();
  const waiting = undeliveredPharmacies(order?.shipments);
  if (!waiting.size) return false;
  return waiting.has(await pharmacyOfLine(model, itemId));
};

// The item ids (ProductSeller / ProductPackage) of an order's lines that
// belong to one of `pharmacies`: which lines of an order a review or a
// settlement must treat as "not delivered yet".
export const itemsOfPharmacies = async (
  order: { products?: { item?: unknown }[]; productPackages?: { item?: unknown }[] },
  pharmacies: Set<string>,
): Promise<Set<string>> => {
  if (!pharmacies.size) return new Set();
  const ids = [...pharmacies].filter((id) => mongoose.isValidObjectId(id));
  const [sellers, packages] = await Promise.all([
    mongoose
      .model("ProductSeller")
      .find({
        _id: { $in: (order.products || []).map((l) => idOf(l?.item)).filter(Boolean) },
        seller: { $in: ids },
      })
      .distinct("_id"),
    mongoose
      .model("ProductPackage")
      .find({
        _id: { $in: (order.productPackages || []).map((l) => idOf(l?.item)).filter(Boolean) },
        owner: { $in: ids },
      })
      .distinct("_id"),
  ]);
  return new Set([...sellers, ...packages].map(String));
};
