import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IPart extends MongoDoc {
  name?: string;
  order: number;
  old?: mongoose.Types.ObjectId;
}

const PartSchema = new mongoose.Schema<IPart, Model<IPart>>({
  name: { type: String },
  order: { type: Number, default: 0 },
  old: { type: mongoose.Schema.ObjectId },
});

const Part = mongoose.model("Part", PartSchema);

export default Part;
