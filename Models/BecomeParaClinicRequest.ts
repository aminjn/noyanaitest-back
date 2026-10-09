import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { BecomeANodeStatus, becomeANodeStatuses } from "./BecomeDoctorRequest";

// 2026-09: expanded from a name-only request to the shared organization
// become-request shape (siamCode/nationalId/certificateDate/certificateFile/
// description), same fields as BecomeClinicRequest/BecomeHospitalRequest/
// BecomeInsuranceRequest/BecomePharmacyRequest. Doctor keeps its own
// separate model/flow (medical-system-code lookup), not this shape.
export interface IBecomeParaClinicRequest extends MongoDoc {
  user: IUser;
  createdAt: Date;
  updatedAt: Date;
  status: BecomeANodeStatus;
  // why an admin rejected it (the applicant is told)
  rejectReason?: string;
  decidedAt?: Date;
  name: string;
  siamCode: string;
  nationalId: string;
  // the licence's issue date (its Tehran day, noon)
  certificateDate: Date;
  // its expiry (2026-10, owner decision): asked on the form, required and
  // in the future (Lib/centreLicenceDates.ts); the approval copies both onto
  // the centre's licence. Older requests have none - the admin enters it
  // when approving them.
  certificateExpiresAt?: Date;
  // Saved filename under Public/ (see uploadController.saveUplaodsToBody) -
  // undefined until a certificate file is actually attached.
  certificateFile?: string;
  description?: string;
}

const BecomeParaClinicRequestSchema = new mongoose.Schema<
  IBecomeParaClinicRequest,
  Model<IBecomeParaClinicRequest>
>(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    status: { type: String, enum: becomeANodeStatuses, default: "Pending" },
    rejectReason: { type: String },
    decidedAt: { type: Date },
    name: { type: String, required: true },
    siamCode: { type: String, required: true },
    nationalId: { type: String, required: true },
    certificateDate: { type: Date, required: true },
    certificateExpiresAt: { type: Date },
    certificateFile: { type: String },
    description: { type: String },
  },
  { timestamps: true },
);

const BecomeParaClinicRequest = mongoose.model(
  "BecomeParaClinicRequest",
  BecomeParaClinicRequestSchema,
);

export default BecomeParaClinicRequest;
