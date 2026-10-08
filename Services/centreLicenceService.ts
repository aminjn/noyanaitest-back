import mongoose, { Types } from "mongoose";
import LicenseExpiryNotice, { LicenseExpiryStage } from "../Models/LicenseExpiryNotice";
import { notifyWithSms, smsDate } from "./notificationSmsService";
import {
  CentreKind,
  centreKinds,
  centreLicenceNumberField,
  centreModel,
} from "../Lib/centreVerified";

// A centre's operating licence over time (2026-10, owner decision; the rule
// itself is Lib/centreVerified.ts centreVerified).
//
// Doctolib Pro and Paziresh24 remind a practice before its registration /
// subscription lapses so nothing switches off by surprise. Here the tick
// goes away at the licence's expiry by itself (the rule reads expiresAt
// live, the sweep never has to flip anything); the sweep tells the centre
// 30 days before and once it has expired, each once per expiry date
// (LicenseExpiryNotice, kind "centre:<kind>") - a renewal (a new expiry
// the admin records) starts a fresh pair.

const DAY = 24 * 60 * 60 * 1000;
const WARN_DAYS = 30;
// an "expired" notice for a licence that ended longer ago than this is not
// sent (the first run after a deploy must not text every old licence)
const EXPIRED_GRACE_MS = 3 * DAY;

const panelOf: Record<CentreKind, string> = {
  clinic: "/clinicpanel",
  hospital: "/hospitalpanel",
  pharmacy: "/pharmacypanel",
  paraClinic: "/paraClinicPanel",
  insurance: "/insurancepanel",
};

type LicensedCentre = {
  _id: Types.ObjectId;
  name?: string;
  user?: unknown;
  licence?: { verifiedAt?: Date; expiresAt?: Date };
};

const stageOf = (expiresAt: Date, now: Date): LicenseExpiryStage | null => {
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) return -left <= EXPIRED_GRACE_MS ? "expired" : null;
  return left <= WARN_DAYS * DAY ? "30d" : null;
};

const sendNotice = async (kind: CentreKind, centre: LicensedCentre, stage: LicenseExpiryStage, now: Date) => {
  if (!centre.user || !centre.licence?.expiresAt) return false;
  const expiresAt = new Date(centre.licence.expiresAt);
  // claim first: a crash after this skips one notice rather than repeating it
  try {
    await LicenseExpiryNotice.create({ license: centre._id, kind: `centre:${kind}`, stage, expiresAt });
  } catch {
    return false; // already sent
  }
  const name = centre.name || "";
  const user = centre.user as Types.ObjectId;
  if (stage === "expired") {
    notifyWithSms(
      "centreLicenceExpiredProvider",
      user,
      { name },
      {
        notification: {
          title: "پروانه‌ی فعالیت مرکز شما منقضی شد",
          message: `پروانه‌ی فعالیت «${name}» منقضی شد و نشان تأیید از صفحه‌ی مرکز برداشته شد. پروانه‌ی تمدیدشده را برای پشتیبانی بفرستید.`,
          link: panelOf[kind],
        },
      },
    );
    return true;
  }
  const days = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY));
  const date = smsDate(expiresAt);
  notifyWithSms(
    "centreLicenceExpiringProvider",
    user,
    { name, days: String(days), expiresAt: date },
    {
      notification: {
        title: "پروانه‌ی فعالیت مرکز شما رو به پایان است",
        message: `پروانه‌ی فعالیت «${name}» ${days} روز دیگر (${date}) منقضی می‌شود و پس از آن نشان تأیید از صفحه‌ی مرکز برداشته می‌شود. پروانه‌ی تمدیدشده را برای پشتیبانی بفرستید.`,
        link: panelOf[kind],
      },
    },
  );
  return true;
};

// Hourly: every verified licence that expires within 30 days, or expired
// in the last EXPIRED_GRACE_MS, gets that stage's notice once.
export const runCentreLicenceSweep = async (now = new Date()): Promise<number> => {
  let sent = 0;
  for (const kind of centreKinds) {
    const rows = await centreModel(kind)
      .find({
        "licence.verifiedAt": { $exists: true },
        "licence.expiresAt": {
          $gte: new Date(now.getTime() - EXPIRED_GRACE_MS),
          $lte: new Date(now.getTime() + WARN_DAYS * DAY),
        },
      })
      .select("name user licence.verifiedAt licence.expiresAt")
      .limit(5000)
      .lean<LicensedCentre[]>();
    for (const centre of Array.isArray(rows) ? rows : []) {
      if (!centre?.licence?.expiresAt) continue;
      const stage = stageOf(new Date(centre.licence.expiresAt), now);
      if (!stage) continue;
      try {
        if (await sendNotice(kind, centre, stage, now)) sent++;
      } catch (err) {
        console.log(`[centreLicence] ${kind} ${String(centre._id)} notice failed:`, err);
      }
    }
  }
  return sent;
};

