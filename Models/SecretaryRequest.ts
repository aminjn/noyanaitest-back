import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import {
  SecretaryAclPath,
  secretaryAclPaths,
  SecretaryNodePath,
  secretaryNodePaths,
} from "./Secretary";

export const secretaryRequestStatuses = [
  "Pending",
  "Approved",
  "Rejected",
] as const;

export type SecretaryRequestStatus = (typeof secretaryRequestStatuses)[number];

export interface ISecretaryRequest extends MongoDoc {
  submittedAt: Date;
  owner: mongoose.Types.ObjectId;
  acl?: mongoose.Types.ObjectId;
  ownerPath: SecretaryNodePath;
  aclPath: SecretaryAclPath;
  phone: string;
  status: SecretaryRequestStatus;
  displayName?: string;
  message?: string;
}

const SecretaryRequestSchema = new mongoose.Schema<
  ISecretaryRequest,
  Model<ISecretaryRequest>
>({
  submittedAt: { type: Date, default: () => new Date() },
  owner: {
    type: mongoose.Schema.ObjectId,
    refPath: "ownerPath",
    required: true,
  },
  acl: {
    type: mongoose.Schema.ObjectId,
    refPath: "aclPath",
  },
  ownerPath: { type: String, enum: secretaryNodePaths, required: true },
  aclPath: { type: String, enum: secretaryAclPaths, required: true },
  phone: { type: String, required: true },
  status: {
    type: String,
    default: "Pending",
    enum: secretaryRequestStatuses,
  },
  displayName: { type: String, trim: true },
  message: { type: String, trim: true },
});

const SecretaryRequest = mongoose.model(
  "SecretaryRequest",
  SecretaryRequestSchema
);

export default SecretaryRequest;
