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

// Edits through POST /auto/useraccesslevel/:id go through findByIdAndUpdate,
// which skips the "save" hook above. If the assignment moves to another
// user, demote the previous one and promote the new one.
UserAccessLevelSchema.pre("findOneAndUpdate", async function () {
  const prev = await this.model.findOne(this.getQuery()).select("user").lean();
  (this as any)._prevUser = (prev as any)?.user;
});

UserAccessLevelSchema.post("findOneAndUpdate", async function () {
  const prevUser = (this as any)._prevUser;
  const current: any = await this.model
    .findOne(this.getQuery())
    .select("user")
    .lean();
  if (!current || String(current.user) === String(prevUser)) return;
  if (prevUser)
    await User.findOneAndUpdate(
      { _id: prevUser, role: { $ne: "admin" } },
      { role: "user" }
    );
  await User.findOneAndUpdate(
    { _id: current.user, role: { $ne: "admin" } },
    { role: "notadmin" }
  );
});

const UserAccessLevel = mongoose.model(
  "UserAccessLevel",
  UserAccessLevelSchema
);

export default UserAccessLevel;
