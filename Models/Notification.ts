import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { sendPushToUser } from "../Services/pushNotificationService";

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

// Every "System"/"Admin" notification created anywhere in the app (admin
// panel broadcasts, reservation sweeps, ticket replies, ...) should also
// try to reach the user as a browser push - this is the one place that
// wires that up, so callers just create/insertMany a Notification like
// before and don't need to know push exists. Fire-and-forget: push
// delivery is best-effort and must never fail (or slow down) the write
// that's actually persisting the notification.
NotificationSchema.pre("save", function (next) {
  this.$locals.isNewNotification = this.isNew;
  next();
});

NotificationSchema.post("save", function (doc) {
  if (!doc.$locals.isNewNotification) return;
  sendPushToUser(doc.user as unknown as mongoose.Types.ObjectId, {
    title: doc.title,
    message: doc.message,
    link: doc.link,
  }).catch((err) =>
    console.log(
      `[Notification] failed to push-notify user for notification ${doc._id}:`,
      err,
    ),
  );
});

NotificationSchema.post("insertMany", function (docs: INotification[]) {
  for (const doc of docs) {
    sendPushToUser(doc.user as unknown as mongoose.Types.ObjectId, {
      title: doc.title,
      message: doc.message,
      link: doc.link,
    }).catch((err) =>
      console.log(
        `[Notification] failed to push-notify user for notification ${doc._id}:`,
        err,
      ),
    );
  }
});

const Notification = mongoose.model("Notification", NotificationSchema);

export default Notification;
