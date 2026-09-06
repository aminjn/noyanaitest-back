import UserAlert, {
  UserAlertEvent,
  userAlertToggleFieldNames,
} from "../Models/UserAlert";
import { IUser } from "../Models/User";
import { sendSMS } from "../Lib/helpers";
import { sendPushToUser } from "./pushNotificationService";

export type UserAlertNotificationContent = {
  title: string;
  message: string;
  link?: string;
};

// Looks up every staff account (UserAlert doc, i.e. role !== "user") that
// opted in to `event` via push and/or SMS, and fires off whichever
// channel(s) it enabled - push through pushNotificationService.sendPushToUser,
// SMS through the Lib/helpers.sendSMS placeholder. Best-effort/fire-and-forget
// by design (mirrors Models/Notification.ts and Models/TicketMessage.ts): a
// delivery failure here must never fail or slow down the write that
// triggered it, so callers should not await this from a request handler's
// critical path.
export const notifyUserAlertSubscribers = async (
  event: UserAlertEvent,
  content: UserAlertNotificationContent,
): Promise<void> => {
  const { pushField, smsField } = userAlertToggleFieldNames(event);

  const subscribers = await UserAlert.find({
    $or: [{ [pushField]: true }, { [smsField]: true }],
  }).populate("user");

  await Promise.all(
    subscribers.map(async (subscriber) => {
      const user = subscriber.user as unknown as IUser | undefined;
      if (!user) return;
      const flags = subscriber as unknown as Record<string, boolean>;

      const tasks: Promise<unknown>[] = [];

      if (flags[pushField]) {
        tasks.push(
          sendPushToUser(user._id, {
            title: content.title,
            message: content.message,
            link: content.link,
          }).catch((err) =>
            console.log(
              `[userAlertService] failed to push-notify user ${user._id} for "${event}":`,
              err,
            ),
          ),
        );
      }

      if (flags[smsField]) {
        tasks.push(
          sendSMS(
            user.phone,
            { title: content.title, message: content.message },
            undefined,
          ).catch((err) =>
            console.log(
              `[userAlertService] failed to SMS user ${user._id} for "${event}":`,
              err,
            ),
          ),
        );
      }

      await Promise.all(tasks);
    }),
  );
};
