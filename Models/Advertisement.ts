import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// Every slot in the front-end that is allowed to show an ad goes here.
// A page can have more than one slot (e.g. a top banner and a sidebar banner
// on the same list page), and a single Advertisement can target several
// positions at once. Configure/extend this list as new ad slots are added
// to the front-end; nothing else in this file needs to change when you do.
export const advertisementPositions = [
  "home1",
  "home2",
  "home3",
  "home4",
  "home5",
  "home6",
  "diseases1",
  "diseases2",
  "symptoms1",
  "symptoms2",
  "drugs1",
  "drugs2",
  "specialities1",
  "speciality1",
  "speciality2",
  "disease1",
  "disease2",
  "symptom1",
  "symptom2",
  "drug1",
  "drug2",
  "clinics1",
  "clinics2",
  "hospitals1",
  "hospitals2",
  "tests1",
  "tests2",
  "hospital1",
  "paraClinics1",
] as const;

export type AdvertisementPosition = (typeof advertisementPositions)[number];

export const isAdvertisementPosition = (
  value: string,
): value is AdvertisementPosition =>
  (advertisementPositions as readonly string[]).includes(value);

// Mongoose model names an Advertisement is allowed to target via `resource`,
// used for single-node positions (e.g. "disease_top") where an ad should
// target one specific document instead of every document of that type.
// Extend this list alongside `advertisementPositions` as new node-page
// positions are introduced.
export const advertisementResourceModels = [
  "Disease",
  "Doctor",
  "DoctorProfile",
  "Drug",
  "Speciality",
  "Clinic",
  "Hospital",
  "ParaClinic",
  "Product",
  "ProductPackage",
  "Symptom",
  "Service",
  "ServicePackage",
  "Insurance",
  "Blog",
] as const;

export type AdvertisementResourceModel =
  (typeof advertisementResourceModels)[number];

export interface IAdvertisement extends MongoDoc {
  name?: string;
  image?: string;
  isActive: boolean;
  order: number;
  title?: string;
  description?: string;
  legend?: string;
  // href for the ad's "more info" action/button
  target?: string;
  positions: AdvertisementPosition[];
  // Together, these optionally target one specific document (e.g. one
  // specific disease) instead of applying generically to every document
  // shown under `positions`. Leave both unset for a generic/fallback ad.
  resourceModel?: AdvertisementResourceModel;
  resource?: mongoose.Types.ObjectId;
}

const AdvertisementSchema = new mongoose.Schema<
  IAdvertisement,
  Model<IAdvertisement>
>({
  name: { type: String },
  image: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  title: { type: String },
  description: { type: String },
  legend: { type: String },
  target: { type: String },
  positions: {
    type: [{ type: String, enum: advertisementPositions }],
    default: [],
  },
  resourceModel: {
    type: String,
    enum: advertisementResourceModels,
    validate: {
      validator(this: IAdvertisement, value: string | undefined) {
        return !!value === !!this.resource;
      },
      message: "resourceModel and resource must be set together",
    },
  },
  resource: {
    type: mongoose.Schema.ObjectId,
    refPath: "resourceModel",
    validate: {
      validator(
        this: IAdvertisement,
        value: mongoose.Types.ObjectId | undefined,
      ) {
        return !!value === !!this.resourceModel;
      },
      message: "resourceModel and resource must be set together",
    },
  },
});

AdvertisementSchema.index({ positions: 1, resource: 1 });

// Looks up ads for a given position, preferring ones targeted at a specific
// resource (e.g. one disease) and falling back to the generic ad(s) for that
// position (resource left unset) if no targeted match exists.
export const findAdvertisementsForPosition = async ({
  position,
  resource,
  limit,
}: {
  position: AdvertisementPosition | AdvertisementPosition[];
  resource?: string | mongoose.Types.ObjectId;
  limit?: number;
}): Promise<IAdvertisement[]> => {
  const base = { positions: position, isActive: true };

  if (resource) {
    const targeted = await Advertisement.find({ ...base, resource })
      .sort({ order: 1 })
      .limit(limit || 0);
    if (targeted.length) return targeted;
  }

  return Advertisement.find({ ...base, resource: null })
    .sort({ order: 1 })
    .limit(limit || 0);
};

const Advertisement = mongoose.model("Advertisement", AdvertisementSchema);

export default Advertisement;
