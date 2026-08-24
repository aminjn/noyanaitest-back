import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { ICheckout } from "./Checkout";
import { IReservation } from "./Reservation";
import { IDoctorProfile } from "./DoctorProfile";
import { IOrder } from "./Order";

export interface ITransaction extends MongoDoc {
  user: IUser;
  amount: number;
  checkout?: ICheckout;
  // the reservation/booking this transaction is for - e.g. the patient's
  // payment when it's created, or the doctor's payout once it completes
  reservation?: IReservation;
  // the cart order this transaction is the payment for
  order?: IOrder;
  // set on the doctor's payout transaction so it's traceable to the doctor
  // profile that earned it, since `user` there is the doctor's linked User
  // account, not the DoctorProfile itself
  doctor?: IDoctorProfile;
  createdAt: Date;
}

const TransactionSchema = new mongoose.Schema<
  ITransaction,
  Model<ITransaction>
>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  amount: { type: Number, required: true },
  checkout: { type: mongoose.Schema.ObjectId, ref: "Checkout" },
  reservation: { type: mongoose.Schema.ObjectId, ref: "Reservation" },
  order: { type: mongoose.Schema.ObjectId, ref: "Order" },
  doctor: { type: mongoose.Schema.ObjectId, ref: "DoctorProfile" },
  createdAt: { type: Date, default: () => new Date() },
});

const Transaction = mongoose.model("Transaction", TransactionSchema);

export default Transaction;
