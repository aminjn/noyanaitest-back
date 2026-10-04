import UserAlert, {
  UserAlertEvent,
  UserAlertSmsVariables,
  userAlertToggleFieldNames,
  smsPatternNameForEvent,
} from "../Models/UserAlert";
import { IUser } from "../Models/User";
import { sendSMS } from "../Lib/sendSms";
import { sendPushToUser } from "./pushNotificationService";
import { siteDefaultLocale } from "../Lib/locales";
import UserAccessLevel from "../Models/UserAccessLevel";
import { AccessLevelModel } from "../Models/AccessLevel";

// The access level a staff member (notadmin) needs to receive an event:
// the right to read the queue it lands in. Alerts carry requesters' phone
// numbers, so a blog editor subscribed by mistake must not get withdrawal
// or dispute alerts (2026-10). Full admins get every event they opted in to.
const eventAccess: Record<UserAlertEvent, AccessLevelModel> = {
  newTicket: "Ticket",
  newWithdrawalRequest: "Finance",
  newBecomeDoctorRequest: "BecomeDoctorRequest",
  newBecomePharmacyRequest: "BecomePharmacyRequest",
  newBecomeClinicRequest: "BecomeClinicRequest",
  newBecomeParaClinicRequest: "BecomeParaClinicRequest",
  newBecomeHospitalRequest: "BecomeHospitalRequest",
  newBecomeInsuranceRequest: "BecomeInsuranceRequest",
  newClinicAdditionRequest: "ClinicAdditionRequest",
  newPharmacyAdditionRequest: "PharmacyAdditionRequest",
  newHospitalAdditionRequest: "HospitalAdditionRequest",
  newInsuranceAdditionRequest: "InsuranceAdditionRequest",
  newVisitDispute: "Reservation",
  newSmsCampaign: "Advertisement",
};

const staffMayReceive = async (user: IUser, event: UserAlertEvent) => {
  if (!["admin", "notadmin"].includes(user.role)) return false;
  // a suspended or closed account gets nothing
  if (user.status && user.status !== "active") return false;
  if (user.role === "admin") return true;
  const access = await UserAccessLevel.findOne({ user: user._id }).populate("accessLevel");
  const level = access?.accessLevel as unknown as
    | Record<string, Record<string, boolean> | undefined>
    | undefined;
  return !!level?.[eventAccess[event]]?.readAll;
};

// For the push/in-app Notification channel only - generic on purpose,
// since push isn't constrained by a gateway-configured pattern the way SMS
// is. See UserAlertSmsVariables (Models/UserAlert.ts) for the SMS side,
// which is NOT this shape - each event has its own specific fields there.
export type UserAlertNotificationContent = {
  title: string;
  message: string;
  link?: string;
};

// Looks up every staff account (UserAlert doc, i.e. role !== "user") that
// opted in to `event` via push and/or SMS, and fires off whichever
// channel(s) it enabled - push through pushNotificationService.sendPushToUser
// (generic `push` content), SMS through Lib/sendSms.sendSMS, passing
// `event`'s own dedicated pattern name (smsPatternNameForEvent - e.g.
// "newTicket" -> "NEW_TICKET_PATTERN") and `smsVariables` - the exact
// {placeholder} values that pattern's fixed text needs (2026-09
// correction: this used to send the same generic {title,message} as the
// push channel, but a gateway pattern is fixed text with its own specific
// variable names configured on the provider's own panel - not a title/
// message pair - so every event now supplies only the fields meaningful to
// it: a document id for a link, a name, a phone, ...). Every event gets its
// own pattern on purpose (an earlier, separate audit finding: this used to
// hardcode the single generic "STAFF_ALERT_PATTERN" for every event) -
// sendSMS still just resolves whichever pattern code the admin configured
// from the DB-backed SmsPatterns singleton itself. Best-effort/fire-and-
// forget by design (mirrors Models/Notification.ts and
// Models/TicketMessage.ts): a delivery failure here must never fail or slow
// down the write that triggered it, so callers should not await this from a
// request handler's critical path.
export const notifyUserAlertSubscribers = async <E extends UserAlertEvent>(
  event: E,
  push: UserAlertNotificationContent,
  smsVariables: UserAlertSmsVariables[E],
): Promise<void> => {
  const { pushField, smsField } = userAlertToggleFieldNames(event);

  const subscribers = await UserAlert.find({
    $or: [{ [pushField]: true }, { [smsField]: true }],
  }).populate("user");

  await Promise.all(
    subscribers.map(async (subscriber) => {
      const user = subscriber.user as unknown as IUser | undefined;
      // staff alerts carry requesters' phone numbers: only current, active
      // staff who may open that queue get them (a demoted or suspended
      // admin's old subscription is ignored)
      if (!user || !(await staffMayReceive(user, event))) return;
      const flags = subscriber as unknown as Record<string, boolean>;

      const tasks: Promise<unknown>[] = [];

      if (flags[pushField]) {
        tasks.push(
          sendPushToUser(user._id, {
            title: push.title,
            message: push.message,
            link: push.link,
          }, { locale: siteDefaultLocale() }).catch((err) =>
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
            smsVariables,
            smsPatternNameForEvent(event),
            { locale: siteDefaultLocale() },
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
