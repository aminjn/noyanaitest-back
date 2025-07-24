import mongoose, { Model } from "mongoose";
import { ITreatmentPlan } from "./TreatmentPlan";

export interface ITreatmentPlanStage {
  plan: ITreatmentPlan;
  index: number;
  description: string;
  eta: Date;
  doneDate?: Date;
  dueNotifPatient: boolean;
  dueNotifDoctor: boolean;
}

const TreatmentPlanStageSchema = new mongoose.Schema<
  ITreatmentPlanStage,
  Model<ITreatmentPlanStage>
>({});

const TreatmentPlanStage = mongoose.model(
  "TreatmentPlanStage",
  TreatmentPlanStageSchema
);

export default TreatmentPlanStage;


