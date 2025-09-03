import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IInvoice } from "./Invoice";

export const paymentMethods = ["Manual"] as const;

export type PaymentMethod = (typeof paymentMethods)[number];

export interface IInvoiceCheckout extends MongoDoc {
  invoice: IInvoice;
  paidAt: Date;
  paymentMethod: PaymentMethod;
}

const InvoiceCheckoutSchema = new mongoose.Schema<
  IInvoiceCheckout,
  Model<IInvoiceCheckout>
>({
  invoice: {
    type: mongoose.Schema.ObjectId,
    ref: "Invoice",
    required: true,
    unique: true,
  },
  paidAt: { type: Date, default: () => new Date() },
  paymentMethod: { type: String, enum: paymentMethods, required: true },
});

const InvoiceCheckout = mongoose.model(
  "InvoiceCheckout",
  InvoiceCheckoutSchema
);

export default InvoiceCheckout;
