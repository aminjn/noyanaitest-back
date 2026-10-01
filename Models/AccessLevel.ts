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
  "DoctorProfile",
  "InlineAdvertisement",
  "Sepciality",
  "TextContent",
  "User",
  "Clinic",
  "ClinicDepartment",
  "ClinicDoctor",
  "DoctorJoinClinic",
  "ClinicAdditionRequest",
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
  "ParaClinic",
  "BecomeParaClinicRequest",
  "PharmacyAdditionRequest",
  "Faq",
  // support and operations (2026-10 audit): these pages were reachable only
  // by full admins, so support work could not be delegated to staff
  "Ticket",
  "ContactRequest",
  "DoctorFeedback",
  "Service",
  "Product",
  "Test",
  "BookingDescription",
  "Notification",
  "Advertisement",
  "PageMeta",
  "Reservation",
  "Order",
  "Finance",
] as const;

// Grants of models that no longer exist (the legacy doctor directory, the
// admin gallery segment, the never-used secretary default). Stored roles
// still carry them; they are unset once at boot so the matrix and the
// "my access" payload only show live sections.
export const retiredAccessLevelModels = [
  "Doctor",
  "GalleryItem",
  "DoctorSeretaryAccessLevel",
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

// Idempotent: only roles that still carry a retired key are touched. Runs
// through the raw collection because the schema no longer knows these paths
// (a Mongoose $unset of an unknown path would be stripped by strict mode).
const unsetRetiredAccessModels = async () => {
  try {
    const unset = Object.fromEntries(retiredAccessLevelModels.map((m) => [m, ""]));
    await AccessLevel.collection.updateMany(
      { $or: retiredAccessLevelModels.map((m) => ({ [m]: { $exists: true } })) },
      { $unset: unset },
    );
  } catch (err) {
    console.log("[AccessLevel] unsetting retired models failed:", err);
  }
};
if (mongoose.connection.readyState === 1) void unsetRetiredAccessModels();
else mongoose.connection.once("open", () => void unsetRetiredAccessModels());

export default AccessLevel;
