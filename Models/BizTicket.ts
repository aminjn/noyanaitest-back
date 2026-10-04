import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A patient's request or complaint to one centre (2026-10, Lib/business/
// crmService/tickets.ts), nexxacrm's «تیکت» - not Noyan's own support
// tickets (Models/Ticket.ts, a user to Noyan's support). Opened by the
// patient from their panel or by the desk for them; numbered per owner,
// given to the least-loaded team member, with response and resolve
// deadlines by priority (SLA). The first public reply stops the response
// clock; an internal note never changes the status.
//   open -> pending (answered, waiting on the patient) -> resolved -> closed
export const bizTicketStatuses = ["open", "pending", "resolved", "closed"] as const;
export type BizTicketStatus = (typeof bizTicketStatuses)[number];
export const bizTicketPriorities = ["low", "normal", "high", "urgent"] as const;
export type BizTicketPriority = (typeof bizTicketPriorities)[number];
export const bizTicketCategories = ["question", "complaint", "billing", "result", "prescription", "other"] as const;

export interface IBizTicketMessage {
  _id: mongoose.Types.ObjectId;
  body: string;
  // staff-only
  internal: boolean;
  // written by the patient (their account), else a staff member
  fromPatient: boolean;
  author?: mongoose.Types.ObjectId;
  at: Date;
}

export interface IBizTicket extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  number: number;
  subject: string;
  category: (typeof bizTicketCategories)[number];
  priority: BizTicketPriority;
  status: BizTicketStatus;
  contact?: mongoose.Types.ObjectId;
  // the patient's account (they see it in their panel)
  user?: mongoose.Types.ObjectId;
  assignee?: mongoose.Types.ObjectId;
  responseDueAt?: Date;
  resolveDueAt?: Date;
  firstResponseAt?: Date;
  resolvedAt?: Date;
  // the SLA breach already told to the assignee
  breachNotified?: "response" | "resolve";
  // the visit or order it is about
  reservation?: mongoose.Types.ObjectId;
  messages: IBizTicketMessage[];
  lastMessageAt: Date;
  openedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const MessageSchema = new mongoose.Schema<IBizTicketMessage>({
  body: { type: String, required: true, trim: true, maxlength: 5000 },
  internal: { type: Boolean, default: false },
  fromPatient: { type: Boolean, default: false },
  author: { type: mongoose.Schema.ObjectId, ref: "User" },
  at: { type: Date, default: () => new Date() },
});

const BizTicketSchema = new mongoose.Schema<IBizTicket, Model<IBizTicket>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    number: { type: Number, required: true },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    category: { type: String, enum: bizTicketCategories, default: "question" },
    priority: { type: String, enum: bizTicketPriorities, default: "normal" },
    status: { type: String, enum: bizTicketStatuses, default: "open" },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact" },
    user: { type: mongoose.Schema.ObjectId, ref: "User" },
    assignee: { type: mongoose.Schema.ObjectId, ref: "User" },
    responseDueAt: Date,
    resolveDueAt: Date,
    firstResponseAt: Date,
    resolvedAt: Date,
    breachNotified: { type: String, enum: ["response", "resolve"] },
    reservation: { type: mongoose.Schema.ObjectId, ref: "Reservation" },
    messages: { type: [MessageSchema], default: [] },
    lastMessageAt: { type: Date, default: () => new Date() },
    openedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizTicketSchema.index({ ownerKind: 1, ownerId: 1, number: 1 }, { unique: true });
BizTicketSchema.index({ ownerKind: 1, ownerId: 1, status: 1, lastMessageAt: -1 });
BizTicketSchema.index({ user: 1, lastMessageAt: -1 });
BizTicketSchema.index({ status: 1, resolveDueAt: 1 });

const BizTicket = mongoose.model("BizTicket", BizTicketSchema);
export default BizTicket;
