import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IHomeIntroduction extends MongoDoc {
  isActive: boolean;
  order: number;
  title: string;
  image: string;
}

const HomeIntroductionSchema = new mongoose.Schema<
  IHomeIntroduction,
  Model<IHomeIntroduction>
>({
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  title: { type: String },
  image: { type: String },
});

const HomeIntroduction = mongoose.model(
  "HomeIntroduction",
  HomeIntroductionSchema,
);

export default HomeIntroduction;
