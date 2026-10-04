import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// Noyan Business inventory (2026-10, docs/business-suite.md phase 2): one
// stock item of one owner. A pharmacy's items are made from the products it
// sells (product links the global catalog entry, so a sale deducts stock
// with no re-entry); a lab or clinic adds its kits and consumables by hand.
// "goods" are sold (inventory -> cost of goods sold); "supply" items are
// used up in the work (medical supplies -> supplies expense).
export const bizItemKinds = ["goods", "supply"] as const;
// a pharmacy's drug class (2026-10, the per-profile chart): each keeps its
// own inventory and cost-of-sales account (1601/1603/1604, 7301/7302/7303)
export const bizItemClasses = ["drug", "otc", "cosmetic"] as const;

export interface IBizItem extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  kind: (typeof bizItemKinds)[number];
  itemClass?: (typeof bizItemClasses)[number];
  product?: mongoose.Types.ObjectId;
  sku?: string;
  barcode?: string;
  unit: string;
  // reorder when stock falls to this; fill up to maxStock (nexxacrm
  // reorder-core); 0 = not set
  reorderPoint: number;
  maxStock: number;
  // the last purchase price, for a shortage and for a purchase suggestion
  lastCost: number;
  // becomes true with the first receipt: only then does a sale deduct stock
  tracked: boolean;
  isActive: boolean;
  createdAt: Date;
}

const BizItemSchema = new mongoose.Schema<IBizItem, Model<IBizItem>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    kind: { type: String, enum: bizItemKinds, default: "goods" },
    itemClass: { type: String, enum: bizItemClasses },
    product: { type: mongoose.Schema.ObjectId, ref: "Product" },
    sku: { type: String, trim: true, maxlength: 60 },
    barcode: { type: String, trim: true, maxlength: 60 },
    unit: { type: String, trim: true, maxlength: 30, default: "" },
    reorderPoint: { type: Number, default: 0, min: 0 },
    maxStock: { type: Number, default: 0, min: 0 },
    lastCost: { type: Number, default: 0, min: 0 },
    tracked: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

BizItemSchema.index({ ownerKind: 1, ownerId: 1, name: 1 });
BizItemSchema.index(
  { ownerKind: 1, ownerId: 1, product: 1 },
  { unique: true, partialFilterExpression: { product: { $exists: true } } },
);

const BizItem = mongoose.model("BizItem", BizItemSchema);
export default BizItem;
