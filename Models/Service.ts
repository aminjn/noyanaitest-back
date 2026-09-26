import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IServiceCategory } from "./ServiceCategory";
import { IServicePackage } from "./ServicePackage";

export interface IService extends MongoDoc {
  order: number;
  isActive: boolean;
  name?: string;
  owner?: IDoctorProfile;
  image?: string;
  price: number;
  discount: number;
  inventory: number;
  isHome: boolean;
  category?: IServiceCategory;
  special: boolean;
  slug?: string;
  description?: string;
  whyChoose?: string;
  stages?: string;
  results?: string;
  sameAs: IService[];
  averageScore: number;
  commentCount: number;
}

const ServiceSchema = new mongoose.Schema<IService, Model<IService>>(
  {
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: false },
    name: { type: String },
    owner: { type: mongoose.Schema.ObjectId, ref: "DoctorProfile" },
    image: { type: String },
    price: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    inventory: { type: Number, default: 0 },
    isHome: { type: Boolean, default: false },
    category: { type: mongoose.Schema.ObjectId, ref: "ServiceCategory" },
    special: { type: Boolean, default: false },
    slug: { type: String, unique: true, sparse: true },
    description: { type: String },
    whyChoose: { type: String },
    stages: { type: String },
    results: { type: String },
    sameAs: {
      type: [
        {
          type: mongoose.Schema.ObjectId,
          ref: "Service",
          required: true,
        },
      ],
      default: [],
    },
    averageScore: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
  },

  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

ServiceSchema.virtual("specs", {
  ref: "ProductSpec",
  localField: "_id",
  foreignField: "product",
});

ServiceSchema.virtual("images", {
  ref: "ProductImage",
  localField: "_id",
  foreignField: "product",
});

ServiceSchema.plugin(translatable);

const Service = mongoose.model("Service", ServiceSchema);

export default Service;
