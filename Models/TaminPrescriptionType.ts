import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITaminPrescriptionType extends MongoDoc {
  prescTypeId?: number;
  prescTypeCode?: string;
  prescTypeDesc?: string;
}

const TaminPrescriptionTypeSchema = new mongoose.Schema<
  ITaminPrescriptionType,
  Model<ITaminPrescriptionType>
>({
  prescTypeId: { type: Number },
  prescTypeCode: { type: String },
  prescTypeDesc: { type: String },
});

const TaminPrescriptionType = mongoose.model(
  "TaminPrescriptionType",
  TaminPrescriptionTypeSchema
);

export default TaminPrescriptionType;
