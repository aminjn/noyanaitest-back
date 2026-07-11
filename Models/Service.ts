import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IServiceCategory } from "./ServiceCategory";

export interface IService extends MongoDoc {
  order: number;
  isActive: boolean;
  name?: string;
  owner?: IDoctorProfile;
  image?: string;
  price: number;
  discount: number;
  inventory: number;
  isHome: boolean;
  category?: IServiceCategory;
  special: boolean;
}

const ServiceSchema = new mongoose.Schema<IService, Model<IService>>({
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  name: { type: String },
  owner: { type: mongoose.Schema.ObjectId, ref: "DoctorProfile" },
  image: { type: String },
  price: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  inventory: { type: Number, default: 0 },
  isHome: { type: Boolean, default: false },
  category: { type: mongoose.Schema.ObjectId, ref: "ServiceCategory" },
  special: { type: Boolean, default: false },
});

const Service = mongoose.model("Service", ServiceSchema);

export default Service;
