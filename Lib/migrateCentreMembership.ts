import { Model } from "mongoose";
import ClinicDoctor from "../Models/ClinicDoctor";
import HospitalDoctor from "../Models/HospitalDoctor";
import DoctorJoinClinicRequest from "../Models/DoctorJoinClinicRequest";
import DoctorJoinHospitalRequest from "../Models/DoctorJoinHospitalRequest";

// Doctor <-> centre join requests whose status no longer matched the
// membership (2026-10, with the "Left" state, Lib/centreMembership.ts):
//  - Pending although the doctor is already a member (memberships added by
//    the admin before the ClinicDoctor / HospitalDoctor hook settled them):
//    the centre could still "reject" a member -> Approved;
//  - Approved although the membership is gone (the doctor left or was
//    removed): the doctor's list said "approved" -> Left.
// Idempotent: runs on every start, touches only rows that disagree.
const settle = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: Model<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  member: Model<any>,
  field: "clinic" | "hospital",
) => {
  const members = await member.find({}).select(`doctor ${field}`).lean<Record<string, unknown>[]>();
  const key = (d: unknown, c: unknown) => `${String(d)}:${String(c)}`;
  const joined = new Set(members.map((m) => key(m.doctor, m[field])));
  const open = await request
    .find({ status: { $in: ["Pending", "Approved"] } })
    .select(`doctor ${field} status`)
    .lean<Record<string, unknown>[]>();
  const now = new Date();
  const toApproved = open.filter((r) => r.status === "Pending" && joined.has(key(r.doctor, r[field])));
  const toLeft = open.filter((r) => r.status === "Approved" && !joined.has(key(r.doctor, r[field])));
  if (toApproved.length)
    await request.updateMany(
      { _id: { $in: toApproved.map((r) => r._id) } },
      { $set: { status: "Approved", decidedAt: now, statusLastChangedAt: now } },
    );
  if (toLeft.length)
    await request.updateMany(
      { _id: { $in: toLeft.map((r) => r._id) } },
      { $set: { status: "Left", decidedAt: now, statusLastChangedAt: now } },
    );
  if (toApproved.length || toLeft.length)
    console.log(
      `[centreMembership] ${field}: ${toApproved.length} request(s) -> Approved, ${toLeft.length} -> Left`,
    );
};

export const migrateCentreMembership = async () => {
  await settle(DoctorJoinClinicRequest, ClinicDoctor, "clinic");
  await settle(DoctorJoinHospitalRequest, HospitalDoctor, "hospital");
};
