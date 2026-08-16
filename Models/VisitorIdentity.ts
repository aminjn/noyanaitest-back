import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

// Represents an identity for a visiting client (browser/device).
// Every visitor - logged in or anonymous - gets one of these the first
// time they are seen. It is looked up by an opaque `visitorId` stored in
// a long lived cookie. If/when we can resolve a logged in user for the
// request, `user` is attached so anonymous browsing history can be tied
// back to an account.
export interface IVisitorIdentity extends MongoDoc {
  visitorId: string;
  user?: IUser;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

const VisitorIdentitySchema = new mongoose.Schema<
  IVisitorIdentity,
  Model<IVisitorIdentity>
>({
  visitorId: { type: String, required: true, unique: true, immutable: true },
  user: { type: mongoose.Schema.ObjectId, ref: "User" },
  firstSeenAt: { type: Date, default: () => new Date() },
  lastSeenAt: { type: Date, default: () => new Date() },
});

const VisitorIdentity = mongoose.model("VisitorIdentity", VisitorIdentitySchema);

export default VisitorIdentity;
