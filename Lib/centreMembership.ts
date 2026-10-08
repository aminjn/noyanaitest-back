import { Model } from "mongoose";
import Office from "../Models/Office";
import Hospital from "../Models/Hospital";
import DoctorJoinClinicRequest from "../Models/DoctorJoinClinicRequest";
import DoctorJoinHospitalRequest from "../Models/DoctorJoinHospitalRequest";

export type CentreKind = "clinic" | "hospital";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const requestModel: Record<CentreKind, Model<any>> = {
  clinic: DoctorJoinClinicRequest,
  hospital: DoctorJoinHospitalRequest,
};

// What ending a doctor's membership of a clinic / hospital does (2026-10),
// in one place for the three ways it ends - the doctor leaves
// (doctorController.leave*), the centre removes them
// (centerDoctorsController.removeMyDoctor) and the admin removes them (the
// /auto team tab). It used to differ by path: the hospital's manager stayed
// a doctor who had left it, and the join request stayed "Approved".
//  - the doctor's offices at the centre stop counting as the centre's (its
//    visit tax / share / accepted insurers no longer apply);
//  - a hospital's manager is one of its own doctors: it is cleared;
//  - the request that led to the membership becomes "Left" (terminal; the
//    doctor may ask again, which reopens the same row).
export const endCentreMembership = async (
  kind: CentreKind,
  doctor: unknown,
  centre: unknown,
) => {
  if (!doctor || !centre) return;
  const now = new Date();
  await Promise.all([
    Office.updateMany({ doctor, [kind]: centre }, { $unset: { [kind]: 1 } }),
    kind === "hospital"
      ? Hospital.updateOne({ _id: centre, owner: doctor }, { $unset: { owner: 1 } })
      : null,
    requestModel[kind].updateMany(
      { doctor, [kind]: centre, status: "Approved" },
      { $set: { status: "Left", decidedAt: now, statusLastChangedAt: now } },
    ),
  ]);
};
