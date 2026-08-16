import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { NodeWithAcl } from "../Controllers/aclController";

export const secretaryNodePaths = [
  "DoctorProfile",
  "Clinic",
  "Insurance",
  "Pharmacy",
  "ParaClinic",
] as const;

export type SecretaryNodePath = (typeof secretaryNodePaths)[number];

export const secretaryAclPaths = [
  "DoctorAcl",
  "InsuranceAcl",
  "ClinicAcl",
  "PharmacyAcl",
  "ParaClinicAcl",
] as const;

export const nodesWithAclToSecreataryAclPathDict: Record<
  NodeWithAcl,
  SecretaryNodePath
> = {
  clinic: "Clinic",
  doctor: "DoctorProfile",
  insurance: "Insurance",
  paraClinic: "ParaClinic",
  pharmacy: "Pharmacy",
};

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
