import moment from "moment-jalaali";
import { tehranMoment } from "../Lib/tehranTime";
import mongoose from "mongoose";
import User from "../Models/User";
import Notification from "../Models/Notification";
import Reservation from "../Models/Reservation";
import {
  NotificationSmsEvent,
  NotificationSmsVariables,
} from "../Models/NotificationSms";
import { smsPatternNameForEvent } from "../Lib/smsPatternName";
import { sendSMS, smsPatternSendLocale } from "../Lib/sendSms";
import { isLocale, Locale, siteDefaultLocale } from "../Lib/locales";
import { translateNotificationText } from "../Lib/i18n/translateNotification";

// One call for "tell this person": an optional in-app / push Notification
// plus the event's own IPPanel pattern SMS (Models/NotificationSms.ts).
// Any feature that adds a user- or provider-facing event (prescriptions,
// reviews, AI content, ...) should add its event to notificationSmsEvents
// and call this instead of hand-rolling Notification.create + sendSMS.
//
// Never throws and never blocks the caller's own work: every failure is
// logged and swallowed. With no pattern code set for the event the SMS is
// skipped (SmsLog records it as "skipped"), the in-app notice still goes.

type Recipient =
  | mongoose.Types.ObjectId
  | string
  | { _id?: unknown; phone?: string; locale?: string; status?: string }
  | null
  | undefined;

type InAppNotice = { title: string; message: string; link?: string };

export type NotifyWithSmsOptions = {
  // also create this in-app notification (pushed by Models/Notification.ts)
  notification?: InAppNotice;
  // send the SMS to this number instead of the account's (a patient who is
  // a relative of the booker, an invitee with no account yet)
  phone?: string;
  // the same key inside DEDUPE_MS sends the SMS once (e.g. one SMS per order
  // when several of its items are cancelled in one go). In-app is not
  // deduplicated.
  once?: string;
};

// IPPanel substitutes variables into a fixed text; very long values (an
// admin's reason) would make a multi-part SMS - clip them.
const MAX_VARIABLE_LENGTH = 120;
// variables whose value can be a Persian catalog word (an org kind such as
// «کلینیک», or «کلینیک مهر») - translated into the pattern's language
const TRANSLATED_VARIABLES = new Set(["kind", "centre", "title"]);

const DEDUPE_MS = 10 * 60 * 1000;
const recentlySent = new Map<string, number>();

const claimOnce = (key: string): boolean => {
  const now = Date.now();
  for (const [k, at] of recentlySent) if (now - at > DEDUPE_MS) recentlySent.delete(k);
  if (recentlySent.has(key)) return false;
  recentlySent.set(key, now);
  return true;
};

const idOf = (recipient: Recipient): string | undefined => {
  if (!recipient) return undefined;
  if (typeof recipient === "string") return recipient;
  if (recipient instanceof mongoose.Types.ObjectId) return recipient.toString();
  const id = (recipient as { _id?: unknown })._id;
  return id ? String(id) : undefined;
};

const resolveUser = async (
  recipient: Recipient,
): Promise<{ id?: string; phone?: string; locale?: string; status?: string }> => {
  const id = idOf(recipient);
  // a populated user (lean or a document) may already carry what is needed
  const obj =
    recipient && typeof recipient === "object" && !(recipient instanceof mongoose.Types.ObjectId)
      ? (recipient as { phone?: unknown; locale?: unknown; status?: unknown })
      : {};
  const given = {
    phone: typeof obj.phone === "string" ? obj.phone : undefined,
    locale: typeof obj.locale === "string" ? obj.locale : undefined,
    status: typeof obj.status === "string" ? obj.status : undefined,
  };
  if (given.phone && given.locale && given.status) return { id, ...given };
  if (!id || !mongoose.isValidObjectId(id)) return { id, ...given };
  const user = await User.findById(id)
    .select("phone locale status")
    .lean<{ phone?: string; locale?: string; status?: string }>();
  return {
    id,
    phone: given.phone || user?.phone,
    locale: given.locale || user?.locale,
    status: given.status || user?.status,
  };
};

