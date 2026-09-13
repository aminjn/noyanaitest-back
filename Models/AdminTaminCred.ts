import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// Admin-only sandbox credential for testing Tamin's API (2026-09). See
// Controllers/featureGateController.ts for why real doctor/pharmacy/
// paraClinic accounts can no longer reach Tamin directly, and
// Controllers/adminTaminController.ts for how this is used.
//
// Structurally identical to DoctorTaminCred (Models/DoctorTaminCred.ts),
// but deliberately NOT tied to any real DoctorProfile - it's a single
// admin-wide singleton (adminTaminController.ts always resolves it via
// `AdminTaminCred.findOneAndUpdate({}, {}, { upsert: true, new: true })`
// with no filter), so testing never touches or risks a real org's own
// Tamin credential or data. This mirrors how pharmacyController.ts and
// paraClinicController.ts already borrow "any" DoctorTaminCred via
// `findOne()` with no filter for their own live calls - here it's the same
// shared-singleton idea, just for an identity that isn't a real org
// account. Used for the doctor, pharmacy, and paraClinic admin test
// consoles (pharmacy/paraClinic never had their own credential model in
// the first place - see ClinicTaminToken/AdminClinicTaminCred for the one
// org type that does).
export interface IAdminTaminCred extends MongoDoc {
  verifier?: string;
  challenge?: string;
  token?: string;
  tokenRefreshedAt?: Date;
}

const AdminTaminCredSchema = new mongoose.Schema<
  IAdminTaminCred,
  Model<IAdminTaminCred>
>({
  verifier: { type: String },
  challenge: { type: String },
  token: { type: String },
  tokenRefreshedAt: { type: Date },
});

const AdminTaminCred = mongoose.model("AdminTaminCred", AdminTaminCredSchema);

export default AdminTaminCred;
