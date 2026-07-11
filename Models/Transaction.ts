import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { ICheckout } from "./Checkout";

export interface ITransaction extends MongoDoc {
  user: IUser;
  amount: number;
  checkout?: ICheckout;
  createdAt: Date;
}

const TransactionSchema = new mongoose.Schema<
  ITransaction,
  Model<ITransaction>
>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  amount: { type: Number, required: true },
  checkout: { type: mongoose.Schema.ObjectId, ref: "Checkout" },
  createdAt: { type: Date, default: () => new Date() },
});

const Transaction = mongoose.model("Transaction", TransactionSchema);

export default Transaction;
