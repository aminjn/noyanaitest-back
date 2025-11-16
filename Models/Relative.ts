import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IUserIdentity } from "./UserIdentity";

export interface IRelative extends MongoDoc {
  user: IUser;
  other: IUserIdentity;
}

const RelativeSchema = new mongoose.Schema<IRelative, Model<IRelative>>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  other: {
    type: mongoose.Schema.ObjectId,
    ref: "UserIdentity",
    required: true,
  },
});

RelativeSchema.index({ user: 1, other: 1 }, { unique: true });

const Relative = mongoose.model("Relative", RelativeSchema);

export default Relative;
