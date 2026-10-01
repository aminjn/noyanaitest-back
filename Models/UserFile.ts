import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IChat } from "./Chat";

// "Order": a lab's result for one test line (2026-10); `readers` are the
// buyer, the lab's owner and whoever uploaded it
export const userFilePaths = ["Chat", "PatientProfileRecord", "Order"] as const;

export type UserFilePath = (typeof userFilePaths)[number];

export interface IUserFile extends MongoDoc {
  chat?: IChat;
  chatPath: UserFilePath;
  readers?: IUser[];
  file: string;
  createdAt: Date;
}

const UserFileSchema = new mongoose.Schema<IUserFile, Model<IUserFile>>({
  chat: { type: mongoose.Schema.ObjectId, refPath: "chatPath" },
  chatPath: { type: String, enum: userFilePaths, default: "Chat" },
  readers: {
    type: [{ type: mongoose.Schema.ObjectId, ref: "User", required: true }],
    default: [],
  },
  file: { type: String, required: true },
  createdAt: { type: Date, default: () => new Date() },
});

const UserFile = mongoose.model("UserFile", UserFileSchema);

export default UserFile;
