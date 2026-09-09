import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { BecomeANodeStatus, becomeANodeStatuses } from "./BecomeDoctorRequest";

// 2026-09: expanded from a name-only request to the shared organization
// become-request shape (siamCode/nationalId/certificateDate/certificateFile/
// description), same fields as BecomeClinicRequest/BecomeHospitalRequest/
// BecomeParaClinicRequest/BecomePharmacyRequest. Doctor keeps its own
// separate model/flow (medical-system-code lookup), not this shape.
export interface IBecomeInsuranceRequest extends MongoDoc {
  user: IUser;
  createdAt: Date;
  updatedAt: Date;
  status: BecomeANodeStatus;
  name: string;
  siamCode: string;
  nationalId: string;
  certificateDate: Date;
  // Saved filename under Public/ (see uploadController.saveUplaodsToBody) -
  // undefined until a certificate file is actually attached.
  certificateFile?: string;
  description?: string;
}

const BecomeInsuranceRequestSchema = new mongoose.Schema<
  IBecomeInsuranceRequest,
  Model<IBecomeInsuranceRequest>
>(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      required: true,
      ref: "User",
      unique: true,
    },
    status: { type: String, enum: becomeANodeStatuses, default: "Pending" },
    name: { type: String, required: true },
    siamCode: { type: String, required: true },
    nationalId: { type: String, required: true },
    certificateDate: { type: Date, required: true },
    certificateFile: { type: String },
    description: { type: String },
  },
  { timestamps: true },
);

const BecomeInsuranceRequest = mongoose.model(
  "BecomeInsuranceRequest",
  BecomeInsuranceRequestSchema
);

export default BecomeInsuranceRequest;
