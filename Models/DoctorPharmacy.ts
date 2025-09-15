import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";
import { IPharmacy } from "./Pharmacy";

export interface IDoctorPharmacy extends MongoDoc {
  doctor: IDoctorProfile;
  pharmacy: IPharmacy;
}

const DoctorPharmacySchema = new mongoose.Schema<
  IDoctorPharmacy,
  Model<IDoctorPharmacy>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  pharmacy: { type: mongoose.Schema.ObjectId, ref: "Pharmacy", required: true },
});

DoctorPharmacySchema.index({ doctor: 1, pharmacy: 1 }, { unique: true });

const DoctorPharmacy = mongoose.model("DoctorPharmacy", DoctorPharmacySchema);

export default DoctorPharmacy;
