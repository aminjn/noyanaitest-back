import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

export const callTypes = ["voice", "video"] as const;

export type CallType = (typeof callTypes)[number];

export interface ICallRoom extends MongoDoc {
  startedAt: Date;
  endedAt: Date;
  participants: IUser[];
  joined: IUser[];
  callType: CallType;
}

const CallRoomSchema = new mongoose.Schema<ICallRoom, Model<ICallRoom>>({
  startedAt: { type: Date, default: () => new Date() },
  endedAt: { type: Date },
  participants: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "User", required: true }],
    default: [],
  },
  joined: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "User", required: true }],
    default: [],
  },
  callType: { type: String, enum: callTypes, required: true },
});

const CallRoom = mongoose.model("VoiceRoom", CallRoomSchema);

export default CallRoom;
