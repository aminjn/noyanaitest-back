import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { BecomeANodeStatus, becomeANodeStatuses } from "./BecomeDoctorRequest";

export interface IBecomeClinicRequest extends MongoDoc {
  user: IUser;
  createdAt: Date;
  status: BecomeANodeStatus;
  name: string;
}

const BecomeClinicRequestSchema = new mongoose.Schema<
  IBecomeClinicRequest,
  Model<IBecomeClinicRequest>
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

const BecomeClinicRequest = mongoose.model(
  "BecomeClinicRequest",
  BecomeClinicRequestSchema
);

export default BecomeClinicRequest;
