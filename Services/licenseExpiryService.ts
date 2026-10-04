import mongoose, { Model } from "mongoose";
import DoctorProfileLicense from "../Models/DoctorProfileLicense";
import ClinicProfileLicense from "../Models/ClinicProfileLicense";
import HospitalProfileLicense from "../Models/HospitalProfileLicense";
import PharmacyProfileLicense from "../Models/PharmacyProfileLicense";
import ParaClinicProfileLicense from "../Models/ParaClinicProfileLicense";
import InsuranceProfileLicense from "../Models/InsuranceProfileLicense";
import LicenseExpiryNotice, { LicenseExpiryStage } from "../Models/LicenseExpiryNotice";
import { notifyWithSms, smsDate } from "./notificationSmsService";

// Provider plan (licence) notices (2026-10): bought, ends in 7 days, ends in
// 1 day, ended. Doctolib Pro / Paziresh24 warn before a subscription lapses
// so the practice's booking page and modules never switch off by surprise;
// here that is an in-app notice plus the licence*Provider SMS patterns
// (Models/NotificationSms.ts).

export type LicenseKind = "doctor" | "clinic" | "hospital" | "pharmacy" | "paraClinic" | "insurance";

const licenseKinds: Record<
  LicenseKind,
  { model: Model<any>; org: string; panel: string }
> = {
  doctor: { model: DoctorProfileLicense as Model<any>, org: "DoctorProfile", panel: "/doctorpanel/license" },
  clinic: { model: ClinicProfileLicense as Model<any>, org: "Clinic", panel: "/clinicpanel/license" },
  hospital: { model: HospitalProfileLicense as Model<any>, org: "Hospital", panel: "/hospitalpanel/license" },
  pharmacy: { model: PharmacyProfileLicense as Model<any>, org: "Pharmacy", panel: "/pharmacypanel/license" },
  paraClinic: { model: ParaClinicProfileLicense as Model<any>, org: "ParaClinic", panel: "/paraClinicPanel/license" },
  insurance: { model: InsuranceProfileLicense as Model<any>, org: "Insurance", panel: "/insurancepanel/license" },
};

const DAY = 24 * 60 * 60 * 1000;
// an "expired" notice for a plan that ended longer ago than this is not
// sent (the first run after a deploy must not text every old plan)
const EXPIRED_GRACE_MS = 3 * DAY;

// Called by each purchaseLicense handler once the plan is saved.
export const notifyLicensePurchased = (
  kind: LicenseKind,
  user: unknown,
  plan: string | undefined,
  expiresAt: Date,
): void => {
  const date = smsDate(expiresAt);
  notifyWithSms(
    "licensePurchasedProvider",
    user as mongoose.Types.ObjectId,
    { plan: plan || "", expiresAt: date },
    {
      notification: {
        title: "اشتراک شما فعال شد",
        message: `اشتراک «${plan || ""}» تا ${date} فعال است.`,
        link: licenseKinds[kind].panel,
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

const sendNotice = async (
  kind: LicenseKind,
  license: { _id: unknown; owner?: unknown; displayName?: string; expiresAt: Date },
  stage: LicenseExpiryStage,
  now: Date,
) => {
  const cfg = licenseKinds[kind];
  const org = await mongoose
    .model(cfg.org)
    .findById(license.owner)
    .select("user")
    .lean<{ user?: unknown }>();
  if (!org?.user) return;
  // claim first: a crash after this skips one notice rather than repeating it
  try {
    await LicenseExpiryNotice.create({
      license: license._id,
      kind,
      stage,
      expiresAt: license.expiresAt,
    });
  } catch {
    return; // already sent
  }
  const plan = license.displayName || "";
  const date = smsDate(license.expiresAt);
  const user = org.user as mongoose.Types.ObjectId;
  if (stage === "expired") {
    notifyWithSms(
      "licenseExpiredProvider",
      user,
      { plan },
      {
        notification: {
          title: "اشتراک شما به پایان رسید",
          message: `اشتراک «${plan}» به پایان رسید و بخش‌های آن غیرفعال شد. برای ادامه، اشتراک تازه بخرید.`,
          link: cfg.panel,
        },
      },
    );
    return;
  }
  const days = Math.max(1, Math.ceil((license.expiresAt.getTime() - now.getTime()) / DAY));
  notifyWithSms(
    "licenseExpiringProvider",
    user,
    { plan, days: String(days), expiresAt: date },
    {
      notification: {
        title: "اشتراک شما رو به پایان است",
        message: `اشتراک «${plan}» ${days.toLocaleString("fa-IR")} روز دیگر (${date}) به پایان می‌رسد. برای ادامه‌ی دسترسی آن را تمدید کنید.`,
        link: cfg.panel,
      },
    },
  );
};

// Hourly: every plan that ends within 7 days / 1 day, or ended in the last
// EXPIRED_GRACE_MS, gets that stage's notice once. A plan bought in the
// last day gets no "ends soon" notice (a short plan would be warned about
// right after its purchase SMS).
export const runLicenseExpirySweep = async (now = new Date()): Promise<number> => {
  let sent = 0;
  for (const kind of Object.keys(licenseKinds) as LicenseKind[]) {
    const rows = await licenseKinds[kind].model
      .find({
        expiresAt: {
          $gte: new Date(now.getTime() - EXPIRED_GRACE_MS),
          $lte: new Date(now.getTime() + 7 * DAY),
        },
      })
      .select("owner displayName expiresAt startedAt")
      .limit(5000)
      .lean<{ _id: unknown; owner?: unknown; displayName?: string; expiresAt: Date; startedAt?: Date }[]>();
    for (const license of Array.isArray(rows) ? rows : []) {
      if (!license?.expiresAt) continue;
      const expiresAt = new Date(license.expiresAt);
      const stage = stageOf(expiresAt, now);
      if (!stage) continue;
      if (
        stage !== "expired" &&
        license.startedAt &&
        now.getTime() - new Date(license.startedAt).getTime() < DAY
      )
        continue;
      try {
        await sendNotice(kind, { ...license, expiresAt }, stage, now);
        sent++;
      } catch (err) {
        console.log(`[licenseExpiry] ${kind} licence ${String(license._id)} failed:`, err);
      }
    }
  }
  return sent;
};

export const startLicenseExpiryJob = (intervalMs = 60 * 60 * 1000): void => {
  const run = () =>
    runLicenseExpirySweep().catch((err) =>
      console.log("[licenseExpiry] sweep failed:", err),
    );
  setTimeout(run, 60 * 1000).unref?.();
  setInterval(run, intervalMs).unref?.();
};
