import mongoose, { Model } from "mongoose";
import { MongoDoc } from "../User";

export interface IOldPart extends MongoDoc {
  name: string;
  order: number;
}

const partSchema = new mongoose.Schema<IOldPart, Model<IOldPart>>({
  name: { type: String, trim: true, required: true, unique: true },
  order: { type: Number },
});

const OldPart = mongoose.connection.useDb("Noyan").model("Part", partSchema);

export default OldPart;
