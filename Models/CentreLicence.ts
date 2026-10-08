import mongoose from "mongoose";

// A centre's operating licence as the staff checked it (2026-10, owner
// decision): what the verified tick on the centre card and page means
// (Lib/centreVerified.ts centreVerified). Kept on the centre itself
// (Clinic, Hospital, Pharmacy, ParaClinic, Insurance) and written only by
// the admin (PUT /admin/<kind>/<id>/licence) or by approving the centre's
// become-request - the centre's own profile form never touches it.
//
// The licence NUMBER stays in the field each kind already had (clinic
// clinicCode, hospital code, insurer licenseNumber - the siam / Central
// Insurance code copied from the approved request), pharmacy and lab got a
// licenseNumber field: one number per centre, never a second copy here.
// See centreLicenceNumberField in Lib/centreVerified.ts.
//
// verifiedAt  -> when the staff approved the licence (unset = not verified)
// verifiedBy  -> who (the admin, or the request's approver)
// issuedAt    -> the licence's issue date, when known (the request's
//                certificateDate)
// expiresAt   -> its expiry; past it the tick is gone at once (the sweep
//                only tells the centre). Unset = no expiry on record (a
//                licence verified before expiry dates were kept)
export interface ICentreLicence {
  verifiedAt?: Date;
  verifiedBy?: mongoose.Types.ObjectId;
  issuedAt?: Date;
  expiresAt?: Date;
}

export const CentreLicenceSchema = new mongoose.Schema<ICentreLicence>(
  {
    verifiedAt: { type: Date },
    verifiedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    issuedAt: { type: Date },
    expiresAt: { type: Date },
  },
  { _id: false },
);
