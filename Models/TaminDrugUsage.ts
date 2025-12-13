import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITaminDrugUsage extends MongoDoc {
  drugUsageId?: string;
  drugUsageCode?: string;
  drugUsageSumry?: string;
  drugUsageLatin?: string;
  drugUsageConcept?: string;
  visible?: string;
  drugFormCode?: string;
}

const TaminDrugUsageSchema = new mongoose.Schema<
  ITaminDrugUsage,
  Model<ITaminDrugUsage>
>({
  drugUsageId: { type: String },
  drugUsageCode: { type: String },
  drugUsageSumry: { type: String },
  drugUsageLatin: { type: String },
  drugUsageConcept: { type: String },
  visible: { type: String },
  drugFormCode: { type: String },
});

const TaminDrugUsage = mongoose.model("TaminDrugUsage", TaminDrugUsageSchema);

export default TaminDrugUsage;
