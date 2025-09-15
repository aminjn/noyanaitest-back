import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { BecomeANodeStatus, becomeANodeStatuses } from "./BecomeDoctorRequest";

export interface IBecomePharmacyRequest extends MongoDoc {
  user: IUser;
  createdAt: Date;
  status: BecomeANodeStatus;
  name: string;
}

const BecomePharmacyRequestSchema = new mongoose.Schema<
  IBecomePharmacyRequest,
  Model<IBecomePharmacyRequest>
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

const BecomePharmacyRequest = mongoose.model(
  "BecomePharmacyRequest",
  BecomePharmacyRequestSchema
);

export default BecomePharmacyRequest;
