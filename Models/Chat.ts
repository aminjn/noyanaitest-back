import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IMessage } from "./Message";

export interface IChat extends MongoDoc {
  participants: IUser[];
  createdAt: Date;
  messages: IMessage[];
  opensAt: Date;
  closedAt?: Date;
}

const ChatSchema = new mongoose.Schema<IChat, Model<IChat>>(
  {
    participants: [
      { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    ],
    createdAt: { type: Date, default: () => new Date() },
    opensAt: { type: Date, required: true },
    closedAt: { type: Date },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

ChatSchema.virtual("messages", {
  ref: "Message",
  localField: "_id",
  foreignField: "chat",
});

const Chat = mongoose.model("Chat", ChatSchema);

export default Chat;
