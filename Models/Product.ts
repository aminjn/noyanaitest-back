import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPharmacy } from "./Pharmacy";
import { IProductCategory } from "./ProductCategory";
import { IProductImage } from "./ProductImage";
import { IDrug } from "./Drug";

// Prescription-only products (2026-10, after Halodoc / Vezeeta / DrDr):
//   auto -> follows the linked Drug (prescriptionStatus "rx" => required)
//   rx   -> the admin marks it prescription-only regardless of the drug
//   otc  -> the admin marks it sold freely regardless of the drug
// The effective answer is the `requiresPrescription` virtual below; it needs
// `drug` populated (select "prescriptionStatus") when the setting is "auto"
// - see Lib/rxPrescription.ts productRxPopulate.
export const productPrescriptionModes = ["auto", "rx", "otc"] as const;
export type ProductPrescriptionMode = (typeof productPrescriptionModes)[number];

export interface IProduct extends MongoDoc {
  name?: string;
  slug?: string;
  image?: string;
  order: number;
  isActive: boolean;
  category: IProductCategory;
  summary?: string;
  description?: string;
  whyChoose?: string;
  details?: string;
  usage?: string;
  warning?: string;
  special: boolean;
  original?: string;
  sameAs: IProduct[];
  price: number;
  averageScore: number;
  commentCount: number;
  // the medicine this product sells, if it is one (Models/Drug.ts)
  drug?: IDrug | mongoose.Types.ObjectId | null;
  prescriptionRequired?: ProductPrescriptionMode;
  // virtual - see productPrescriptionModes
  requiresPrescription?: boolean;
}

const ProductSchema = new mongoose.Schema<IProduct, Model<IProduct>>(
  {
    image: { type: String },
    name: { type: String, required: [true, "نام الزامی است"], trim: true },
    slug: { type: String, unique: true, sparse: true },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: false },
    category: { type: mongoose.Schema.ObjectId, ref: "ProductCategory" },
    summary: { type: String },
    description: { type: String },
    whyChoose: { type: String },
    details: { type: String },
    usage: { type: String },
    warning: { type: String },
    original: { type: String },
    sameAs: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "Product", required: true },
      ],
      default: [],
    },
    price: { type: Number, default: 0 },
    averageScore: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    drug: {
      type: mongoose.Schema.ObjectId,
      ref: "Drug",
      // the admin form sends "" when the link is cleared
      set: (v: unknown) => (v === "" ? null : v),
    },
    prescriptionRequired: {
      type: String,
      enum: productPrescriptionModes,
      default: "auto",
      set: (v: unknown) => (v === "" || v == null ? "auto" : v),
    },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

ProductSchema.virtual("images", {
  ref: "ProductImage",
  localField: "_id",
  foreignField: "product",
});

ProductSchema.virtual("specs", {
  ref: "ProductSpec",
  localField: "_id",
  foreignField: "product",
});

ProductSchema.virtual("sellers", {
  ref: "ProductSeller",
  localField: "_id",
  foreignField: "product",
});

ProductSchema.virtual("requiresPrescription").get(function (this: IProduct) {
  if (this.prescriptionRequired === "rx") return true;
  if (this.prescriptionRequired === "otc") return false;
  const drug = this.drug as { prescriptionStatus?: string } | null | undefined;
  return !!drug && typeof drug === "object" && drug.prescriptionStatus === "rx";
});

ProductSchema.plugin(translatable);

const Product = mongoose.model("Product", ProductSchema);

export default Product;
