import mongoose, { Model } from "mongoose";
import { MongoDoc } from "../User";
import { IModelOptions } from "./ModelSettings";

export interface IOllamaModel extends MongoDoc {
  name: string;
  modelName: string;
  modifiedAt: Date;
  size: number;
  digest: string;
  family: string;
  parameterSize: string;
  quantizationLevel: string;
  loaded: boolean;
  settings?: IModelOptions;
}

const OllamaModelSchema = new mongoose.Schema<
  IOllamaModel,
  Model<IOllamaModel>
>(
  {
    name: { type: String, unique: true, required: true },
    modelName: { type: String },
    modifiedAt: { type: Date },
    size: { type: Number },
    digest: { type: String },
    family: { type: String },
    parameterSize: { type: String },
    quantizationLevel: { type: String },
    loaded: { type: Boolean, default: false },
  },
  { toObject: { virtuals: true }, toJSON: { virtuals: true } },
);

OllamaModelSchema.virtual("settings", {
  ref: "ModelOptions",
  localField: "_id",
  foreignField: "ollamaModel",
  justOne: true,
});

const OllamaModel = mongoose.model("OllamaModel", OllamaModelSchema);

export default OllamaModel;
