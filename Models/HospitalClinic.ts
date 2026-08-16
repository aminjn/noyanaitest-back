import mongoose, { Model } from "mongoose";
import { IHospital } from "./Hospital";
import { IClinic } from "./Clinic";
import { MongoDoc } from "./User";

export interface IHospitalClinic extends MongoDoc {
  hospital: IHospital;
  clinic: IClinic;
}

const HospitalClinicSchema = new mongoose.Schema<
  IHospitalClinic,
  Model<IHospitalClinic>
>({
  hospital: { type: mongoose.Schema.ObjectId, ref: "Hospital", required: true },
  clinic: {
    type: mongoose.Schema.ObjectId,
    ref: "Clinic",
    required: true,
    unique: true,
  },
});

const HospitalClinic = mongoose.model("HospitalClinic", HospitalClinicSchema);

export default HospitalClinic;
