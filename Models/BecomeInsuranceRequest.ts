import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { BecomeANodeStatus, becomeANodeStatuses } from "./BecomeDoctorRequest";

export interface IBecomeInsuranceRequest extends MongoDoc {
  user: IUser;
  createdAt: Date;
  status: BecomeANodeStatus;
  name: string;
}

const BecomeInsuranceRequestSchema = new mongoose.Schema<
  IBecomeInsuranceRequest,
  Model<IBecomeInsuranceRequest>
>({
  user: {
    type: mongoose.Schema.ObjectId,
    required: true,
    ref: "User",
    unique: true,
  },
  createdAt: { type: Date, default: () => new Date() },
  status: { type: String, enum: becomeANodeStatuses, default: "Pending" },
  name: { type: String, required: true },
});

const BecomeInsuranceRequest = mongoose.model(
  "BecomeInsuranceRequest",
  BecomeInsuranceRequestSchema
);

export default BecomeInsuranceRequest;
