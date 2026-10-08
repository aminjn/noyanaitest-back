import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { BecomeANodeStatus, becomeANodeStatuses } from "./BecomeDoctorRequest";

// 2026-09: expanded from a name-only request to the shared organization
// become-request shape (siamCode/nationalId/certificateDate/certificateFile/
// description), same fields as BecomeClinicRequest/BecomeInsuranceRequest/
// BecomeParaClinicRequest/BecomePharmacyRequest. Doctor keeps its own
// separate model/flow (medical-system-code lookup), not this shape.
export interface IBecomeHospitalRequest extends MongoDoc {
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
  certificateDate: Date;
  // Saved filename under Public/ (see uploadController.saveUplaodsToBody) -
  // undefined until a certificate file is actually attached.
  certificateFile?: string;
  description?: string;
  centre?: unknown;
}

const BecomeHospitalRequestSchema = new mongoose.Schema<
  IBecomeHospitalRequest,
  Model<IBecomeHospitalRequest>
>(
  {
    // not unique (2026-10): an owner asks for each new centre with a new
    // request (one account can own several, Lib/activeCentre.ts); the old
    // unique index is dropped by Lib/migrateMultiCentreOwners.ts
    user: {
      type: mongoose.Schema.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },
    // the centre this request's approval created or linked: approving it
    // again returns that centre instead of making another
    centre: { type: mongoose.Schema.ObjectId, ref: "Hospital" },
    status: { type: String, enum: becomeANodeStatuses, default: "Pending" },
    rejectReason: { type: String },
    decidedAt: { type: Date },
    name: { type: String, required: true },
    siamCode: { type: String, required: true },
    nationalId: { type: String, required: true },
    certificateDate: { type: Date, required: true },
    certificateFile: { type: String },
    description: { type: String },
  },
  { timestamps: true },
);

const BecomeHospitalRequest = mongoose.model(
  "BecomeHospitalRequest",
  BecomeHospitalRequestSchema
);

export default BecomeHospitalRequest;
