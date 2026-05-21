import mongoose, { Model } from "mongoose";
import { MongoDoc } from "../User";
import { IOllamaModel } from "./OllamaModel";

export interface IGlobalOllamaSettings extends MongoDoc {
  singleton: "SINGLETON";
  defaultModel: IOllamaModel;
}

const GlobalOllamaSettingsSchema = new mongoose.Schema<
  IGlobalOllamaSettings,
  Model<IGlobalOllamaSettings>
>({
  singleton: {
    type: String,
    required: true,
    default: "SINGLETON",
    enum: ["SINGLETON"],
    immutable: true,
    unique: true,
  },
  defaultModel: { type: mongoose.Schema.ObjectId, ref: "OllamaModel" },
});

const GlobalOllamaSettings = mongoose.model(
  "GlobalOllamaSettings",
  GlobalOllamaSettingsSchema,
);

export default GlobalOllamaSettings;
