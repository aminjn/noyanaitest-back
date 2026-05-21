import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "../User";

export interface IBotChat extends MongoDoc {
  user: IUser;
  name: string;
  createdAt: Date;
}

const BotChatSchema = new mongoose.Schema<IBotChat, Model<IBotChat>>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  name: { type: String, default: "New Chat" },
  createdAt: { type: Date, default: () => new Date() },
});

const BotChat = mongoose.model("BotChat", BotChatSchema);

export default BotChat;
