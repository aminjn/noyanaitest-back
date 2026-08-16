import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export const contactRequestSubjects = [
  "support",
  "profile",
  "users",
  "bug",
] as const;

export type ContactRequestSubject = (typeof contactRequestSubjects)[number];

export const contactRequestStatuses = ["pending", "done"] as const;

export type ContactRequestStatus = (typeof contactRequestStatuses)[number];

export interface IContactRequest extends MongoDoc {
  submittedAt: Date;
  name: string;
  phone: string;
  email?: string;
  subject: ContactRequestSubject;
  content: string;
  status: ContactRequestStatus;
}

const ContactRequestSchema = new mongoose.Schema<
  IContactRequest,
  Model<IContactRequest>
>({
  submittedAt: { type: Date, default: () => new Date() },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String },
  subject: { type: String, enum: contactRequestSubjects, required: true },
  content: { type: String, required: true },
  status: { type: String, enum: contactRequestStatuses, default: "pending" },
});

const ContactRequest = mongoose.model("ContactRequest", ContactRequestSchema);

export default ContactRequest;
