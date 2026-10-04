import mongoose from "mongoose";
import DoctorProfile from "../Models/DoctorProfile";
import Office from "../Models/Office";
import DoctorShift from "../Models/DoctorShift";
import { doctorSessionKindSettingsModelDict } from "../Controllers/bookingController";

// "Not public until complete" (2026-10, the onboarding decision): a doctor
// who signed up through the council inquiry starts as a draft and goes live
// by itself once a patient could actually book them - name, speciality and
// photo, an office, one visit type switched on with a price, and a weekly
// schedule (the panel's setup checklist, doctorController). It goes back to
// draft if one of them is removed. An admin publishing or hiding the page
// by hand ends the automatic rule for that doctor (autoPublish = false);
// a suspension always wins (Lib/providerStatus.ts).
export const isDoctorBookable = async (doctorId: unknown): Promise<boolean> => {
  const doctor = await DoctorProfile.findById(doctorId)
    .select("firstName lastName mainSpeciality avatar")
    .lean<{ firstName?: string; lastName?: string; mainSpeciality?: unknown; avatar?: string }>();
  if (!doctor?.firstName || !doctor.lastName || !doctor.mainSpeciality || !doctor.avatar) return false;
  const [office, shift, settings] = await Promise.all([
    Office.exists({ doctor: doctorId }),
    DoctorShift.exists({ doctor: doctorId }),
    Promise.all(
      Object.values(doctorSessionKindSettingsModelDict).map((model) =>
        model.exists({ doctor: doctorId, active: true, price: { $gt: 0 } }),
      ),
    ).then((found) => found.some(Boolean)),
  ]);
  return !!office && !!shift && settings;
};

export const syncDoctorPublished = async (doctorId: unknown): Promise<void> => {
  if (!doctorId || !mongoose.isValidObjectId(String(doctorId))) return;
  const doctor = await DoctorProfile.findById(doctorId)
    .select("autoPublish active status")
    .lean<{ autoPublish?: boolean; active?: boolean; status?: string }>();
  if (!doctor?.autoPublish || doctor.status === "suspended") return;
  const ready = await isDoctorBookable(doctorId);
  if (ready !== !!doctor.active)
    await DoctorProfile.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(doctorId)) },
      { $set: { active: ready } },
    );
};
