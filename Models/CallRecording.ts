import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { ICallRoom } from "./CallRoom";
import { ICallParticipant } from "./CallParticipant";

// "participant": a single participant's mic+webcam muxed together.
// "screen": a single participant's screen-share track.
export const callRecordingKinds = ["participant", "screen"] as const;

export type CallRecordingKind = (typeof callRecordingKinds)[number];

export const callRecordingStatuses = [
  "recording",
  "processing",
  "ready",
  "failed",
] as const;

export type CallRecordingStatus = (typeof callRecordingStatuses)[number];

export interface ICallRecording extends MongoDoc {
  room: ICallRoom;
  participant?: ICallParticipant;
  startedBy: IUser;
  kind: CallRecordingKind;
  filePath?: string;
  format: string;
  status: CallRecordingStatus;
  startedAt: Date;
  endedAt?: Date;
  error?: string;
}

const CallRecordingSchema = new mongoose.Schema<
  ICallRecording,
  Model<ICallRecording>
>({
  room: { type: mongoose.Schema.ObjectId, ref: "VoiceRoom", required: true },
  participant: { type: mongoose.Schema.ObjectId, ref: "CallParticipant" },
  startedBy: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  kind: { type: String, enum: callRecordingKinds, default: "participant" },
  filePath: { type: String },
  format: { type: String, default: "webm" },
  status: {
    type: String,
    enum: callRecordingStatuses,
    default: "recording",
  },
  startedAt: { type: Date, default: () => new Date() },
  endedAt: { type: Date },
  error: { type: String },
});

CallRecordingSchema.index({ room: 1 });

const CallRecording = mongoose.model("CallRecording", CallRecordingSchema);

export default CallRecording;
