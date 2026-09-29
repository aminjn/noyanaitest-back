import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export const accessOperations = [
  "readAll",
  "readOne",
  "write",
  "update",
  "delete",
] as const;

export type AccessOperation = (typeof accessOperations)[number];

type Access = { [key in AccessOperation]?: boolean };

export const accessLevelModels = [
  "BecomeDoctorRequest",
  "BecomeClinicRequest",
  "BecomePharmacyRequest",
  "BecomeInsuranceRequest",
  "Blog",
  "BlogCategory",
  "BlogMedia",
  "Comment",
  "Doctor",
  "DoctorProfile",
  "GalleryItem",
  "InlineAdvertisement",
  "Sepciality",
  "TextContent",
  "User",
  "Clinic",
  "ClinicDepartment",
  "ClinicDoctor",
  "DoctorJoinClinic",
  "ClinicAdditionRequest",
  "DoctorSeretaryAccessLevel",
  "Insurance",
  "InsuranceAdditionRequest",
  "Pharmacy",
  "CallRoom",
  "Redirection",
  "ShortLink",
  "Disease",
  "Drug",
  "Symptom",
  "Part",
  "DoctorFaq",
  "Hospital",
  "HospitalDepartment",
  "HospitalDoctor",
  "DoctorJoinHospital",
  "HospitalAdditionRequest",
  "BecomeHospitalRequest",
] as const;

export type AccessLevelModel = (typeof accessLevelModels)[number];

export type IAccessLevel = MongoDoc & {
  name: string;
} & { [key in AccessLevelModel]?: Access };

const AccessSchema = new mongoose.Schema<Access, Model<Access>>(
  accessOperations.reduce(
    (acc, op) => ({ ...acc, [op]: { type: Boolean, default: false } }),
    {},
  ),
  { _id: false },
);
const AccessLevelSchema = new mongoose.Schema<
  IAccessLevel,
  Model<IAccessLevel>
>(
  {
    name: { type: String, required: true, trim: true },
    ...accessLevelModels.reduce(
      (acc, model) => ({
        ...acc,
        [model]: {
          type: AccessSchema,
          default: () => ({}),
        },
      }),
      {},
    ),
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

AccessLevelSchema.virtual("admins", {
  ref: "UserAccessLevel",
  localField: "_id",
  foreignField: "accessLevel",
});

// Deleting an access level removes its assignments one by one, so the
// UserAccessLevel delete hook demotes those users back to "user" instead of
// leaving them as "notadmin" with a dangling access level.
AccessLevelSchema.post("findOneAndDelete", async function (doc: any) {
  if (!doc) return;
  const UserAccessLevel = mongoose.model("UserAccessLevel");
  const assignments = await UserAccessLevel.find({ accessLevel: doc._id })
    .select("_id")
    .lean();
  for (const a of assignments)
    await UserAccessLevel.findByIdAndDelete((a as any)._id);
});

const AccessLevel = mongoose.model("AccessLevel", AccessLevelSchema);

export default AccessLevel;
