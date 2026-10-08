import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

export interface IMcCode extends MongoDoc {
  user: IUser;
  mcCode: string;
  createdAt: Date;
  title?: string;
  city?: string;
  acquiredAt?: string;
  // the council's inquiry confirmed this code for the user's national id
  verifiedAt?: Date;
}

const McCodeSchema = new mongoose.Schema<IMcCode, Model<IMcCode>>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  mcCode: { type: String, required: true },
  createdAt: { type: Date, default: () => new Date() },
  title: { type: String },
  city: { type: String },
  acquiredAt: { type: String },
  verifiedAt: { type: Date },
});

const McCode = mongoose.model("McCode", McCodeSchema);

export default McCode;
