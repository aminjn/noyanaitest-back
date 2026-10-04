import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import Clinic, { IClinic } from "./Clinic";
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

ClinicDoctorSchema.index({ clinic: 1, doctor: 1 }, { unique: true });

// A doctor added to the centre directly (the admin's team tab) settles the
// doctor's open request to join it: it used to stay pending, so the centre
// could still "reject" someone already on its team.
ClinicDoctorSchema.post("save", async function (doc) {
  if (!mongoose.modelNames().includes("DoctorJoinClinicRequest")) return;
  await mongoose
    .model("DoctorJoinClinicRequest")
    .updateMany(
      { doctor: doc.doctor, clinic: doc.clinic, status: "Pending" },
      { $set: { status: "Approved", decidedAt: new Date(), statusLastChangedAt: new Date() } },
    )
    .catch(() => undefined);
});

const ClinicDoctor = mongoose.model("ClinicDoctor", ClinicDoctorSchema);

export default ClinicDoctor;
