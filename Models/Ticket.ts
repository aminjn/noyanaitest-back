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

export const ticketPriorities = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof ticketPriorities)[number];

// First-response target per priority, in hours (the age / SLA column of the
// admin queue). Zendesk-style defaults; a ticket waiting on support longer
// than this is shown as overdue.
export const ticketSlaHours: Record<TicketPriority, number> = {
  urgent: 2,
  high: 8,
  normal: 24,
  low: 72,
};

export interface ITicketNote {
  _id: mongoose.Types.ObjectId;
  content: string;
  author?: mongoose.Types.ObjectId;
  at: Date;
}

export interface ITicket extends MongoDoc {
  submittedAt: Date;
  subject: TicketSubject;
  status: TicketStatus;
  submittedBy: IUser;
  title: string;
  // support desk (2026-10): who handles it, how urgent it is, staff-only
  // notes, and the staff member who opened it for the user (if any)
  priority: TicketPriority;
  assignee?: mongoose.Types.ObjectId | IUser;
  internalNotes?: ITicketNote[];
  openedBy?: mongoose.Types.ObjectId | IUser;
  // opened by a «پرو» member (2026-10, priority support): the admin queue
  // shows the badge, the priority came from PatientProPlan.supportPriority
  pro?: boolean;
}

const TicketNoteSchema = new mongoose.Schema<ITicketNote>({
  content: { type: String, required: true, trim: true, maxlength: 5000 },
  author: { type: mongoose.Schema.ObjectId, ref: "User" },
  at: { type: Date, default: () => new Date() },
});

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
    priority: { type: String, enum: ticketPriorities, default: "normal", index: true },
    assignee: { type: mongoose.Schema.ObjectId, ref: "User", index: true },
    // never selected by default: the user's own ticket API (supportController)
    // must not see what staff wrote about them
    internalNotes: { type: [TicketNoteSchema], default: [], select: false },
    openedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    pro: { type: Boolean },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

TicketSchema.virtual("messages", {
  ref: "TicketMessage",
  localField: "_id",
  foreignField: "ticket",
});

// The user hears when support resolves or closes their ticket (an admin
// edit of `status`). The status before the update is read in the pre hook so
// only a real change notifies. Best effort: never fails the edit.
const statusNotice: Partial<Record<TicketStatus, { title: string; message: string }>> = {
  Resolved: {
    title: "تیکت شما حل شد",
    message: "پشتیبانی تیکت «${title}» را حل‌شده علامت زد. اگر مشکل باقی است پاسخ دهید.",
  },
  Closed: {
    title: "تیکت شما بسته شد",
    message: "تیکت «${title}» بسته شد. برای موضوع تازه تیکت جدیدی ثبت کنید.",
  },
};

TicketSchema.pre("findOneAndUpdate", async function () {
  const before = await this.model
    .findOne(this.getQuery())
    .select("status")
    .lean<{ status?: TicketStatus }>();
  (this as unknown as { _prevStatus?: TicketStatus })._prevStatus = before?.status;
});

TicketSchema.post("findOneAndUpdate", async function (doc: ITicket | null) {
  try {
    const prev = (this as unknown as { _prevStatus?: TicketStatus })._prevStatus;
    if (!doc) return;
    const fresh = await mongoose
      .model("Ticket")
      .findById(doc._id)
      .select("status title submittedBy")
      .lean<ITicket>();
    if (!fresh || fresh.status === prev) return;
    const notice = statusNotice[fresh.status];
    if (!notice) return;
    await mongoose.model("Notification").create({
      user: fresh.submittedBy,
      source: "System",
      title: notice.title,
      message: notice.message.replace("${title}", fresh.title),
      link: `/dashboard/support/${fresh._id}`,
    });
  } catch (err) {
    console.log("[Ticket] status notification failed:", err);
  }
});

const Ticket = mongoose.model("Ticket", TicketSchema);

export default Ticket;
