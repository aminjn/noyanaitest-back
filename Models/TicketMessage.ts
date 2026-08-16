import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { ITicket } from "./Ticket";

export interface ITicketMessage extends MongoDoc {
  ticket: ITicket;
  submittedAt: Date;
  content: string;
  isAdmin: boolean;
}

const TicketMessageSchema = new mongoose.Schema<
  ITicketMessage,
  Model<ITicketMessage>
>({
  ticket: { type: mongoose.Schema.ObjectId, ref: "Ticket", required: true },
  submittedAt: { type: Date, default: () => new Date() },
  content: { type: String, required: true },
  isAdmin: { type: Boolean, default: false },
});

const TicketMessage = mongoose.model("TicketMessage", TicketMessageSchema);

export default TicketMessage;
