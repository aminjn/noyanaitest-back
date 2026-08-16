import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IAboutPartner extends MongoDoc {
  name?: string;
  image?: string;
  order: number;
  isActive: boolean;
}

const AboutPartnerSchema = new mongoose.Schema<
  IAboutPartner,
  Model<IAboutPartner>
>({
  name: { type: String },
  image: { type: String },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
});

const AboutPartner = mongoose.model("AboutPartner", AboutPartnerSchema);

export default AboutPartner;
