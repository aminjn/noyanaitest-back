import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

export const secretaryNodePaths = [
  "DoctorProfile",
  "Clinic",
  "Insurance",
  "Pharmacy",
] as const;

export type SecretaryNodePath = (typeof secretaryNodePaths)[number];

export const secretaryAclPaths = [
  "DoctorAcl",
  "InsuranceAcl",
  "ClinicAcl",
  "PharmacyAcl",
] as const;

export type SecretaryAclPath = (typeof secretaryAclPaths)[number];

export interface ISecretary extends MongoDoc {
  owner: mongoose.Types.ObjectId;
  secretary: IUser;
  ownerPath: SecretaryNodePath;
  acl?: mongoose.Types.ObjectId;
  aclPath: SecretaryAclPath;
  displayName?: string;
}

const SecretarySchema = new mongoose.Schema<ISecretary, Model<ISecretary>>({
  owner: {
    type: mongoose.Schema.ObjectId,
    refPath: "ownerPath",
    required: true,
  },
  secretary: {
    type: mongoose.Schema.ObjectId,
    ref: "User",
    required: true,
  },
  ownerPath: { type: String, enum: secretaryNodePaths, required: true },
  acl: { type: mongoose.Schema.ObjectId, refPath: "aclPath" },
  aclPath: { type: String, enum: secretaryAclPaths, required: true },
  displayName: { type: String },
});

SecretarySchema.index({ owner: 1, secretary: 1 }, { unique: true });

const Secretary = mongoose.model("Secretary", SecretarySchema);

export default Secretary;
