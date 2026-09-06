import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

// Every entry here is one event a staff account (role !== "user", e.g.
// "admin"/"notadmin") can be notified about. Adding a new event to this
// array is the only change needed to get a `pushNotificationOn<Event>` and
// a `sendSMSOn<Event>` boolean field added to the UserAlert schema below -
// no other edits required.
export const userAlertEvents = ["newTicket", "newWithdrawalRequest"] as const;

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
