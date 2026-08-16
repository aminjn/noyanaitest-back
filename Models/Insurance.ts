import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IInsuranceCategory } from "./InsuranceCategory";
import { IInsuranceTag } from "./InsuranceTag";

export interface IInsurance extends MongoDoc {
  user?: IUser;
  name?: string;
  active: boolean;
  order: number;
  category?: IInsuranceCategory;
  slug?: string;
  tags: IInsuranceTag[];
  establishment?: string;
  membersCount?: string;
  centersCount?: string;
  doctorsCount?: string;
  image?: string;
  phone?: string;
  summary?: string;
  pharmacyCount?: string;
  doctorCount?: string;
  hospitalCount?: string;
  coverages: string[];
  advantages: string[];
  website?: string;
  address?: string;
  location?: { type: "Point"; coordinates?: [number, number] };
}

const InsuranceSchema = new mongoose.Schema<IInsurance, Model<IInsurance>>(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      unique: true,
      sparse: true,
    },
    name: { type: String },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: false },
    category: { type: mongoose.Schema.ObjectId, ref: "InsuranceCategory" },
    slug: { type: String, unique: true, sparse: true },
    tags: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "InsuranceTag", required: true },
      ],
      default: [],
    },
    establishment: { type: String },
    membersCount: { type: String },
    centersCount: { type: String },
    doctorsCount: { type: String },
    image: { type: String },
    phone: { type: String },
    summary: { type: String },
    pharmacyCount: { type: String },
    doctorCount: { type: String },
    hospitalCount: { type: String },
    coverages: { type: [String], default: [] },
    advantages: { type: [String], default: [] },
    website: { type: String },
    address: { type: String },
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number] },
    },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

InsuranceSchema.index({ location: "2dsphere" });

InsuranceSchema.virtual("plans", {
  ref: "InsurancePlan",
  localField: "_id",
  foreignField: "insurance",
});

const Insurance = mongoose.model("Insurance", InsuranceSchema);

export default Insurance;
