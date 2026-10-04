import mongoose from "mongoose";

// A doctor's location is their office's (2026-10): the office is where the
// patient goes, as on Doctolib / Docplanner / Paziresh24. DoctorProfile
// .location (map search, "near me") is derived from the first active office
// with a pin (else any office with one), and its province / city / district
// follow it (the geoFromPoint plugin on DoctorProfile). The old lat / lng
// copy from the legacy import is dropped once an office has a pin. A doctor
// with no office pin keeps the point on record.
export const syncDoctorLocation = async (doctorId: unknown): Promise<void> => {
  if (!doctorId || !mongoose.isValidObjectId(String(doctorId))) return;
  const Office = mongoose.model("Office");
  const DoctorProfile = mongoose.model("DoctorProfile");
  const office = await Office.findOne({ doctor: doctorId, "location.coordinates.1": { $exists: true } })
    .sort({ active: -1, order: 1, _id: 1 })
    .select("location")
    .lean<{ location?: { coordinates?: number[] } }>();
  const coords = office?.location?.coordinates;
  if (!coords || coords.length < 2) return;
  const doctor = await DoctorProfile.findById(doctorId)
    .select("location")
    .lean<{ location?: { coordinates?: number[] } }>();
  const same =
    doctor?.location?.coordinates?.[0] === coords[0] &&
    doctor?.location?.coordinates?.[1] === coords[1];
  if (same) return;
  await DoctorProfile.findByIdAndUpdate(doctorId, {
    $set: { location: { type: "Point", coordinates: [coords[0], coords[1]] } },
    $unset: { lat: 1, lng: 1 },
  });
};
