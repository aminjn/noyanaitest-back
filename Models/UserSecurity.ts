import mongoose, { Model } from "mongoose";
import { IUser } from "./User";

export interface IUserSecurity {
  lastLogin: Date;
  user: IUser;
}

const userSecuritySchema = new mongoose.Schema<
  IUserSecurity,
  Model<IUserSecurity>
>({
  user: {
    type: mongoose.Schema.ObjectId,
    ref: "User",
    required: true,
    unique: true,
    immutable: true,
  },
  lastLogin: { type: Date, default: () => new Date() },
});

const UserSecurity = mongoose.model("UserSecurity", userSecuritySchema);

export default UserSecurity;
