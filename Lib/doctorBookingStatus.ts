import mongoose from "mongoose";
import DoctorProfile from "../Models/DoctorProfile";
import { doctorOffers } from "./doctorOffer";
import { nextFreeSlots, NextSlot } from "./nextSlot";

// "Why can't patients book me?" (2026-10): the doctor's own answer, on the
// panel's home and hours pages (Doctolib Pro / Paziresh24 show the same
// "your page is not online yet" list). Every check is the one the public
// side applies - the page is public only when published (active), claimed
// and not suspended; a visit type counts only when switched on, priced and
// held by a weekly shift at an active office (Lib/doctorOffer.ts); and the
// first free time comes from the cards' own rule (Lib/nextSlot.ts). The
// blockers are keys (texts in the panel's messages), most basic first.
export type BookingBlocker =
  | "suspended"
  | "unclaimed"
  | "noName"
  | "noSpeciality"
  | "noAvatar"
  | "noOffice"
  | "noPricedType"
  | "noShift"
  | "hiddenByAdmin"
  | "noFreeTime";

export const doctorBookingStatus = async (doctorId: unknown) => {
  if (!doctorId || !mongoose.isValidObjectId(String(doctorId))) return null;
  const doctor = await DoctorProfile.findById(doctorId)
    .select("firstName lastName mainSpeciality avatar active autoPublish status claimed slug")
    .lean<{
      firstName?: string;
      lastName?: string;
      mainSpeciality?: unknown;
      avatar?: string;
      active?: boolean;
      autoPublish?: boolean;
      status?: string;
      claimed?: boolean;
      slug?: string;
    }>();
  if (!doctor) return null;
  const id = String(doctorId);
  const [offer, slots] = await Promise.all([
    doctorOffers([id]).then((m) => m.get(id)),
    nextFreeSlots([id]).catch(() => new Map<string, NextSlot>()),
  ]);
  const blockers: BookingBlocker[] = [];
  if (doctor.status === "suspended") blockers.push("suspended");
  if (doctor.claimed === false) blockers.push("unclaimed");
  if (!doctor.firstName || !doctor.lastName) blockers.push("noName");
  if (!doctor.mainSpeciality) blockers.push("noSpeciality");
  if (!offer?.hasActiveOffice) blockers.push("noOffice");
  if (!offer?.priced.length) blockers.push("noPricedType");
  else if (!offer.sessionTypes.length) blockers.push("noShift");
  // a draft that would publish by itself waits only for the steps above;
  // one an admin hid stays hidden whatever the doctor completes
  if (!doctor.active && doctor.autoPublish === false && doctor.status !== "suspended") blockers.push("hiddenByAdmin");
  const next = slots.get(id) || null;
  const published = !!doctor.active && doctor.claimed !== false && doctor.status !== "suspended";
  const live = published && !!next;
  // a photo never blocks the page (the owner's rule): only a suggestion
  const tips: BookingBlocker[] = doctor.avatar ? [] : ["noAvatar"];
  const open = live ? [] : blockers;
  if (!open.length && published && !next) open.push("noFreeTime");
  return {
    // patients can open the page and book a time now
    live,
    published,
    slug: doctor.slug || id,
    nextSlot: next ? { ymd: next.ymd, start: next.start, sessionType: next.sessionType } : null,
    blockers: open,
    tips,
  };
};
