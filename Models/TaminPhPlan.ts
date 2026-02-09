import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITaminPhPlan extends MongoDoc {
  planId?: string;
  planDesc?: string;
  planCode?: string;
}

const TaminPhPlanSchema = new mongoose.Schema<
  ITaminPhPlan,
  Model<ITaminPhPlan>
>({
  planId: { type: String },
  planDesc: { type: String },
  planCode: { type: String },
});

const TaminPhPlan = mongoose.model("TaminPhPlan", TaminPhPlanSchema);

export default TaminPhPlan;
