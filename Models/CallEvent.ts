import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { ICallRoom } from "./CallRoom";

// Lightweight audit trail for everything that happens in a call room -
// useful for support/dispute resolution and for building a call-history
// timeline in the client without replaying socket traffic.
export const callEventTypes = [
  "created",
  "invited",
  "ringing",
  "answered",
  "rejected",
  "joined",
  "left",
  "kicked",
  "missed",
  "muted",
  "unmuted",
  "videoOff",
  "videoOn",
  "screenShareStarted",
  "screenShareStopped",
  "recordingStarted",
  "recordingStopped",
  "ended",
  "cancelled",
] as const;

export type CallEventType = (typeof callEventTypes)[number];

export interface ICallEvent extends MongoDoc {
  room: ICallRoom;
  user?: IUser;
  type: CallEventType;
  meta?: Record<string, unknown>;
  createdAt: Date;
}

const CallEventSchema = new mongoose.Schema<ICallEvent, Model<ICallEvent>>({
  room: { type: mongoose.Schema.ObjectId, ref: "VoiceRoom", required: true },
  user: { type: mongoose.Schema.ObjectId, ref: "User" },
  type: { type: String, enum: callEventTypes, required: true },
  meta: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: () => new Date() },
});

CallEventSchema.index({ room: 1, createdAt: 1 });

const CallEvent = mongoose.model("CallEvent", CallEventSchema);

export default CallEvent;
