import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IAdvertisement extends MongoDoc {
  name?: string;
  image?: string;
  isActive: boolean;
  order: number;
  isHome: boolean;
  isHomeSlider: boolean;
}

const AdvertisementSchema = new mongoose.Schema<
  IAdvertisement,
  Model<IAdvertisement>
>({
  name: { type: String },
  image: { type: String },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  isHome: { type: Boolean, default: false },
  isHomeSlider: { type: Boolean, default: false },
});

const Advertisement = mongoose.model("Advertisement", AdvertisementSchema);

export default Advertisement;
