import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export const redirectionStatusCodes = [301, 307, 308] as const;

export type RedirectionStatusCode = (typeof redirectionStatusCodes)[number];

export interface IRedirection extends MongoDoc {
  old: string;
  current: string;
  statusCode: RedirectionStatusCode;
}

const RedirectionSchema = new mongoose.Schema<
  IRedirection,
  Model<IRedirection>
>({
  old: { type: String, required: true, unique: true },
  current: { type: String, required: true },
  statusCode: { type: Number, enum: redirectionStatusCodes, default: 301 },
});

const Redirection = mongoose.model("Redirection", RedirectionSchema);

export default Redirection;
