import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export const doctorSecretaryActions = [
  "readClinics",
  "leaveClinics",
  "joinClinic",
  "mutateJoinClinic",
  "clinicAddition",
  "readCalendar",
  "mutateCalendar",
  "readSettings",
  "mutateSettings",
] as const;

export type DoctorSecretaryAction = (typeof doctorSecretaryActions)[number];

export type IDoctorSecretaryAccessLevel = MongoDoc & {
  name: string;
  owner?: IDoctorProfile;
} & Partial<Record<DoctorSecretaryAction, boolean>>;

const DoctorSecretaryAccessLevelSchema = new mongoose.Schema<
  IDoctorSecretaryAccessLevel,
  Model<IDoctorSecretaryAccessLevel>
>({
  name: { type: String, trim: true, default: "" },
  owner: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
  },
  ...doctorSecretaryActions.reduce(
    (acc, action) => ({ ...acc, [action]: { type: Boolean, default: false } }),
    {}
  ),
});

const DoctorSecretaryAccessLevel = mongoose.model(
  "DoctorSecretaryAccessLevel",
  DoctorSecretaryAccessLevelSchema
);

export default DoctorSecretaryAccessLevel;
