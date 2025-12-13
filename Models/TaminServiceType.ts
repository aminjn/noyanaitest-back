import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITaminServiceType extends MongoDoc {
  srvType?: number;
  srvTypeDes?: string;
  status?: number;
  statusstDate?: string;
  custType?: number;
  prescTypeId?: number;
  headExpireDate?: number;
}

const TaminServiceTypeSchema = new mongoose.Schema<
  ITaminServiceType,
  Model<ITaminServiceType>
>({
  srvType: { type: Number },
  srvTypeDes: { type: String },
  status: { type: Number },
  statusstDate: { type: String },
  custType: { type: Number },
  prescTypeId: { type: Number },
  headExpireDate: { type: Number },
});

const TaminServiceType = mongoose.model(
  "TaminServiceType",
  TaminServiceTypeSchema
);

export default TaminServiceType;
