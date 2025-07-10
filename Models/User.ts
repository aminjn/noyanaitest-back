import mongoose, { Model } from "mongoose";
import { UserRole, userRoles } from "../Lib/enums";

export interface MongoDoc {
  _id: mongoose.Types.ObjectId;
}

export interface IUser extends MongoDoc {
  phone: string;
  role: UserRole;
}

const userSchema = new mongoose.Schema<IUser, Model<IUser>>({
  phone: { type: String, required: true, unique: true, immutable: true },
  role: { type: String, default: "user", enum: userRoles },
});

const User = mongoose.model("User", userSchema);

export default User;
