import { translatable } from "../Lib/i18n/translatable";
import { IProviderStatusFields, providerStatusPlugin } from "../Lib/providerStatus";
import mongoose, { Model } from "mongoose";
import { CentreLicenceSchema, ICentreLicence } from "./CentreLicence";
import { IUser, MongoDoc } from "./User";
import { IInsuranceCategory } from "./InsuranceCategory";
import { IInsuranceTag } from "./InsuranceTag";
import { centreLicenceLockPlugin } from "../Lib/centreLicenceLock";

export interface IInsurance extends MongoDoc, IProviderStatusFields {
  user?: IUser;
  // the operating licence the staff verified: the verified tick
  // (Models/CentreLicence.ts, Lib/centreVerified.ts)
  licence?: ICentreLicence;
  name?: string;
  active: boolean;
  order: number;
  category?: IInsuranceCategory;
  // a basic (public) insurer - Tamin, Salamat, the armed forces' - as
  // opposed to a supplementary one; a centre's «بیمه پایه» follows it
  isBasic?: boolean;
  slug?: string;
  tags: IInsuranceTag[];
  establishment?: string;
  // «شماره‌ی مجوز بیمه مرکزی» (2026-10): from the become-insurer request on
  // approval (or the admin); shown on the public page
  licenseNumber?: string;
  // an outside fact the insurer states; its network on the site (doctors,
  // centres) is counted live - see Lib/insuranceNetwork.ts
  membersCount?: string;
  image?: string;
  phone?: string;
  summary?: string;
  coverages: string[];
  advantages: string[];
  website?: string;
  address?: string;
  location?: { type: "Point"; coordinates?: [number, number] };
  averageScore: number;
  commentCount: number;
}

const InsuranceSchema = new mongoose.Schema<IInsurance, Model<IInsurance>>(
  {
    // written by the admin / the request approval only (Lib/centreVerified.ts)
    licence: { type: CentreLicenceSchema },
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
    isBasic: { type: Boolean, default: false },
    slug: { type: String, unique: true, sparse: true },
    tags: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "InsuranceTag", required: true },
      ],
      default: [],
    },
    establishment: { type: String },
    licenseNumber: { type: String, trim: true, maxlength: 60 },
    membersCount: { type: String },
    image: { type: String },
    phone: { type: String },
    summary: { type: String },
    coverages: { type: [String], default: [] },
    advantages: { type: [String], default: [] },
    website: { type: String },
    address: { type: String },
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number] },
    },
    averageScore: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

InsuranceSchema.index({ location: "2dsphere" });

InsuranceSchema.virtual("plans", {
  ref: "InsurancePlan",
  localField: "_id",
  foreignField: "insurance",
});

InsuranceSchema.plugin(translatable);

// the licence number and the licence record change only through the
// super admin's licence endpoint or a become-request's approval
// (Lib/centreLicenceLock.ts)
InsuranceSchema.plugin(centreLicenceLockPlugin, { numberField: "licenseNumber" });
// suspension by an admin, distinct from draft (Lib/providerStatus.ts)
InsuranceSchema.plugin(providerStatusPlugin, { activeField: "active" });

// an insurer turned basic (or not) changes «بیمه پایه» on every centre
// that accepts it (Models/Paraclinic.ts derives it)
InsuranceSchema.post("findOneAndUpdate", async function (doc: any) {
  const update = (this.getUpdate() || {}) as Record<string, any>;
  const set = update.$set || update;
  if (!doc?._id || set.isBasic === undefined) return;
  const ParaClinic = mongoose.model("ParaClinic");
  const centres = await ParaClinic.find({ insurances: doc._id }).select("insurances").lean<{ _id: unknown; insurances?: unknown[] }[]>();
  for (const c of centres) {
    const basic = !!(await mongoose.model("Insurance").exists({ _id: { $in: c.insurances || [] }, isBasic: true }));
    await ParaClinic.collection.updateOne({ _id: c._id as any }, { $set: { basicInsurance: basic } });
  }
});

const Insurance = mongoose.model("Insurance", InsuranceSchema);

export default Insurance;
