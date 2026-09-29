import { normalizePath } from "../Lib/normalizePath";
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

// stored in the same form the lookup uses (decoded, no trailing slash)
RedirectionSchema.pre("validate", function () {
  if (this.old) this.old = normalizePath(this.old);
  if (this.current) this.current = normalizePath(this.current);
});

const Redirection = mongoose.model("Redirection", RedirectionSchema);

export default Redirection;
