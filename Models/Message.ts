import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IChat } from "./Chat";
import { IUserFile } from "./UserFile";

export interface IMessage extends MongoDoc {
  chat: IChat;
  sender: IUser;
  message?: string;
  file?: IUserFile;
  createdAt: Date;
  readBy: IUser[];
}

const MessageSchema = new mongoose.Schema<IMessage, Model<IMessage>>({
  chat: { type: mongoose.Schema.ObjectId, ref: "Chat", required: true },
  sender: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  message: { type: String },
  file: { type: mongoose.Schema.ObjectId, ref: "UserFile" },
  createdAt: { type: Date, default: () => new Date() },
  readBy: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "User", required: true }],
    default: [],
  },
});

const Message = mongoose.model("Message", MessageSchema);

export default Message;
