import mongoose, { Model } from "mongoose";
import {
  DoctorSessionType,
  doctorSessionTypes,
  IDoctorSession,
} from "./DoctorSession";
import { IUser, MongoDoc } from "./User";
import { IInvoiceCheckout } from "./InvocieCheckout";
import { IUserIdentity } from "./UserIdentity";

export interface IInvoice extends MongoDoc {
  submittedAt: Date;
  total: number;
  user: IUser;
  session?: IDoctorSession;
  sessionKind?: DoctorSessionType;
  checkout?: IInvoiceCheckout | null;
  payable: boolean;
  patient: IUserIdentity;
}

const InvoiceSchema = new mongoose.Schema<IInvoice, Model<IInvoice>>(
  {
    submittedAt: { type: Date, default: () => new Date() },
    total: { type: Number, required: true },
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    session: { type: mongoose.Schema.ObjectId, ref: "DoctorSession" },
    sessionKind: { type: String, enum: doctorSessionTypes },
    payable: { type: Boolean, default: true },
    patient: {
      type: mongoose.Schema.ObjectId,
      ref: "UserIdentity",
      required: true,
    },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

InvoiceSchema.virtual("checkout", {
  ref: "InvoiceCheckout",
  localField: "_id",
  foreignField: "invoice",
  justOne: true,
});

const Invoice = mongoose.model("Invoice", InvoiceSchema);

export default Invoice;
