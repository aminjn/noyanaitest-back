import { fromTehranWallClock, tehranYmd } from "./tehranTime";

// The dates of a centre's operating licence as the applicant gives them on
// the become-request (2026-10, owner decision) and as the approval copies
// them onto the centre's `licence` (Models/CentreLicence.ts). Days are
// Tehran days (the form's Jalali picker sends the picked day's Tehran
// noon); a licence is valid through its expiry day, so on the centre the
// expiry is that day's 23:59 Tehran (same as the admin licence endpoint).

const validDate = (value: unknown): Date | null => {
  if (value === undefined || value === null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
};

// the day as stored on a request: its Tehran noon
export const requestLicenceDay = (value: unknown): Date | null => {
  const d = validDate(value);
  return d ? fromTehranWallClock(tehranYmd(d), 12 * 60) : null;
};

// the instant the licence ends on the centre
export const licenceExpiryInstant = (value: unknown): Date | null => {
  const d = validDate(value);
  return d ? fromTehranWallClock(tehranYmd(d), 23 * 60 + 59) : null;
};

// null when the dates are fine, else the Persian error (translated by
// Lib/i18n/errorMessages.ts). The expiry is required and must be a later
// Tehran day than today; the issue date (when given) can't be in the
// future and must be before the expiry.
export const licenceDatesProblem = (issuedAt: unknown, expiresAt: unknown, now = new Date()): string | null => {
  const expires = validDate(expiresAt);
  if (!expires) return "تاریخ انقضای پروانه را وارد کنید";
  const today = tehranYmd(now);
  if (tehranYmd(expires) <= today) return "تاریخ انقضای پروانه باید در آینده باشد";
  const issued = validDate(issuedAt);
  if (issued) {
    if (tehranYmd(issued) > today) return "تاریخ صدور پروانه نمی‌تواند در آینده باشد";
    if (tehranYmd(issued) >= tehranYmd(expires)) return "تاریخ انقضای پروانه باید پس از تاریخ صدور آن باشد";
  }
  return null;
};
