import ParaClinicTest from "../Models/ParaClinicTest";
import ParaClinic from "../Models/Paraclinic";
import Pharmacy from "../Models/Pharmacy";

// Lab and pharmacy records saved before the current rules (2026-10):
// - a lab's test offer has its own on/off switch now; old offers are on,
//   except one with no valid price (the model now requires >= 1): it is
//   switched off, so it is neither shown at "0 toman" nor sold, and stays in
//   the lab's panel to be priced
// - ParaClinic.specialities was written by an old admin form and read by
//   nothing (the lab's kind is its category and tags): removed
// - a pharmacy pin with no coordinates is no pin at all
export const migrateLabPharmacyIntegrity = async () => {
  const unpriced = await ParaClinicTest.collection.updateMany(
    {
      isActive: { $exists: false },
      $or: [{ price: { $exists: false } }, { price: null }, { price: { $lt: 1 } }],
    },
    { $set: { isActive: false } },
  );
  const priced = await ParaClinicTest.collection.updateMany(
    { isActive: { $exists: false } },
    { $set: { isActive: true } },
  );
  const specialities = await ParaClinic.collection.updateMany(
    { specialities: { $exists: true } },
    { $unset: { specialities: "" } },
  );
  const pins = await Pharmacy.collection.updateMany(
    { location: { $exists: true }, "location.coordinates.1": { $exists: false } },
    { $unset: { location: "" } },
  );
  const changed =
    unpriced.modifiedCount + priced.modifiedCount + specialities.modifiedCount + pins.modifiedCount;
  if (changed)
    console.log(
      `[labPharmacy] offers off (no price): ${unpriced.modifiedCount}, offers on: ${priced.modifiedCount}, ` +
        `lab specialities removed: ${specialities.modifiedCount}, empty pharmacy pins removed: ${pins.modifiedCount}`,
    );
};
