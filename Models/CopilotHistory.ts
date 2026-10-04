import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// The short per-user history of the panel copilot «دستیار نویان»
// (2026-10, Lib/ai/copilot.ts): the last few requests and answers, per
// panel and per organisation the user works in (a secretary of two doctors
// keeps two histories). Only the text and the chosen tool are kept - never
// audio, never the data a tool read.
export interface ICopilotHistoryItem {
  role: "user" | "assistant";
  text: string;
  tool?: string;
  at: Date;
}

export interface ICopilotHistory extends MongoDoc {
  user: mongoose.Types.ObjectId;
  panel: string;
  org: mongoose.Types.ObjectId;
  items: ICopilotHistoryItem[];
  updatedAt: Date;
}

export const COPILOT_HISTORY_MAX = 20;

const CopilotHistorySchema = new mongoose.Schema<ICopilotHistory, Model<ICopilotHistory>>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  panel: { type: String, required: true },
  org: { type: mongoose.Schema.ObjectId, required: true },
  items: {
    type: [
      {
        _id: false,
        role: { type: String, enum: ["user", "assistant"], required: true },
        text: { type: String, maxlength: 2000 },
        tool: { type: String, maxlength: 60 },
        at: { type: Date, default: () => new Date() },
      },
    ],
    default: [],
  },
  updatedAt: { type: Date, default: () => new Date() },
});

CopilotHistorySchema.index({ user: 1, panel: 1, org: 1 }, { unique: true });
// a history nobody touched for two months goes
CopilotHistorySchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });

const CopilotHistory = mongoose.model("CopilotHistory", CopilotHistorySchema);

export default CopilotHistory;
