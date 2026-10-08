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
  // why an admin rejected it (the applicant is told)
  rejectReason?: string;
  decidedAt?: Date;
  name: string;
  // «شماره‌ی مجوز بیمه مرکزی» (2026-10): the licence the Central Insurance
  // of Iran gave the insurer; copied onto the insurer on approval. The siam
  // code and national id of the shared centre form meant nothing for an
  // insurer and were dropped on approval - old requests still have them.
  licenseNumber?: string;
  siamCode?: string;
  nationalId?: string;
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
    rejectReason: { type: String },
    decidedAt: { type: Date },
    name: { type: String, required: true },
    licenseNumber: { type: String, trim: true, maxlength: 60 },
    siamCode: { type: String },
    nationalId: { type: String },
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
