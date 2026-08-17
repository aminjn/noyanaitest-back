import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IBooking } from "./Booking";
import { ICallParticipant } from "./CallParticipant";
import { ICallRecording } from "./CallRecording";
import { IReservation } from "./Reservation";

export const callTypes = ["voice", "video"] as const;

export type CallType = (typeof callTypes)[number];

// "adhoc": started directly between users through the call API.
// "booking": generated for/linked to a Booking (a scheduled doctor session).
export const callSources = ["adhoc", "booking"] as const;

export type CallSource = (typeof callSources)[number];

// ringing   -> room created, invited participants have not all joined yet
// active    -> at least one participant has joined
// ended     -> call finished normally (host ended it or everyone left)
// cancelled -> nobody answered before it was cancelled/timed out, or the
//              initiator cancelled before anyone joined
export const callStatuses = [
  "ringing",
  "active",
  "ended",
  "cancelled",
] as const;

export type CallStatus = (typeof callStatuses)[number];

export interface ICallRoom extends MongoDoc {
  initiator?: IUser;
  host?: IUser;
  participants: IUser[];
  callType: CallType;
  source: CallSource;
  booking?: IBooking;
  // set when this room was opened for a booked session on the new
  // Reservation model, by the reservation activation cron
  reservation?: IReservation;
  status: CallStatus;
  startedAt: Date;
  connectedAt?: Date;
  endedAt?: Date;
  endedBy?: IUser;
  recordingEnabled: boolean;
  maxParticipants: number;
  // Virtuals
  callParticipants?: ICallParticipant[];
  recordings?: ICallRecording[];
}

const CallRoomSchema = new mongoose.Schema<ICallRoom, Model<ICallRoom>>(
  {
    initiator: { type: mongoose.Schema.ObjectId, ref: "User" },
    host: { type: mongoose.Schema.ObjectId, ref: "User" },
    participants: {
      type: [{ type: mongoose.Schema.ObjectId, ref: "User", required: true }],
      default: [],
    },
    callType: { type: String, enum: callTypes, required: true },
    source: { type: String, enum: callSources, default: "adhoc" },
    booking: { type: mongoose.Schema.ObjectId, ref: "Booking" },
    reservation: { type: mongoose.Schema.ObjectId, ref: "Reservation" },
    status: { type: String, enum: callStatuses, default: "ringing" },
    startedAt: { type: Date, default: () => new Date() },
    connectedAt: { type: Date },
    endedAt: { type: Date },
    endedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    recordingEnabled: { type: Boolean, default: false },
    maxParticipants: { type: Number, default: 8 },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

CallRoomSchema.virtual("callParticipants", {
  ref: "CallParticipant",
  localField: "_id",
  foreignField: "room",
});

CallRoomSchema.virtual("recordings", {
  ref: "CallRecording",
  localField: "_id",
  foreignField: "room",
});

CallRoomSchema.index({ participants: 1, status: 1 });
CallRoomSchema.index({ booking: 1 });
CallRoomSchema.index({ reservation: 1 });

const CallRoom = mongoose.model("VoiceRoom", CallRoomSchema);

export default CallRoom;
