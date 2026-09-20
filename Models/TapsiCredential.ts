import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITapsiCredential extends MongoDoc {
  singleton: "SINGLETON";
  token?: string;
  updatedAt?: Date;
}

const TapsiCredentialSchema = new mongoose.Schema<
  ITapsiCredential,
  Model<ITapsiCredential>
>({
  singleton: {
    type: String,
    required: true,
    default: "SINGLETON",
    enum: ["SINGLETON"],
    immutable: true,
    unique: true,
  },
  token: { type: String, select: false },
  updatedAt: { type: Date },
});

const TapsiCredential = mongoose.model(
  "TapsiCredential",
  TapsiCredentialSchema,
);

export default TapsiCredential;
