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
  // the site language this account last used (x-locale on an authenticated
  // request) - SMS picks the pattern for it (Lib/sendSms.ts)
  locale?: string;
  // account state set by the super admin (Controllers/adminUserController.ts):
  // a suspended account can't log in and its sessions are cut; a deleted one
  // is anonymised - its visits, orders and payments stay for the records
  status: UserStatus;
  statusReason?: string;
  statusChangedAt?: Date;
  suspendedUntil?: Date;
}

export const userStatuses = ["active", "suspended", "deleted"] as const;
export type UserStatus = (typeof userStatuses)[number];

const userSchema = new mongoose.Schema<IUser, Model<IUser>>(
  {
    phone: { type: String, required: true, unique: true, immutable: true },
    role: { type: String, default: "user", enum: userRoles },
    nationalId: { type: String, select: false },
    username: { type: String, trim: true },
    avatar: { type: String },
    locale: { type: String },
    status: { type: String, enum: userStatuses, default: "active", index: true },
    statusReason: { type: String, trim: true },
    statusChangedAt: { type: Date },
    suspendedUntil: { type: Date },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
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
