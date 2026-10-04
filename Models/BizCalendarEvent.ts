import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A team calendar event (2026-10, nexxacrm's calendarEvent): a meeting, a
// call, an operating-room slot, a home visit. Without a time it is all-day;
// times are Tehran's. Patients' appointments stay in the panel's booking
// calendar and are not copied here.
export const bizEventKinds = ["meeting", "call", "surgery", "visit", "other"] as const;

export interface IBizCalendarEvent extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  title: string;
  kind: (typeof bizEventKinds)[number];
  start: Date;
  end?: Date;
  allDay: boolean;
  contact?: mongoose.Types.ObjectId;
  note?: string;
  done: boolean;
  // who made it
  user: mongoose.Types.ObjectId;
  createdAt: Date;
}

const BizCalendarEventSchema = new mongoose.Schema<IBizCalendarEvent, Model<IBizCalendarEvent>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    kind: { type: String, enum: bizEventKinds, default: "meeting" },
    start: { type: Date, required: true },
    end: Date,
    allDay: { type: Boolean, default: false },
    contact: { type: mongoose.Schema.ObjectId, ref: "BizContact" },
    note: { type: String, trim: true, maxlength: 1000 },
    done: { type: Boolean, default: false },
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

BizCalendarEventSchema.index({ ownerKind: 1, ownerId: 1, start: 1 });

const BizCalendarEvent = mongoose.model("BizCalendarEvent", BizCalendarEventSchema);
export default BizCalendarEvent;
