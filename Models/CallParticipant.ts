import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { ICallRoom } from "./CallRoom";

export const callParticipantRoles = ["host", "guest"] as const;

export type CallParticipantRole = (typeof callParticipantRoles)[number];

// invited -> added to the room but hasn't answered/joined yet
// joined  -> currently (or at some point was) connected with live media
// left    -> joined at some point and then left voluntarily
// kicked  -> removed by the host
// rejected-> declined the incoming call before joining
// missed  -> call ended/timed out while still "invited"
export const callParticipantStatuses = [
  "invited",
  "joined",
  "left",
  "kicked",
  "rejected",
  "missed",
] as const;

export type CallParticipantStatus = (typeof callParticipantStatuses)[number];

export interface ICallParticipant extends MongoDoc {
  room: ICallRoom;
  user: IUser;
  role: CallParticipantRole;
  status: CallParticipantStatus;
  invitedAt: Date;
  joinedAt?: Date;
  leftAt?: Date;
  audioMuted: boolean;
  videoMuted: boolean;
  screenSharing: boolean;
  // Forced by the host, distinct from the participant's own mute state -
  // the client should not be able to unmute itself while this is true.
  forceMuted: boolean;
  kickedBy?: IUser;
}

const CallParticipantSchema = new mongoose.Schema<
  ICallParticipant,
  Model<ICallParticipant>
>({
  room: {
    type: mongoose.Schema.ObjectId,
    ref: "VoiceRoom",
    required: true,
  },
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  role: { type: String, enum: callParticipantRoles, default: "guest" },
  status: {
    type: String,
    enum: callParticipantStatuses,
    default: "invited",
  },
  invitedAt: { type: Date, default: () => new Date() },
  joinedAt: { type: Date },
  leftAt: { type: Date },
  audioMuted: { type: Boolean, default: false },
  videoMuted: { type: Boolean, default: false },
  screenSharing: { type: Boolean, default: false },
  forceMuted: { type: Boolean, default: false },
  kickedBy: { type: mongoose.Schema.ObjectId, ref: "User" },
});

CallParticipantSchema.index({ room: 1, user: 1 }, { unique: true });

const CallParticipant = mongoose.model(
  "CallParticipant",
  CallParticipantSchema,
);

export default CallParticipant;
