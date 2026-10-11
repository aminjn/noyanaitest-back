import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

// A doctor's Tamin e-prescription session and identity (see
// Lib/taminEp.ts). Tokens come from the v2 token endpoint, which also
// issues a refresh_token, so a doctor only goes through Tamin's login page
// again when the refresh token itself stops working.
//
// The tokens never leave the server: refreshToken is select: false and no
// API returns this document (GET /doctor/tamin/settings sends a summary).
export interface IDoctorTaminCred extends MongoDoc {
  doctor: IDoctorProfile;
  verifier?: string;
  challenge?: string;
  // PKCE `state` of a login in progress, checked on the callback.
  loginState?: string;
  token?: string;
  refreshToken?: string;
  tokenRefreshedAt?: Date;
  tokenExpiresAt?: Date;
  // the Tamin environment ("production" | "test") the token was issued by.
  // A token from the other environment (or from before 2026-10, when every
  // token came from the sandbox) counts as no token: the doctor logs in again.
  environment?: string;
  // Overrides for the identity sent to Tamin (docId / docNationalCode /
  // docMobileNo must match the doctor's EP.TAMIN.IR registration exactly).
  // Unset fields fall back to the doctor's profile.
  docId?: string;
  docNationalCode?: string;
  docMobileNo?: string;
  // Workplace used for eligibility checks (deserve-info siam-id). Unset
  // means the doctor's own office, for which Tamin wants the docId instead.
  siamId?: string;
  siamName?: string;
}

const DoctorTaminCredSchema = new mongoose.Schema<
  IDoctorTaminCred,
  Model<IDoctorTaminCred>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
    unique: true,
  },
  verifier: { type: String },
  challenge: { type: String },
  loginState: { type: String },
  token: { type: String },
  refreshToken: { type: String, select: false },
  tokenRefreshedAt: { type: Date },
  tokenExpiresAt: { type: Date },
  environment: { type: String, enum: ["production", "test"] },
  docId: { type: String, trim: true },
  docNationalCode: { type: String, trim: true },
  docMobileNo: { type: String, trim: true },
  siamId: { type: String, trim: true },
  siamName: { type: String, trim: true },
});

const DoctorTaminCred = mongoose.model(
  "DoctorTaminCred",
  DoctorTaminCredSchema,
);

export default DoctorTaminCred;
