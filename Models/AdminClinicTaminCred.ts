import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// Admin-only sandbox credential for testing Tamin's clinic (ParaClinic
// referral) API (2026-09) - the clinic counterpart of AdminTaminCred.ts;
// see that file's comment for the full rationale. Structurally identical
// to ClinicTaminToken (Models/ClinicTaminToken.ts), but deliberately NOT
// tied to any real Clinic - a single admin-wide singleton, resolved the
// same way (`AdminClinicTaminCred.findOneAndUpdate({}, {}, { upsert: true,
// new: true })` with no filter) in Controllers/adminTaminController.ts.
export interface IAdminClinicTaminCred extends MongoDoc {
  verifier?: string;
  challenge?: string;
  token?: string;
  tokenRefreshedAt?: Date;
}

const AdminClinicTaminCredSchema = new mongoose.Schema<
  IAdminClinicTaminCred,
  Model<IAdminClinicTaminCred>
>({
  verifier: { type: String },
  challenge: { type: String },
  token: { type: String },
  tokenRefreshedAt: { type: Date },
});

const AdminClinicTaminCred = mongoose.model(
  "AdminClinicTaminCred",
  AdminClinicTaminCredSchema,
);

export default AdminClinicTaminCred;
