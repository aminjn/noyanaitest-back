import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { ITicket } from "./Ticket";
import Ticket from "./Ticket";
import Notification from "./Notification";

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

// Capture whether this is a brand-new document before Mongoose flips
// `isNew` to false as part of the save - the post("save") hook below needs
// this to fire only once, right after creation.
TicketMessageSchema.pre("save", function (next) {
  this.$locals.isNewMessage = this.isNew;
  next();
});

// When an admin replies to a ticket (isAdmin: true), notify the user who
// submitted it. This covers both a dedicated respond endpoint and the
// generic admin CRUD route (POST /auto/ticketmessage), which is what the
// admin panel actually uses to send replies.
TicketMessageSchema.post("save", async function (doc) {
  if (!doc.$locals.isNewMessage || !doc.isAdmin) return;
  try {
    const ticket = await Ticket.findById(doc.ticket);
    if (!ticket) return;
    // an admin reply moves a new ticket to "in progress"
    if (ticket.status === "Open")
      await Ticket.updateOne({ _id: ticket._id }, { $set: { status: "InProgress" } });
    await Notification.create({
      user: ticket.submittedBy,
      title: "پاسخ جدید به تیکت شما",
      message: `پشتیبانی به تیکت «${ticket.title}» پاسخ داد.`,
      source: "System",
      link: `/dashboard/support/${ticket._id}`,
    });
  } catch (err) {
    console.log(
      "[TicketMessage] failed to notify user of admin response:",
      err,
    );
  }
});

const TicketMessage = mongoose.model("TicketMessage", TicketMessageSchema);

export default TicketMessage;
