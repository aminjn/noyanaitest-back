import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IUserIdentity } from "./UserIdentity";

const prescriptionStatuses = ["Draft", "Issued", "Filled"] as const;

type PrescriptionStatus = (typeof prescriptionStatuses)[number];

export interface IPrescription extends MongoDoc {
  doctor: IDoctorProfile;
  patient: IUserIdentity;
  createdAt: Date;
  status: PrescriptionStatus;
}

const PrescriptionSchema = new mongoose.Schema<
  IPrescription,
  Model<IPrescription>
>({});

const Prescription = mongoose.model("Prescription", PrescriptionSchema);

export default Prescription;
