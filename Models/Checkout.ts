import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

export interface ICheckout extends MongoDoc {
  user: IUser;
  amount: number;
  createdAt: Date;
}

const CheckoutSchema = new mongoose.Schema<ICheckout, Model<ICheckout>>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  amount: { type: Number, required: true },
  createdAt: { type: Date, default: () => new Date() },
});

const Checkout = mongoose.model("Checkout", CheckoutSchema);

export default Checkout;
