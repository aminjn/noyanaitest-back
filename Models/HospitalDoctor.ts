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

// A doctor added to the centre directly (the admin's team tab) settles the
// doctor's open request to join it: it used to stay pending, so the centre
// could still "reject" someone already on its team.
HospitalDoctorSchema.post("save", async function (doc) {
  if (!mongoose.modelNames().includes("DoctorJoinHospitalRequest")) return;
  await mongoose
    .model("DoctorJoinHospitalRequest")
    .updateMany(
      { doctor: doc.doctor, hospital: doc.hospital, status: "Pending" },
      { $set: { status: "Approved", decidedAt: new Date(), statusLastChangedAt: new Date() } },
    )
    .catch(() => undefined);
});

const HospitalDoctor = mongoose.model("HospitalDoctor", HospitalDoctorSchema);

export default HospitalDoctor;
