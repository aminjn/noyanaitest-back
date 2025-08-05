import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IClinic } from "./Clinic";
import { IClinicDepartment } from "./ClinicDepatment";
import { IDoctorProfile } from "./DoctorProfile";

export interface IClinicDoctor extends MongoDoc {
  clinic: IClinic;
  department?: IClinicDepartment;
  doctor: IDoctorProfile;
}

const ClinicDoctorSchema = new mongoose.Schema<
  IClinicDoctor,
  Model<IClinicDoctor>
>({
  clinic: { type: mongoose.Schema.ObjectId, required: true, ref: "Clinic" },
  department: { type: mongoose.Schema.ObjectId, ref: "ClinicDepartment" },
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
});

ClinicDoctorSchema.index({ department: 1, doctor: 1 }, { unique: true });

const ClinicDoctor = mongoose.model("ClinicDoctor", ClinicDoctorSchema);

export default ClinicDoctor;
