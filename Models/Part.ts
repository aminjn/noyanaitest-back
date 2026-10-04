import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface IPart extends MongoDoc {
  name?: string;
  order: number;
  old?: mongoose.Types.ObjectId;
}

const PartSchema = new mongoose.Schema<IPart, Model<IPart>>({
  name: { type: String, trim: true, required: true },
  order: { type: Number, default: 0 },
  old: { type: mongoose.Schema.ObjectId },
});

PartSchema.plugin(translatable);

const Part = mongoose.model("Part", PartSchema);

export default Part;
