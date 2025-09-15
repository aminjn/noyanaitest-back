import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import Insurance, { IInsurance } from "./Insurance";

export interface IDoctorInsurance extends MongoDoc {
  doctor: IDoctorProfile;
  insurance: IInsurance;
}

const DoctorInsuranceSchema = new mongoose.Schema<
  IDoctorInsurance,
  Model<IDoctorInsurance>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  insurance: {
    type: mongoose.Schema.ObjectId,
    ref: "Insurance",
    required: true,
  },
});

DoctorInsuranceSchema.index({ doctor: 1, insurance: 1 }, { unique: true });

const DoctorInsurance = mongoose.model(
  "DoctorInsurance",
  DoctorInsuranceSchema
);

export default DoctorInsurance;
