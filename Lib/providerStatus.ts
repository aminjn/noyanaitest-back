import { Schema } from "mongoose";
import AppError from "./AppError";

// Provider suspension (2026-10 admin audit P2-9), distinct from draft.
//
// `active` (`isActive` on Hospital) stays what it always was: the provider's
// page is published or still a draft. `status` is the platform's decision:
// a suspended doctor / centre is taken off the site by an admin, with a
// reason the owner is told, until an admin lifts it. As on Doctolib Pro and
// Docplanner, a suspension hides the page and stops new bookings / orders;
// visits and orders already placed keep their own lifecycle.
//
// While suspended the publish flag is held at false, so every existing
// "active: true" query, $lookup and guard (public lists, search, profile
// pages, booking, cart) treats the provider as unpublished without each of
// them having to learn a second flag. The flag's value before the
// suspension is kept in `activeBeforeSuspension` and restored on
// reactivation, so a draft stays a draft.
//
// Only Controllers/adminProviderController.ts changes these fields (with a
// raw collection update); the hooks below strip them from every other
// update and refuse to publish a suspended provider.

export const providerStatuses = ["active", "suspended"] as const;
export type ProviderStatus = (typeof providerStatuses)[number];

export interface IProviderStatusFields {
  status?: ProviderStatus;
  statusReason?: string;
  statusChangedAt?: Date;
  activeBeforeSuspension?: boolean;
}

export const PROVIDER_STATUS_FIELDS = [
  "status",
  "statusReason",
  "statusChangedAt",
  "activeBeforeSuspension",
] as const;

export const SUSPENDED_PUBLISH_ERROR =
  "این حساب تعلیق شده است؛ برای فعال کردن، اول تعلیق را رفع کنید";

const truthy = (value: unknown) =>
  value === true || value === "true" || value === 1 || value === "1" || value === "on";

type UpdateDoc = Record<string, unknown>;

// removes the status fields from an update (top level and every operator)
const stripStatusFields = (update: UpdateDoc) => {
  for (const key of Object.keys(update)) {
    if ((PROVIDER_STATUS_FIELDS as readonly string[]).includes(key)) {
      delete update[key];
      continue;
    }
    const value = update[key];
    if (key.startsWith("$") && value && typeof value === "object" && !Array.isArray(value))
      for (const field of PROVIDER_STATUS_FIELDS) delete (value as UpdateDoc)[field];
  }
};

const setsPublished = (update: UpdateDoc, activeField: string) => {
  if (activeField in update && truthy(update[activeField])) return true;
  const set = update.$set as UpdateDoc | undefined;
  return !!set && activeField in set && truthy(set[activeField]);
};

export const providerStatusPlugin = (
  schema: Schema,
  options: { activeField: "active" | "isActive" },
) => {
  const { activeField } = options;
  schema.add({
    status: {
      type: String,
      enum: providerStatuses,
      default: "active",
      index: true,
    },
    statusReason: { type: String, maxlength: 1000 },
    statusChangedAt: { type: Date },
    activeBeforeSuspension: { type: Boolean },
  });

  schema.pre("save", function (next) {
    if (this.isNew) {
      // a record is never created suspended
      this.set("status", "active");
      this.set("statusReason", undefined);
      this.set("activeBeforeSuspension", undefined);
    } else if (PROVIDER_STATUS_FIELDS.some((field) => this.isModified(field))) {
      return next(new AppError("وضعیت تعلیق فقط از دکمه‌ی تعلیق / رفع تعلیق تغییر می‌کند", 400));
    }
    if (this.get("status") === "suspended" && this.get(activeField))
      return next(new AppError(SUSPENDED_PUBLISH_ERROR, 400));
    next();
  });

  for (const op of ["findOneAndUpdate", "updateOne"] as const)
    schema.pre(op, async function () {
      const update = this.getUpdate() as UpdateDoc | null;
      if (!update || Array.isArray(update)) return;
      stripStatusFields(update);
      this.setUpdate(update);
      if (!setsPublished(update, activeField)) return;
      const suspended = await this.model.exists({
        ...this.getFilter(),
        status: "suspended",
      });
      if (suspended) throw new AppError(SUSPENDED_PUBLISH_ERROR, 400);
    });

  schema.pre("updateMany", function () {
    const update = this.getUpdate() as UpdateDoc | null;
    if (!update || Array.isArray(update)) return;
    stripStatusFields(update);
    this.setUpdate(update);
    // a bulk publish skips the suspended ones
    if (setsPublished(update, activeField))
      this.where({ status: { $ne: "suspended" } });
  });
};
