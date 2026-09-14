import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// Add the name of each static image slot here (e.g. "logo", "favicon", "authBackground").
// The schema below is built automatically by looping over this array, so adding a name
// here is the only step needed to add a new static image field to the model.
const staticImageFields: string[] = [];

export interface IStaticImages extends MongoDoc {
  singleton: "SINGLETON";
  [fieldName: string]: unknown;
}

const schemaDefinition: mongoose.SchemaDefinition = {
  singleton: {
    type: String,
    required: true,
    default: "SINGLETON",
    enum: ["SINGLETON"],
    immutable: true,
    unique: true,
  },
};

for (const fieldName of staticImageFields) {
  schemaDefinition[fieldName] = { type: String };
}

const StaticImagesSchema = new mongoose.Schema<
  IStaticImages,
  Model<IStaticImages>
>(schemaDefinition);

const StaticImages = mongoose.model("StaticImages", StaticImagesSchema);

export default StaticImages;
