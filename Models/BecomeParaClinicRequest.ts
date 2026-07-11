import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { BecomeANodeStatus, becomeANodeStatuses } from "./BecomeDoctorRequest";

export interface IBecomeParaClinicRequest extends MongoDoc {
  user: IUser;
  createdAt: Date;
  status: BecomeANodeStatus;
  name: string;
}

const BecomeParaClinicRequestSchema = new mongoose.Schema<
  IBecomeParaClinicRequest,
  Model<IBecomeParaClinicRequest>
>({
  user: {
    type: mongoose.Schema.ObjectId,
    ref: "User",
    required: true,
    unique: true,
  },
  createdAt: { type: Date, default: () => new Date() },
  status: { type: String, enum: becomeANodeStatuses, default: "Pending" },
  name: { type: String, required: true },
});

const BecomeParaClinicRequest = mongoose.model(
  "BecomeParaClinicRequest",
  BecomeParaClinicRequestSchema,
);

export default BecomeParaClinicRequest;
