import mongoose, { Model } from "mongoose";
import User, { IUser, MongoDoc } from "./User";
import { IAccessLevel } from "./AccessLevel";

export interface IUserAccessLevel extends MongoDoc {
  user: IUser;
  accessLevel?: IAccessLevel;
}

const UserAccessLevelSchema = new mongoose.Schema<
  IUserAccessLevel,
  Model<IUserAccessLevel>
>({
  user: {
    type: mongoose.Schema.ObjectId,
    ref: "User",
    required: true,
    unique: true,
  },
  accessLevel: {
    type: mongoose.Schema.ObjectId,
    ref: "AccessLevel",
    required: true,
  },
});

UserAccessLevelSchema.post("save", async function () {
  await User.findOneAndUpdate(
    { _id: this.user._id, role: { $ne: "admin" } },
    { role: "notadmin" }
  );
});

UserAccessLevelSchema.post(
  "findOneAndDelete",
  async function (doc: IUserAccessLevel) {
    if (doc) {
      await User.findOneAndUpdate(
        { _id: doc.user._id, role: { $ne: "admin" } },
        { role: "user" }
      );
    }
  }
);

const UserAccessLevel = mongoose.model(
  "UserAccessLevel",
  UserAccessLevelSchema
);

export default UserAccessLevel;
