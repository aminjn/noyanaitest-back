import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITaminComplaint extends MongoDoc {
  taminId: number;
  code: number;
  displayName: string;
  englishName: string;
  terminology: string;
  status: string;
}

const TaminComplaintSchema = new mongoose.Schema<
  ITaminComplaint,
  Model<ITaminComplaint>
>({
  taminId: { type: Number },
  code: { type: Number },
  displayName: { type: String },
  englishName: { type: String },
  terminology: { type: String },
  status: { type: String },
});

const TaminComplaint = mongoose.model("TaminComplaint", TaminComplaintSchema);

export default TaminComplaint;
