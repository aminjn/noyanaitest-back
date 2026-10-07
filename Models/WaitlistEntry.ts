import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { doctorSessionTypes, DoctorSessionType } from "./DoctorSession";

// «وقتی نوبت خالی شد خبرم کن» (2026-10, Lib/waitlist.ts): a patient waiting
// for a free slot of one doctor, one visit type and optionally one office,
// inside a range of Tehran days. When a slot of that kind frees up (a
// cancellation, a reschedule away, new hours, time off removed, the booking
// horizon moving on), the earliest waiters hear about it in small waves
// with a short head start (Doctolib / Zocdoc). Booking still goes through
// POST /booking/reserve and all its checks: the notice holds nothing.

export const waitlistStatuses = ["active", "booked", "cancelled", "expired"] as const;
export type WaitlistStatus = (typeof waitlistStatuses)[number];

export type WaitlistOffer = {
  ymd: string;
  start: number;
  end: number;
  office?: string;
  sentAt: Date;
  // the head start of this wave: until then the slot is not offered to
  // the next waiters
  holdUntil: Date;
};

export interface IWaitlistEntry extends MongoDoc {
  user: mongoose.Types.ObjectId;
  doctor: mongoose.Types.ObjectId;
  sessionType: DoctorSessionType;
  office?: mongoose.Types.ObjectId | null;
  // "" for any office: the key of the one-active-entry rule
  officeKey: string;
  // Tehran days "YYYY-MM-DD", both included
  from: string;
  to: string;
  // "any time in the next N days" (kept to show the choice back)
  days?: number;
  status: WaitlistStatus;
  // the short code of the SMS link (/w/<code>)
  code: string;
  offer?: WaitlistOffer | null;
  // the current offer's hold has not been settled yet (the sweep looks for
  // these to move on to the next wave)
  offerOpen?: boolean;
  // slots ("ymd|start|office") this waiter already heard about, or that
  // were already free when they joined
  seen: string[];
  // notices sent: in all, and on noticeDay (rate limit)
  notices: number;
  noticeDay?: string;
  noticeCount: number;
  reservation?: mongoose.Types.ObjectId;
  endedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const WaitlistEntrySchema = new mongoose.Schema<IWaitlistEntry, Model<IWaitlistEntry>>(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    doctor: { type: mongoose.Schema.ObjectId, ref: "DoctorProfile", required: true },
    sessionType: { type: String, enum: doctorSessionTypes, required: true },
    office: { type: mongoose.Schema.ObjectId, ref: "Office", default: null },
    officeKey: { type: String, default: "" },
    from: { type: String, required: true },
    to: { type: String, required: true },
    days: { type: Number },
    status: { type: String, enum: waitlistStatuses, default: "active" },
    code: { type: String, required: true, unique: true },
    offer: {
      type: {
        ymd: String,
        start: Number,
        end: Number,
        office: String,
        sentAt: Date,
        holdUntil: Date,
      },
      default: null,
    },
    offerOpen: { type: Boolean, default: false },
    seen: { type: [String], default: [] },
    notices: { type: Number, default: 0 },
    noticeDay: { type: String },
    noticeCount: { type: Number, default: 0 },
    reservation: { type: mongoose.Schema.ObjectId, ref: "Reservation" },
    endedAt: { type: Date },
  },
  { timestamps: true },
);

// one active entry per (patient, doctor, visit type, office)
WaitlistEntrySchema.index(
  { user: 1, doctor: 1, sessionType: 1, officeKey: 1 },
  { unique: true, partialFilterExpression: { status: "active" } },
);
// matching: a doctor's active waiters, first come first
WaitlistEntrySchema.index({ doctor: 1, status: 1, createdAt: 1 });
WaitlistEntrySchema.index({ status: 1, offerOpen: 1, "offer.holdUntil": 1 });

const WaitlistEntry = mongoose.model("WaitlistEntry", WaitlistEntrySchema);

export default WaitlistEntry;
