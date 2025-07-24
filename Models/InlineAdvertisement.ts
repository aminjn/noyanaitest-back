import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IInlineAdvertisement extends MongoDoc {
  name?: string;
  expiration?: Date;
  target?: string;
  image?: string;
  title?: string;
  subTitle?: string;
  active: boolean;
  createdAt: Date;
}

const InlineAdvertisementSchema = new mongoose.Schema<
  IInlineAdvertisement,
  Model<IInlineAdvertisement>
>({
  name: { type: String },
  expiration: { type: Date },
  target: { type: String },
  image: { type: String },
  title: { type: String },
  subTitle: { type: String },
  active: { type: Boolean, default: false },
  createdAt: { type: Date, default: () => new Date() },
});

const InlineAdvertisement = mongoose.model(
  "InlineAdvertisement",
  InlineAdvertisementSchema
);

export default InlineAdvertisement;
