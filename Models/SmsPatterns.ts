import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { userAlertEvents, UserAlertEvent } from "./UserAlert";
import { reservationSmsEvents, ReservationSmsEvent } from "./Reservation";
import { orderSmsEvents, OrderSmsEvent } from "./Order";
import {
  notificationSmsEvents,
  NotificationSmsEvent,
} from "./NotificationSms";
import { smsPatternNameForEvent, SmsPatternNameFor } from "../Lib/smsPatternName";

// Every entry here is the name of an env var that holds one IPPanel pattern
// code sent through Lib/sendSms.ts (see sendSmsRaw's `code: pattern`
// field) - admins create the matching pattern on the gateway's own
// dashboard and paste its code/id into the admin panel. Field keys on this
// model are the env var names themselves (not a camelCase rename), each
// defaulting to that same env var's value if it's set, so a deployment
// that already has e.g. OTP_PATTERN configured keeps working unchanged
// the first time this collection is created.
//
// One pattern per UserAlertEvent (staff alerts), per ReservationSmsEvent
// (direct-to-doctor/patient reservation SMS), and per OrderSmsEvent
// (direct-to-buyer/seller order SMS), derived via smsPatternNameForEvent
// (e.g. "newBecomeDoctorRequest" -> "NEW_BECOME_DOCTOR_REQUEST_PATTERN"),
// plus the fixed OTP_PATTERN below. This is deliberately *derived* from
// Models/UserAlert.ts's userAlertEvents, Models/Reservation.ts's
// reservationSmsEvents, and Models/Order.ts's orderSmsEvents rather than
// hand-listed (2026-09 audit finding: every staff-alert event used to
// share one generic "STAFF_ALERT_PATTERN", which meant e.g. a new-ticket
// SMS and a new-become-organization-request SMS were indistinguishable and
// couldn't carry event-specific copy). Adding an event to any of the three
// lists is the only change needed to get its own field added to the
// SmsPatterns schema below - no other edits required here.
export const smsPatternNames = [
  // Verification code, sent with a single `OTP` variable -
  // Controllers/authController.ts (login + signup flows).
  "OTP_PATTERN",
  // Secretary invite (2026-09) - Controllers/aclController.ts
  // submitASecretaryRequest, variable `owner` (the inviting doctor/center).
  // Left empty = no SMS, the invite still shows in-app.
  "SECRETARY_INVITE_PATTERN",
  // A provider's invoice link to its patient (2026-10,
  // Lib/business/invoices.ts smsInvoice), variables `center`, `amount`
  // (toman) and `link`. Left empty = no SMS, the link is still copyable.
  "INVOICE_LINK_PATTERN",
  // A treatment plan or contract link to its patient or company (2026-10,
  // Lib/business/crmSales.ts), variables `center`, `title` and `link`.
  // Left empty = no SMS, the link is still copyable.
  "CRM_DOC_LINK_PATTERN",
  ...userAlertEvents.map((event) => smsPatternNameForEvent(event)),
  ...reservationSmsEvents.map((event) => smsPatternNameForEvent(event)),
  ...orderSmsEvents.map((event) => smsPatternNameForEvent(event)),
  // Patient / provider notifications (2026-10) - Models/NotificationSms.ts,
  // sent by Services/notificationSmsService.ts's notifyWithSms.
  ...notificationSmsEvents.map((event) => smsPatternNameForEvent(event)),
] as const;

export type SmsPatternName =
  | "OTP_PATTERN"
  | "SECRETARY_INVITE_PATTERN"
  | "INVOICE_LINK_PATTERN"
  | "CRM_DOC_LINK_PATTERN"
  | SmsPatternNameFor<UserAlertEvent>
  | SmsPatternNameFor<ReservationSmsEvent>
  | SmsPatternNameFor<OrderSmsEvent>
  | SmsPatternNameFor<NotificationSmsEvent>;

type SmsPatternFields = {
  [K in SmsPatternName]: string;
};

// Singleton document holding the pattern codes above. Mirrors
// Models/AppConfig.ts's / Models/GlobalFinanceSettings.ts's singleton
// pattern. Admin-managed via Routers/autoRouter.ts (registered with
// `singleton: true`). Application code sending an SMS should never import
// this model directly - go through Lib/sendSms.ts's sendSmsRaw/sendSMS,
// which resolve a pattern code from this singleton internally given just
// a SmsPatternName.
export interface ISmsPatterns extends MongoDoc, SmsPatternFields {
  singleton: "SINGLETON";
  // per-language pattern codes: { OTP_PATTERN: { en: "abc123" }, ... }. A
  // gateway pattern is fixed text, so each language needs its own pattern
  // on the provider's panel. A language with no code here uses the base
  // code above (Lib/sendSms.ts).
  localized?: Partial<Record<SmsPatternName, Partial<Record<string, string>>>>;
}

const patternFields = {} as mongoose.SchemaDefinition<SmsPatternFields>;

for (const name of smsPatternNames) {
  (patternFields as Record<string, unknown>)[name] = {
    type: String,
    // Evaluated per-document (only actually matters on the one insert this
    // singleton ever gets) rather than read once at module-load time, so
    // it still picks up the env var if it's set later but before the
    // singleton document has been created.
    default: () => process.env[name] || "",
  };
}

const SmsPatternsSchema = new mongoose.Schema<
  ISmsPatterns,
  Model<ISmsPatterns>
>({
  singleton: {
    type: String,
    required: true,
    default: "SINGLETON",
    enum: ["SINGLETON"],
    immutable: true,
    unique: true,
  },
  ...patternFields,
  localized: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
});

const SmsPatterns = mongoose.model("SmsPatterns", SmsPatternsSchema);

export default SmsPatterns;
