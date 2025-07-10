import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IPendingUser extends MongoDoc {
  phone: string;
}

const pendingUserSchema = new mongoose.Schema<
  IPendingUser,
  Model<IPendingUser>
>({
  phone: { type: String, unique: true, immutable: true },
});

const PendingUser = mongoose.model("PendingUser", pendingUserSchema);

export default PendingUser;
