import mongoose, { Model } from "mongoose";
import { MongoDoc } from "../User";
import { IBotChat } from "./BotChat";

export const botChatMessageRoles = ["user", "assistant"] as const;

export type BotChatMessageRole = (typeof botChatMessageRoles)[number];

export interface IBotChatMessage extends MongoDoc {
  chat: IBotChat;
  content: string;
  role: BotChatMessageRole;
  createdAt: Date;
}

const BotChatMessageSchema = new mongoose.Schema<
  IBotChatMessage,
  Model<IBotChatMessage>
>({
  chat: { type: mongoose.Schema.ObjectId, ref: "BotChat", required: true },
  content: { type: String },
  role: { type: String, required: true, enum: botChatMessageRoles },
  createdAt: { type: Date, default: () => new Date() },
});

const BotChatMessage = mongoose.model("BotChatMessage", BotChatMessageSchema);

export default BotChatMessage;
