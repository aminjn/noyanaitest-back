import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { BecomeANodeStatus, becomeANodeStatuses } from "./BecomeDoctorRequest";

// 2026-09: expanded from a name-only request to the shared organization
// become-request shape (siamCode/nationalId/certificateDate/certificateFile/
// description), same fields as BecomeClinicRequest/BecomeHospitalRequest/
// BecomeInsuranceRequest/BecomeParaClinicRequest. Doctor keeps its own
// separate model/flow (medical-system-code lookup), not this shape.
export interface IBecomePharmacyRequest extends MongoDoc {
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
}

const BecomePharmacyRequestSchema = new mongoose.Schema<
  IBecomePharmacyRequest,
  Model<IBecomePharmacyRequest>
>(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      required: true,
      ref: "User",
      unique: true,
    },
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

const BecomePharmacyRequest = mongoose.model(
  "BecomePharmacyRequest",
  BecomePharmacyRequestSchema
);

export default BecomePharmacyRequest;