export const startCentreLicenceJob = (intervalMs = 60 * 60 * 1000): void => {
  const run = () =>
    runCentreLicenceSweep().catch((err) => console.log("[centreLicence] sweep failed:", err));
  setTimeout(run, 90 * 1000).unref?.();
  setInterval(run, intervalMs).unref?.();
};

// ------------------------------------------------------------- migration

type ApprovedRequest = {
  _id: Types.ObjectId;
  user?: Types.ObjectId;
  centre?: Types.ObjectId;
  siamCode?: string;
  licenseNumber?: string;
  certificateDate?: Date;
  decidedAt?: Date;
  updatedAt?: Date;
};

const requestModelOf: Record<CentreKind, string> = {
  clinic: "BecomeClinicRequest",
  hospital: "BecomeHospitalRequest",
  pharmacy: "BecomePharmacyRequest",
  paraClinic: "BecomeParaClinicRequest",
  insurance: "BecomeInsuranceRequest",
};

export const requestLicenceCode = (kind: CentreKind, request: { siamCode?: unknown; licenseNumber?: unknown }) =>
  String((kind === "insurance" && request.licenseNumber) || request.siamCode || "")
    .trim()
    .slice(0, 60);

// Once (2026-10): the tick used to mean "has an owner account". A centre
// keeps it only if it has an admin-approved licence code - an Approved
// become-request of it naming a siam / Central Insurance code. That code
// becomes the centre's licence number (when it had none) and the
// request's decision its verification; every other centre is marked
// reviewed with no verification and loses the tick. A centre already
// carrying a `licence` record is left as it is, so a re-run changes
// nothing. Counts are logged per kind.
export const migrateCentreLicences = async (): Promise<Record<string, { kept: number; dropped: number }>> => {
  const out: Record<string, { kept: number; dropped: number }> = {};
  for (const kind of centreKinds) {
    const Model = centreModel(kind);
    const numberField = centreLicenceNumberField[kind];
    const centres = await Model.collection
      .find({ licence: { $exists: false } }, { projection: { user: 1, [numberField]: 1 } })
      .toArray();
    if (!centres.length) continue;
    const requests = (await mongoose
      .model(requestModelOf[kind])
      .collection.find(
        {
          status: "Approved",
          $or: [
            { centre: { $in: centres.map((c) => c._id) } },
            { user: { $in: centres.map((c) => c.user).filter(Boolean) } },
          ],
        },
        { projection: { user: 1, centre: 1, siamCode: 1, licenseNumber: 1, certificateDate: 1, decidedAt: 1, updatedAt: 1 } },
      )
      .sort({ decidedAt: -1, _id: -1 })
      .toArray()) as unknown as ApprovedRequest[];
    const byCentre = new Map<string, ApprovedRequest>();
    const byUser = new Map<string, ApprovedRequest[]>();
    for (const r of requests) {
      if (!requestLicenceCode(kind, r)) continue;
      if (r.centre && !byCentre.has(String(r.centre))) byCentre.set(String(r.centre), r);
      if (r.user) byUser.set(String(r.user), [...(byUser.get(String(r.user)) || []), r]);
    }
    let kept = 0;
    let dropped = 0;
    for (const c of centres) {
      // a request names its centre (clinics, hospitals); an older one - or a
      // single-centre kind - is the owner's, when it names no other centre
      const own = byCentre.get(String(c._id));
      const viaUser = !own && c.user
        ? (byUser.get(String(c.user)) || []).find((r) => !r.centre || String(r.centre) === String(c._id))
        : undefined;
      const request = own || viaUser;
      const code = request ? requestLicenceCode(kind, request) : "";
      const current = typeof c[numberField] === "string" ? String(c[numberField]).trim() : "";
      // the centre's number was changed since to another one: that one was
      // never approved, so it is not verified
      if (request && code && (!current || current === code)) {
        await Model.collection.updateOne(
          { _id: c._id, licence: { $exists: false } },
          {
            $set: {
              ...(current ? {} : { [numberField]: code }),
              licence: {
                verifiedAt: request.decidedAt || request.updatedAt || new Date(),
                ...(request.certificateDate ? { issuedAt: request.certificateDate } : {}),
              },
            },
          },
        );
        kept++;
      } else {
        await Model.collection.updateOne({ _id: c._id, licence: { $exists: false } }, { $set: { licence: {} } });
        if (c.user) dropped++;
      }
    }
    out[kind] = { kept, dropped };
    console.log(
      `[centreLicence] ${kind}: ${kept} keep the verified tick (approved licence code), ${dropped} owned centres lose it (no approved licence code)`,
    );
  }
  return out;
};
