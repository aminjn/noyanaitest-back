import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

export const ticketSubjects = [
  "TechnicalIssue",
  "BillingIssue",
  "AccountIssue",
  "FeatureRequest",
  "BugReport",
  "GeneralInquiry",
] as const;

export type TicketSubject = (typeof ticketSubjects)[number];

export const ticketStatuses = [
  "Open",
  "InProgress",
  "Resolved",
  "Closed",
] as const;

export type TicketStatus = (typeof ticketStatuses)[number];

export interface ITicket extends MongoDoc {
  submittedAt: Date;
  subject: TicketSubject;
  status: TicketStatus;
  submittedBy: IUser;
  title: string;
}

const TicketSchema = new mongoose.Schema<ITicket, Model<ITicket>>(
  {
    submittedAt: { type: Date, default: () => new Date() },
    subject: { type: String, required: true, enum: ticketSubjects },
    status: { type: String, enum: ticketStatuses, default: "Open" },
    submittedBy: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
    },
    title: { type: String, required: true },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

TicketSchema.virtual("messages", {
  ref: "TicketMessage",
  localField: "_id",
  foreignField: "ticket",
});

const Ticket = mongoose.model("Ticket", TicketSchema);

export default Ticket;
