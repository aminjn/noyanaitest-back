import { isValidObjectId, Model } from "mongoose";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import Secretary from "../Models/Secretary";

// One account can own several clinics and hospitals (2026-10, the
// Doctolib / Practo multi-site pattern). The clinic and hospital panels work
// on one centre at a time, the "active" one: the id in the
// `x-active-centre` header, else in the activeClinic / activeHospital
// cookie the centre switcher sets (POST /<kind>/centres/active), else the
// owner's first centre. A selected id is only honoured when the account
// owns that centre; staff reach a centre through their Secretary link (the
// workplace cookie, aclController.useAcl). Pharmacy, paraclinic and insurer
// stay one per account.
export const multiCentreKinds = ["clinic", "hospital"] as const;
export type MultiCentreKind = (typeof multiCentreKinds)[number];

export const isMultiCentreKind = (name: unknown): name is MultiCentreKind =>
  typeof name === "string" && (multiCentreKinds as readonly string[]).includes(name);

export const ACTIVE_CENTRE_HEADER = "x-active-centre";

export const activeCentreCookie: Record<MultiCentreKind, string> = {
  clinic: "activeClinic",
  hospital: "activeHospital",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const centreModel: Record<MultiCentreKind, Model<any>> = {
  clinic: Clinic,
  hospital: Hospital,
};

const secretaryOwnerPath: Record<MultiCentreKind, "Clinic" | "Hospital"> = {
  clinic: "Clinic",
  hospital: "Hospital",
};

// the centres this account owns, oldest first (the default is the first)
export const ownedCentres = (kind: MultiCentreKind, userId: unknown) =>
  centreModel[kind].find({ user: userId }).sort({ _id: 1 });

// the centres this account works in as staff (secretary links)
export const staffCentres = (kind: MultiCentreKind, userId: unknown) =>
  Secretary.find({ secretary: userId, ownerPath: secretaryOwnerPath[kind] }).populate({
    path: "owner",
    select: "name image slug",
  });

export type ActiveCentreResult =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { centre: any; denied?: false; stale?: boolean }
  | { centre?: undefined; denied: true };

// The owner's active centre. An explicit header naming a centre the account
// does not own is refused (denied); a cookie that no longer matches (the
// centre was moved to another owner) falls back to the first centre and is
// flagged stale so the caller can clear it.
export const resolveOwnedCentre = async (
  kind: MultiCentreKind,
  userId: unknown,
  selected: { header?: unknown; cookie?: unknown },
): Promise<ActiveCentreResult> => {
  const model = centreModel[kind];
  const header = typeof selected.header === "string" ? selected.header.trim() : "";
  if (header) {
    if (!isValidObjectId(header)) return { denied: true };
    const centre = await model.findOne({ _id: header, user: userId });
    return centre ? { centre } : { denied: true };
  }
  const cookie = typeof selected.cookie === "string" ? selected.cookie : "";
  if (cookie && isValidObjectId(cookie)) {
    const centre = await model.findOne({ _id: cookie, user: userId });
    if (centre) return { centre };
  }
  const centre = await model.findOne({ user: userId }).sort({ _id: 1 });
  return { centre, stale: !!cookie };
};
