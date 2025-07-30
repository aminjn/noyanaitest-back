import mongoose, { Model } from "mongoose";

export interface IInvoice {}

const InvoiceSchema = new mongoose.Schema<IInvoice, Model<IInvoice>>({});

const Invoice = mongoose.model("Invoice", InvoiceSchema);

export default Invoice;
