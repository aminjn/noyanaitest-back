import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import Hospital, { IHospital } from "./Hospital";
import { IHospitalDepartment } from "./HospitalDepartment";
import { IDoctorProfile } from "./DoctorProfile";

export interface IHospitalDoctor extends MongoDoc {
  hospital: IHospital;
  department?: IHospitalDepartment;
  doctor: IDoctorProfile;
}

const HospitalDoctorSchema = new mongoose.Schema<
  IHospitalDoctor,
  Model<IHospitalDoctor>
>({
  hospital: { type: mongoose.Schema.ObjectId, required: true, ref: "Hospital" },
  department: { type: mongoose.Schema.ObjectId, ref: "HospitalDepartment" },
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
});

HospitalDoctorSchema.index({ hospital: 1, doctor: 1 }, { unique: true });

const HospitalDoctor = mongoose.model("HospitalDoctor", HospitalDoctorSchema);

export default HospitalDoctor;
