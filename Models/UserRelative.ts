import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IUserIdentity } from "./UserIdentity";

export interface IUserRelative extends MongoDoc {
  user: IUser;
  other: IUserIdentity;
}

const UserRelativeSchema = new mongoose.Schema<
  IUserRelative,
  Model<IUserRelative>
>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  other: {
    type: mongoose.Schema.ObjectId,
    ref: "UserIdentity",
    required: true,
  },
});

UserRelativeSchema.index({ user: 1, other: 1 }, { unique: true });

const UserRelative = mongoose.model("UserRelative", UserRelativeSchema);

export default UserRelative;
