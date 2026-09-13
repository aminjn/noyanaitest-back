import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import {
  SmsPatternNameFor,
  smsPatternNameForEvent,
} from "../Lib/smsPatternName";

// Re-exported so existing importers (Models/SmsPatterns.ts,
// Services/userAlertService.ts) don't need to change their import path -
// the actual derivation now lives in Lib/smsPatternName.ts, shared with
// Models/Reservation.ts's reservationSmsEvents.
export type { SmsPatternNameFor };
export { smsPatternNameForEvent };

// Every entry here is one event a staff account (role !== "user", e.g.
// "admin"/"notadmin") can be notified about. Adding a new event to this
// array is the only change needed to get a `pushNotificationOn<Event>` and
// a `sendSMSOn<Event>` boolean field added to the UserAlert schema below -
// no other edits required on this model. Two other places intentionally
// mirror this list by hand rather than importing it (front and back are
// separate packages): Components/Admin/UserAlert/AdminManageUserAlertsPage.tsx
// (front-end labels/toggles) and Models/SmsPatterns.ts (derives one SMS
// pattern field per event below - see smsPatternNameForEvent). Every event
// here gets its OWN sms pattern; per-event SMS copy must never be collapsed
// back onto a single shared/generic pattern (2026-09 audit finding - staff
// alerts used to all share one "STAFF_ALERT_PATTERN").
export const userAlertEvents = [
  // Support ticket created or replied to - Controllers/supportController.ts.
  "newTicket",
  // Wallet withdrawal request - no withdrawal feature/model exists in the
  // backend yet, so this event is defined but never actually triggered.
  // Kept so the toggle (and its SMS pattern) already exists once that
  // feature ships.
  "newWithdrawalRequest",
  // "Become an org" requests - one per org type, each submitted by a plain
  // user. See Controllers/{doctor,pharmacy,clinic,paraClinic,hospital,
  // InsuracneController}.ts's become* handlers.
  "newBecomeDoctorRequest",
  "newBecomePharmacyRequest",
  "newBecomeClinicRequest",
  "newBecomeParaClinicRequest",
  "newBecomeHospitalRequest",
  "newBecomeInsuranceRequest",
  // "Addition request" - a doctor asking to add a clinic/hospital/pharmacy/
  // insurance that isn't in the system yet. All four are submitted from
  // Controllers/doctorController.ts's submit*AdditionRequest handlers.
  "newClinicAdditionRequest",
  "newPharmacyAdditionRequest",
  "newHospitalAdditionRequest",
  "newInsuranceAdditionRequest",
] as const;

export type UserAlertEvent = (typeof userAlertEvents)[number];

const capitalize = <T extends string>(value: T) =>
  (value.charAt(0).toUpperCase() + value.slice(1)) as Capitalize<T>;

type UserAlertToggleFields = {
  [K in UserAlertEvent as `pushNotificationOn${Capitalize<K>}`]: boolean;
} & {
  [K in UserAlertEvent as `sendSMSOn${Capitalize<K>}`]: boolean;
};

// Single source of truth for the field-name convention above (rather than
// every caller re-deriving `pushNotificationOn<Event>`/`sendSMSOn<Event>`
// itself) - see Services/userAlertService.ts, which uses this to look up
// and read the right pair of fields for a given event.
export const userAlertToggleFieldNames = (
  event: UserAlertEvent,
): { pushField: string; smsField: string } => {
  const suffix = capitalize(event);
  return {
    pushField: `pushNotificationOn${suffix}`,
    smsField: `sendSMSOn${suffix}`,
  };
};

export interface IUserAlert extends MongoDoc, UserAlertToggleFields {
  // Meant only for non-"user" accounts (admin/notadmin) - the staff who
  // should be alerted about operational events like new tickets or
  // withdrawal requests, not regular users.
  user: IUser;
}

const toggleFields = {} as mongoose.SchemaDefinition<UserAlertToggleFields>;

for (const event of userAlertEvents) {
  const suffix = capitalize(event);
  (toggleFields as Record<string, unknown>)[`pushNotificationOn${suffix}`] = {
    type: Boolean,
    default: false,
  };
  (toggleFields as Record<string, unknown>)[`sendSMSOn${suffix}`] = {
    type: Boolean,
    default: false,
  };
}

const UserAlertSchema = new mongoose.Schema<IUserAlert, Model<IUserAlert>>({
  user: {
    type: mongoose.Schema.ObjectId,
    ref: "User",
    required: true,
    unique: true,
  },
  ...toggleFields,
});

const UserAlert = mongoose.model("UserAlert", UserAlertSchema);

export default UserAlert;
