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

// "slot": waiting for any free slot («خبرم کن», the doctor is full);
// "earlier": already booked, waiting for an earlier slot of the same
// doctor and visit type («دنبال زمان زودتر هم بگرد», 2026-10) - the offer
// moves that reservation with the patient's own reschedule
export const waitlistKinds = ["slot", "earlier"] as const;
export type WaitlistKind = (typeof waitlistKinds)[number];
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
  // the account that waits, gets the notices and books (the family's
  // manager when waiting for a member)
  user: mongoose.Types.ObjectId;
  // who the visit is for: the account's own identity when missing, or a
  // family member it manages (Models/UserRelative.ts, 2026-10)
  patient?: mongoose.Types.ObjectId | null;
  kind?: WaitlistKind;
  // kind "earlier": the booked visit to move
  forReservation?: mongoose.Types.ObjectId | null;
  doctor: mongoose.Types.ObjectId;
  sessionType: DoctorSessionType;
  office?: mongoose.Types.ObjectId | null;
  // the key of the one-active-entry rule: the office ("" for any), then
  // "|p:<identity>" for a family member and "|r:<reservation>" for an
  // earlier-slot wait (keyFor below)
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
    patient: { type: mongoose.Schema.ObjectId, ref: "UserIdentity", default: null },
    kind: { type: String, enum: waitlistKinds, default: "slot" },
    forReservation: { type: mongoose.Schema.ObjectId, ref: "Reservation", default: null },
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

// the earlier-slot wait of a reservation
WaitlistEntrySchema.index({ forReservation: 1, status: 1 }, { partialFilterExpression: { kind: "earlier" } });

export const waitlistKeyFor = (o: { office?: unknown; patient?: unknown; forReservation?: unknown }) =>
  `${o.office ? String(o.office) : ""}${o.patient ? `|p:${String(o.patient)}` : ""}${o.forReservation ? `|r:${String(o.forReservation)}` : ""}`;

const WaitlistEntry = mongoose.model("WaitlistEntry", WaitlistEntrySchema);

export default WaitlistEntry;
