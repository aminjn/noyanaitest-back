import mongoose, { Model } from "mongoose";
import { UserRole, userRoles } from "../Lib/enums";
import { IUserIdentity } from "./UserIdentity";

export interface MongoDoc {
  _id: mongoose.Types.ObjectId;
}

export interface IUser extends MongoDoc {
  phone: string;
  role: UserRole;
  nationalId?: string;
  username?: string;
  avatar?: string;
  identity?: IUserIdentity;
}

const userSchema = new mongoose.Schema<IUser, Model<IUser>>(
  {
    phone: { type: String, required: true, unique: true, immutable: true },
    role: { type: String, default: "user", enum: userRoles },
    nationalId: { type: String, select: false },
    username: { type: String, trim: true },
    avatar: { type: String },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

userSchema.virtual("identity", {
  ref: "UserIdentity",
  localField: "_id",
  foreignField: "user",
  justOne: true,
});

userSchema.virtual("vital", {
  ref: "UserVital",
  localField: "_id",
  foreignField: "user",
  justOne: true,
  options: { sort: { createdAt: -1 } },
});

userSchema.virtual("medical", {
  ref: "MedicalDetail",
  localField: "_id",
  foreignField: "user",
  justOne: true,
});

const User = mongoose.model("User", userSchema);

export default User;
