import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITaminPhIllness extends MongoDoc {
  illnessId?: string;
  illnessDesc?: string;
}

const TaminPhIllnessSchema = new mongoose.Schema<
  ITaminPhIllness,
  Model<ITaminPhIllness>
>({
  illnessId: { type: String },
  illnessDesc: { type: String },
});

const TaminPhIllness = mongoose.model("TaminPhIllness", TaminPhIllnessSchema);

export default TaminPhIllness;
