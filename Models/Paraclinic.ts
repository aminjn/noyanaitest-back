import { OpeningHours, openingHoursPlugin } from "../Lib/openingHours";
import { translatable } from "../Lib/i18n/translatable";
import { IProviderStatusFields, providerStatusPlugin } from "../Lib/providerStatus";
import { geoFromPointPlugin } from "../Lib/geoFromPoint";
import mongoose, { Model } from "mongoose";
import { CentreLicenceSchema, ICentreLicence } from "./CentreLicence";
import { IUser, MongoDoc } from "./User";
import { IParaClinicTag } from "./ParaClinicTag";
import { IProvince } from "./Geo/Province";
import { ICity } from "./Geo/City";
import { IDistrict } from "./Geo/District";
import { IInsurance } from "./Insurance";
import { IParaClinicCategory } from "./ParaClinicCategory";
import { centreLicenceLockPlugin } from "../Lib/centreLicenceLock";

export interface IParaClinic extends MongoDoc, IProviderStatusFields {
  user?: IUser;
  // the operating licence the staff verified: the verified tick
  // (Models/CentreLicence.ts, Lib/centreVerified.ts)
  licence?: ICentreLicence;
  // the licence number (the siam code of the approved request), set by
  // the staff only
  licenseNumber?: string;
  name?: string;
  order: number;
  active: boolean;
  tags: IParaClinicTag[];
  location?: { type: "Point"; coordinates?: [number, number] };
  province?: IProvince;
  city?: ICity;
  district?: IDistrict;
  category?: IParaClinicCategory;
  special: boolean;
  image?: string;
  slug?: string;
  establishment?: string;
  businessTime?: string;
  // structured weekly hours (2026-10, Lib/openingHours.ts); the free text
  // above is kept as a note
  openingHours?: OpeningHours;
  isRoundTheClock?: boolean;
  phone?: string;
  onPremises: boolean;
  onlineResponse: boolean;
  basicInsurance: boolean;
  personelCount: number;
  summary?: string;
  insurances: IInsurance[];
  address?: string;
  averageScore: number;
  commentCount: number;
}

const ParaClinicSchema = new mongoose.Schema<IParaClinic, Model<IParaClinic>>(
  {
    // written by the admin / the request approval only (Lib/centreVerified.ts)
    licence: { type: CentreLicenceSchema },
    licenseNumber: { type: String, trim: true, maxlength: 60 },
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      unique: true,
      sparse: true,
    },
    name: { type: String },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: false },
    tags: {
      type: [
        {
          type: mongoose.Schema.ObjectId,
          ref: "ParaClinicTag",
          required: true,
        },
      ],
      default: [],
    },
    province: { type: mongoose.Schema.ObjectId, ref: "Province" },
    city: { type: mongoose.Schema.ObjectId, ref: "City" },
    district: { type: mongoose.Schema.ObjectId, ref: "District" },
    category: { type: mongoose.Schema.ObjectId, ref: "ParaClinicCategory" },
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number] },
    },
    special: { type: Boolean, default: false },
    image: { type: String },
    slug: { type: String, unique: true, sparse: true },
    establishment: { type: String },
    businessTime: { type: String },
    // open 24/7, as a pharmacy / clinic / hospital (2026-10): kept in
    // step with openingHours
    isRoundTheClock: { type: Boolean, default: false },
    phone: { type: String },
    onPremises: { type: Boolean, default: false },
    basicInsurance: { type: Boolean, default: false },
    onlineResponse: { type: Boolean, default: false },
    personelCount: { type: Number, default: 0 },
    summary: { type: String },
    insurances: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "Insurance", required: true },
      ],
      default: [],
    },
    address: { type: String },
    averageScore: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

ParaClinicSchema.index({ location: "2dsphere" });

ParaClinicSchema.virtual("images", {
  ref: "ProductImage",
  localField: "_id",
  foreignField: "product",
});

ParaClinicSchema.virtual("tests", {
  ref: "ParaClinicTest",
  localField: "_id",
  foreignField: "paraClinic",
});

ParaClinicSchema.plugin(translatable);

// the licence number and the licence record change only through the
// super admin's licence endpoint or a become-request's approval
// (Lib/centreLicenceLock.ts)
ParaClinicSchema.plugin(centreLicenceLockPlugin, { numberField: "licenseNumber" });
// structured opening hours and "open now", in step with isRoundTheClock
ParaClinicSchema.plugin(openingHoursPlugin, { roundTheClockField: "isRoundTheClock" });
// suspension by an admin, distinct from draft (Lib/providerStatus.ts)
ParaClinicSchema.plugin(providerStatusPlugin, { activeField: "active" });

// an empty province / city / district is filled from the map pin
// (Lib/geoFromPoint.ts)
ParaClinicSchema.plugin(geoFromPointPlugin, {
  modelName: "ParaClinic",
  fields: { province: "province", city: "city", district: "district" },
});

// «بیمه پایه» is derived from the insurers the centre accepts (2026-10): a
// toggle typed next to the list could say "yes" with no basic insurer in it
const deriveBasicInsurance = async (ids: unknown) => {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return false;
  return !!(await mongoose.model("Insurance").exists({ _id: { $in: list }, isBasic: true }));
};
ParaClinicSchema.pre("save", async function () {
  if (this.isNew || this.isModified("insurances"))
    this.set("basicInsurance", await deriveBasicInsurance(this.get("insurances")));
});
ParaClinicSchema.pre("findOneAndUpdate", async function () {
  const update = (this.getUpdate() || {}) as Record<string, any>;
  const set = update.$set || update;
  if ("basicInsurance" in set) delete set.basicInsurance;
  if (set.insurances !== undefined) set.basicInsurance = await deriveBasicInsurance(set.insurances);
});

const ParaClinic = mongoose.model("ParaClinic", ParaClinicSchema);

export default ParaClinic;
