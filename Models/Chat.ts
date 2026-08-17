import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IMessage } from "./Message";
import { IReservation } from "./Reservation";

export interface IChat extends MongoDoc {
  participants: IUser[];
  createdAt: Date;
  messages: IMessage[];
  opensAt: Date;
  closedAt?: Date;
  // set when this chat was opened for a booked session, by the reservation
  // activation cron
  reservation?: IReservation;
}

const ChatSchema = new mongoose.Schema<IChat, Model<IChat>>(
  {
    participants: [
      { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    ],
    createdAt: { type: Date, default: () => new Date() },
    opensAt: { type: Date, required: true },
    closedAt: { type: Date },
    reservation: { type: mongoose.Schema.ObjectId, ref: "Reservation" },
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
