import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { ITreatmentPlanStage } from "./TreatmentPlanStage";

export interface ITreatmentPlan extends MongoDoc {
  user: IUser;
  //   doctor:IDoctor
  createdAt: Date;
  stages: ITreatmentPlanStage[];
  notifForPatientDelay: number;
  notifForDoctorDelay: number;
}

const TreatmentPlanSchema = new mongoose.Schema<
  ITreatmentPlan,
  Model<ITreatmentPlan>
>({});

const TreatmentPlan = mongoose.model("TreatmentPlan", TreatmentPlanSchema);

export default TreatmentPlan;