const clip = (value: string) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > MAX_VARIABLE_LENGTH ? `${text.slice(0, MAX_VARIABLE_LENGTH - 1)}…` : text;
};

export const notifyWithSms = async <E extends NotificationSmsEvent>(
  event: E,
  recipient: Recipient,
  variables: NotificationSmsVariables[E],
  options: NotifyWithSmsOptions = {},
): Promise<void> => {
  try {
    const user = await resolveUser(recipient);
    if (options.notification && user.id)
      await Notification.create({
        user: user.id,
        source: "System",
        title: options.notification.title,
        message: options.notification.message,
        ...(options.notification.link ? { link: options.notification.link } : {}),
      }).catch((err) => console.log(`[notifyWithSms] in-app ${event} failed:`, err));

    const phone = options.phone || user.phone;
    // a closed account keeps no phone worth texting
    if (!phone || user.status === "deleted") return;
    if (options.once && !claimOnce(`${event}:${options.once}`)) return;

    const patternName = smsPatternNameForEvent(event);
    const preferred: Locale = isLocale(user.locale) ? user.locale : siteDefaultLocale();
    const sendLocale = (await smsPatternSendLocale(patternName, preferred)) ?? preferred;
    const params: Record<string, string> = {};
    for (const [key, raw] of Object.entries(variables as Record<string, string>)) {
      const value = clip(raw);
      params[key] = TRANSLATED_VARIABLES.has(key)
        ? translateNotificationText(value, sendLocale)
        : value;
    }
    await sendSMS(phone, params, patternName, { locale: sendLocale });
  } catch (err) {
    console.log(`[notifyWithSms] ${event} failed:`, err);
  }
};

// ------------------------------------------------------------ formatting
// The plain strings pattern variables carry (see NotificationSmsVariables).

export const smsAmount = (amount: number | undefined | null): string =>
  String(Math.max(0, Math.round(Number(amount) || 0)));

export const smsDate = (date: Date | string | undefined | null): string =>
  date ? tehranMoment(date).format("jYYYY/jMM/jDD") : "";

export const smsTime = (minutesFromMidnight: number | undefined | null): string => {
  const m = Math.max(0, Number(minutesFromMidnight) || 0);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

// ---------------------------------------------------------- reservations

export type ReservationSmsContext = {
  reservationId: string;
  date: string;
  time: string;
  doctorName: string;
  patientName: string;
  // the doctor's account
  doctorUser?: string;
  // whoever booked (and paid): refunds go to their wallet
  bookerUser?: string;
  // the person being visited: their own account when linked, else the booker
  patientUser?: string;
  // the visited person's phone (own account, identity, else the booker's) -
  // same rule as Services/reservationSmsService.ts
  patientPhone?: string;
};

// Loads what reservation SMS need, whatever the caller had populated.
export const reservationSmsContext = async (
  reservationId: unknown,
): Promise<ReservationSmsContext | null> => {
  if (!reservationId || !mongoose.isValidObjectId(String(reservationId))) return null;
  const r = await Reservation.findById(String(reservationId))
    .select("date start user patient doctor")
    .populate([
      { path: "user", select: "phone" },
      { path: "doctor", select: "firstName lastName user" },
      { path: "patient", select: "givenName lastName user phones", populate: { path: "user", select: "phone" } },
    ])
    .lean<any>();
  if (!r) return null;
  const patientAccount = r.patient?.user;
  return {
    reservationId: String(r._id),
    date: smsDate(r.date),
    time: smsTime(r.start),
    doctorName: `${r.doctor?.firstName || ""} ${r.doctor?.lastName || ""}`.trim(),
    patientName: `${r.patient?.givenName || ""} ${r.patient?.lastName || ""}`.trim(),
    doctorUser: r.doctor?.user ? String(r.doctor.user) : undefined,
    bookerUser: r.user?._id ? String(r.user._id) : r.user ? String(r.user) : undefined,
    patientUser: patientAccount?._id
      ? String(patientAccount._id)
      : r.user?._id
        ? String(r.user._id)
        : undefined,
    patientPhone: patientAccount?.phone || r.patient?.phones?.[0] || r.user?.phone,
  };
};
