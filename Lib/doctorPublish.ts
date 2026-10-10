import mongoose from "mongoose";
import DoctorProfile from "../Models/DoctorProfile";
import { doctorOffers } from "./doctorOffer";

// "Not public until complete" (2026-10, the onboarding decision): a doctor
// who signed up through the council inquiry starts as a draft and goes live
// by itself once a patient could actually book them - name and speciality
// (a photo is recommended, never required: 2026-10, the owner's decision),
// and at least one visit type a patient can book: switched on with a
// price and held by a weekly shift at an active office (Lib/doctorOffer.ts,
// the same rule as the card, the search and the slot picker). It goes back
// to draft if one of them is removed. An admin publishing or hiding the
// page by hand ends the automatic rule for that doctor (autoPublish =
// false); a suspension always wins (Lib/providerStatus.ts).
//
// Before (doctor profile audit): "an office" and "a shift" were counted
// separately, so an inactive office, or a shift holding only a visit type
// that is switched off, published a page no patient could book.

// The panel's setup checklist (doctorController.getMyDashboard) - the same
// steps, each one checked the way the publish rule checks it.
export const doctorReadiness = async (doctorId: unknown) => {
  const doctor = await DoctorProfile.findById(doctorId)
    .select("firstName lastName mainSpeciality avatar introduction")
    .lean<{ firstName?: string; lastName?: string; mainSpeciality?: unknown; avatar?: string; introduction?: string }>();
  const offer = (await doctorOffers([doctorId])).get(String(doctorId));
  const profile = !!(doctor?.firstName && doctor.lastName && doctor.mainSpeciality);
  return {
    profile,
    avatar: !!doctor?.avatar,
    introduction: !!doctor?.introduction,
    office: !!offer?.hasActiveOffice,
    settings: !!offer?.priced.length,
    // a shift that really takes bookings (an on visit type, an active office)
    shift: !!offer?.sessionTypes.length,
    bookable: profile && !!offer?.sessionTypes.length,
  };
};

export const isDoctorBookable = async (doctorId: unknown): Promise<boolean> =>
  (await doctorReadiness(doctorId)).bookable;

export const syncDoctorPublished = async (doctorId: unknown): Promise<void> => {
  if (!doctorId || !mongoose.isValidObjectId(String(doctorId))) return;
  const doctor = await DoctorProfile.findById(doctorId)
    .select("autoPublish active status")
    .lean<{ autoPublish?: boolean; active?: boolean; status?: string }>();
  // autoPublish false: an admin decided by hand. Never set (a profile an
  // admin created, an older approval): it publishes once bookable, like a
  // new sign-up, but is never taken down by the rule - it was not the rule
  // that put it up
  if (!doctor || doctor.autoPublish === false || doctor.status === "suspended") return;
  const ready = await isDoctorBookable(doctorId);
  if (doctor.autoPublish !== true && !ready) return;
  if (ready !== !!doctor.active)
    await DoctorProfile.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(doctorId)) },
      { $set: { active: ready } },
    );
};
