import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

// One document per browser/device the user has granted push permission on
// (a user can have several - phone + desktop, multiple browsers, ...).
// Mirrors the PushSubscriptionJSON shape returned by the browser's
// PushManager.subscribe(), which is what Services/pushNotificationService.ts
// hands straight to web-push's sendNotification().
export interface IPushSubscription extends MongoDoc {
  user: IUser;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
  createdAt: Date;
}

const PushSubscriptionSchema = new mongoose.Schema<
  IPushSubscription,
  Model<IPushSubscription>
>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
  userAgent: { type: String },
  createdAt: { type: Date, default: () => new Date() },
});

PushSubscriptionSchema.index({ user: 1 });

const PushSubscription = mongoose.model(
  "PushSubscription",
  PushSubscriptionSchema,
);

export default PushSubscription;
