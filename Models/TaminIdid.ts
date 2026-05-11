import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITaminIcid extends MongoDoc {
  icdId: string;
  icdCode: string;
  icdName: string;
  icdPersianName: string | null;
  countLimitation: string | null;
}

const TaminIcidSchema = new mongoose.Schema<ITaminIcid, Model<ITaminIcid>>({
  icdId: { type: String },
  icdCode: { type: String },
  icdName: { type: String },
  icdPersianName: { type: String },
  countLimitation: { type: String },
});

const TaminIcid = mongoose.model("TaminIcid", TaminIcidSchema);

export default TaminIcid;
