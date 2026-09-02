import webpush from "web-push";
import { Types } from "mongoose";
import * as env from "../Lib/Env";
import PushSubscription from "../Models/PushSubscription";

// Push is optional infrastructure (unlike JWT_SECRET, missing VAPID keys
// don't crash the app - see the comment in Lib/Env.ts). sendPushToUser()
// below just no-ops, with a single console warning, until they're set.
let isConfigured = false;
let hasWarnedMissingKeys = false;

if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
  );
  isConfigured = true;
}

export type PushPayload = {
  title: string;
  message: string;
  link?: string;
};

const isWebPushStatusError = (err: unknown): err is { statusCode: number } =>
  typeof err === "object" &&
  err !== null &&
  "statusCode" in err &&
  typeof (err as { statusCode: unknown }).statusCode === "number";

// Sends a browser push notification to every device the given user has
// subscribed from (see Models/PushSubscription.ts and the
// /user/push/subscribe route). This is called from Models/Notification.ts's
// post-save/post-insertMany hooks, so it fires automatically alongside
// every in-app "System"/"Admin" notification created anywhere in the app -
// nothing else needs to call this directly.
//
// Best-effort by design: a delivery failure for one (or every) subscription
// never throws back to the caller - the in-app Notification row is the
// source of truth, push is just a best-effort nudge on top of it.
export const sendPushToUser = async (
  userId: Types.ObjectId | string,
  payload: PushPayload,
): Promise<void> => {
  if (!isConfigured) {
    if (!hasWarnedMissingKeys) {
      hasWarnedMissingKeys = true;
      console.log(
        "[pushNotificationService] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set - skipping web push (in-app notifications are unaffected)",
      );
    }
    return;
  }

  const subscriptions = await PushSubscription.find({ user: userId });
  if (!subscriptions.length) return;

  const body = JSON.stringify({
    title: payload.title,
    message: payload.message,
    link: payload.link,
  });

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: subscription.keys },
          body,
        );
      } catch (err) {
        // 404/410 = the push service is telling us this subscription is
        // gone for good (browser/profile uninstalled, permission reset,
        // endpoint expired) - delete it so we stop trying. Anything else
        // (network blip, a transient 5xx) is just logged; the subscription
        // may still be good on the next notification.
        if (isWebPushStatusError(err) && (err.statusCode === 404 || err.statusCode === 410)) {
          await PushSubscription.deleteOne({ _id: subscription._id }).catch(
            () => undefined,
          );
        } else {
          console.log(
            `[pushNotificationService] failed to deliver push to subscription ${subscription._id}:`,
            err,
          );
        }
      }
    }),
  );
};
