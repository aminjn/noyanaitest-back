import mongoose from "mongoose";
import BizItem from "../Models/BizItem";
import BizStockLot from "../Models/BizStockLot";

const oid = (v: unknown) =>
  new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));

// What a pharmacy cannot sell online right now (2026-10), like Halodoc /
// Digikala's "out of stock": a product the pharmacy keeps stock of in its
// inventory (a tracked BizItem - it has received a batch) with no unexpired
// batch left. A product it does not track is not judged (the pharmacy
// manages that one by switching its offer off). An expired batch is no stock:
// it cannot be dispensed.
export const outOfStockProducts = async (
  pharmacyId: unknown,
  productIds: unknown[],
): Promise<Set<string>> => {
  const ids = productIds
    .map((p) => String((p as { _id?: unknown })?._id ?? p))
    .filter((p) => mongoose.isValidObjectId(p));
  if (!pharmacyId || !ids.length) return new Set();
  const owner = { ownerKind: "pharmacy", ownerId: oid(pharmacyId) };
  const items = await BizItem.find({
    ...owner,
    product: { $in: ids.map(oid) },
    tracked: true,
  })
    .select("_id product")
    .lean();
  if (!items.length) return new Set();
  const now = new Date();
  const held = await BizStockLot.aggregate<{ _id: mongoose.Types.ObjectId; qty: number }>([
    {
      $match: {
        ...owner,
        item: { $in: items.map((i) => i._id) },
        qty: { $gt: 0 },
        $or: [{ expiry: { $exists: false } }, { expiry: null }, { expiry: { $gt: now } }],
      },
    },
    { $group: { _id: "$item", qty: { $sum: "$qty" } } },
  ]);
  const inStock = new Set(held.filter((h) => h.qty > 0).map((h) => String(h._id)));
  return new Set(
    items.filter((i) => !inStock.has(String(i._id))).map((i) => String(i.product)),
  );
};
