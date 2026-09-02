import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

export interface IUserAddress extends MongoDoc {
  user: IUser;
  displayName: string;
  address: string;
  location?: { type: "Point"; coordinates?: [number, number] };
}

const UserAddressSchema = new mongoose.Schema<
  IUserAddress,
  Model<IUserAddress>
>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  displayName: { type: String, required: true },
  address: { type: String, required: true },
  location: {
    type: { type: String, enum: ["Point"] },
    coordinates: { type: [Number] },
  },
});

UserAddressSchema.index({ location: "2dsphere" });

const UserAddress = mongoose.model("UserAddress", UserAddressSchema);

export default UserAddress;
