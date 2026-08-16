import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IService } from "./Service";
import { IDoctorProfile } from "./DoctorProfile";
import { IServiceCategory } from "./ServiceCategory";

export interface IServicePackage extends MongoDoc {
  name?: string;
  owner: IDoctorProfile;
  services: IService[];
  price: number;
  discount: number;
  category: IServiceCategory;
  isActive: boolean;
  order: number;
  image: string;
  slug?: string;
  sameAs: IServicePackage[];
  summary?: string;
  description?: string;
  whyChoose?: string;
  stages?: string;
  results?: string;
}

const ServicePackageSchema = new mongoose.Schema<
  IServicePackage,
  Model<IServicePackage>
>(
  {
    owner: {
      type: mongoose.Schema.ObjectId,
      ref: "DoctorProfile",
      required: true,
    },
    services: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "Service", required: true },
      ],
      default: [],
    },
    price: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    category: { type: mongoose.Schema.ObjectId, ref: "ServiceCategory" },
    isActive: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    image: { type: String },
    name: { type: String },
    slug: { type: String, unique: true, sparse: true },
    sameAs: {
      type: [
        {
          type: mongoose.Schema.ObjectId,
          ref: "ServicePackage",
          required: true,
        },
      ],
      default: [],
    },
    description: { type: String },
    whyChoose: { type: String },
    stages: { type: String },
    results: { type: String },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

ServicePackageSchema.virtual("specs", {
  ref: "ProductSpec",
  localField: "_id",
  foreignField: "product",
});

ServicePackageSchema.virtual("images", {
  ref: "ProductImage",
  localField: "_id",
  foreignField: "product",
});

const ServicePackage = mongoose.model("ServicePackage", ServicePackageSchema);

export default ServicePackage;
