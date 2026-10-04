import mongoose from "mongoose";
import PatientSubscription, { IPatientSubscription } from "../Models/PatientSubscription";
import LicenseExpiryNotice, { LicenseExpiryStage } from "../Models/LicenseExpiryNotice";
import { getProPlan } from "../Lib/patientPro";
import { notifyWithSms, smsDate } from "./notificationSmsService";

// «پرو» membership notices and expiry (2026-10): bought, ends in 7 days,
// ends in 1 day, ended - in-app plus the pro*User SMS patterns
// (Models/NotificationSms.ts), the same stages and idempotency record as
// the provider plans (Services/licenseExpiryService.ts, LicenseExpiryNotice
// with kind "patient"). A period followed by a renewal gets no reminder.

const DAY = 24 * 60 * 60 * 1000;
const EXPIRED_GRACE_MS = 3 * DAY;
const PANEL = "/dashboard/pro";

export const notifyProPurchased = (user: unknown, plan: string, expiresAt: Date): void => {
  const date = smsDate(expiresAt);
  notifyWithSms(
    "proPurchasedUser",
    user as mongoose.Types.ObjectId,
    { plan, expiresAt: date },
    {
      notification: {
        title: "اشتراک پرو شما فعال شد",
        message: `اشتراک «${plan}» تا ${date} فعال است.`,
        link: PANEL,
      },
    },
  );
};

const stageOf = (expiresAt: Date, now: Date): LicenseExpiryStage | null => {
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) return -left <= EXPIRED_GRACE_MS ? "expired" : null;
  if (left <= DAY) return "1d";
  if (left <= 7 * DAY) return "7d";
  return null;
};

// the user has another period that carries on after this one
const renewed = async (sub: IPatientSubscription) =>
  !!(await PatientSubscription.exists({
    user: sub.user,
    _id: { $ne: sub._id },
    status: "active",
    expiresAt: { $gt: new Date(sub.expiresAt).getTime() + 60 * 1000 },
  }));

const sendNotice = async (sub: IPatientSubscription, stage: LicenseExpiryStage, now: Date, plan: string) => {
  try {
    await LicenseExpiryNotice.create({ license: sub._id, kind: "patient", stage, expiresAt: sub.expiresAt });
  } catch {
    return false; // already sent
  }
  const date = smsDate(sub.expiresAt);
  if (stage === "expired") {
    notifyWithSms(
      "proExpiredUser",
      sub.user,
      { plan },
      {
        notification: {
          title: "اشتراک پرو شما به پایان رسید",
          message: `اشتراک «${plan}» به پایان رسید. برای استفاده‌ی دوباره از مزایای آن، اشتراک را تمدید کنید.`,
          link: PANEL,
        },
      },
    );
    return true;
  }
  const days = Math.max(1, Math.ceil((new Date(sub.expiresAt).getTime() - now.getTime()) / DAY));
  notifyWithSms(
    "proExpiringUser",
    sub.user,
    { plan, days: String(days), expiresAt: date },
    {
      notification: {
        title: "اشتراک پرو شما رو به پایان است",
        message: `اشتراک «${plan}» ${days} روز دیگر (${date}) به پایان می‌رسد. برای ادامه‌ی مزایا آن را تمدید کنید.`,
        link: PANEL,
      },
    },
  );
  return true;
};

// Hourly: ended periods become "expired" (the benefits already stopped at
// expiresAt - every check reads the dates); reminders 7 days and 1 day
// before the end, and the "ended" notice, once each.
export const runPatientProSweep = async (now = new Date()): Promise<{ expired: number; sent: number }> => {
  const plan = await getProPlan().catch(() => null);
  const planName = plan?.displayName || "پرو";
  let sent = 0;
  const due = await PatientSubscription.find({
    status: { $in: ["active", "expired"] },
    expiresAt: { $gte: new Date(now.getTime() - EXPIRED_GRACE_MS), $lte: new Date(now.getTime() + 7 * DAY) },
  })
    .limit(5000)
    .lean<IPatientSubscription[]>();
  for (const sub of Array.isArray(due) ? due : []) {
    if (!sub?.expiresAt) continue;
    const stage = stageOf(new Date(sub.expiresAt), now);
    if (!stage) continue;
    // a period bought in the last day gets no "ends soon" (a support grant
    // of a few days would be warned right after it)
    if (stage !== "expired" && sub.createdAt && now.getTime() - new Date(sub.createdAt).getTime() < DAY) continue;
    if (stage !== "expired" && sub.status !== "active") continue;
    try {
      if (await renewed(sub)) continue;
      if (await sendNotice(sub, stage, now, planName)) sent++;
    } catch (err) {
      console.log(`[patientPro] notice for ${String(sub._id)} failed:`, err);
    }
  }
  const res = await PatientSubscription.updateMany(
    { status: "active", expiresAt: { $lte: now } },
    { $set: { status: "expired" } },
  );
  return { expired: res.modifiedCount || 0, sent };
};

export const startPatientProJob = (intervalMs = 60 * 60 * 1000): void => {
  const run = () =>
    runPatientProSweep().catch((err) => console.log("[patientPro] sweep failed:", err));
  setTimeout(run, 90 * 1000).unref?.();
  setInterval(run, intervalMs).unref?.();
};
