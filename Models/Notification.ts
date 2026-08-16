import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

// "System" = generated automatically by the app, "Admin" = manually created by an admin
export const notificationSources = ["System", "Admin"] as const;

export type NotificationSource = (typeof notificationSources)[number];

export interface INotification extends MongoDoc {
  user: IUser; // recipient
  title: string;
  message: string;
  source: NotificationSource;
  createdBy?: IUser; // admin who created it, when source === "Admin"
  link?: string; // optional in-app path to navigate to on click
  isRead: boolean;
  readAt?: Date;
  createdAt: Date;
  markAsRead: () => Promise<void>;
}

const NotificationSchema = new mongoose.Schema<
  INotification,
  Model<INotification>
>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  source: { type: String, enum: notificationSources, default: "System" },
  createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  link: { type: String },
  isRead: { type: Boolean, default: false },
  readAt: { type: Date },
  createdAt: { type: Date, default: () => new Date() },
});

NotificationSchema.index({ user: 1, createdAt: -1 });
NotificationSchema.index({ user: 1, isRead: 1 });

NotificationSchema.method("markAsRead", async function () {
  if (!this.isRead) {
    this.isRead = true;
    this.readAt = new Date();
    await this.save();
  }
});

const Notification = mongoose.model("Notification", NotificationSchema);

export default Notification;
