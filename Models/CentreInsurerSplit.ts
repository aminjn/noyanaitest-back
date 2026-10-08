import mongoose from "mongoose";

// The split of what insurers pay for a doctor's visits at a clinic's or
// hospital's office (2026-10), kept on the membership (ClinicDoctor /
// HospitalDoctor). When only the centre holds the contract with an insurer,
// the centre sends the list and is paid (Lib/business/reservationInsurance.ts);
// `doctorPercent` is the part of each insurer line it owes the doctor
// (3305 doctors' share payable). The centre proposes a change, the doctor
// accepts or declines it; until then the agreed percentage stays. A
// reservation snapshots the agreed percentage when it is booked, so a change
// applies to new visits only. No split on a membership = 100% (the rule
// before 2026-10: the insurer's part passed to the doctor in full).
//
// The patient's part is not split here: Noyan pays it straight to the
// doctor, who is the seller of record of the visit (Services/
// reservationProgressService.ts) - the centre is paid only what it collects.

export const DEFAULT_DOCTOR_PERCENT = 100;

export interface ICentreInsurerSplit {
  doctorPercent: number;
  agreedAt?: Date;
  // the centre's change, waiting for the doctor
  proposal?: { doctorPercent: number; at: Date; by?: mongoose.Types.ObjectId };
  // the doctor's answer to the last proposal, when it was a no
  declined?: { doctorPercent: number; at: Date };
  // every agreed percentage, oldest first
  history?: { doctorPercent: number; from: Date }[];
}

const percent = { type: Number, min: 0, max: 100, required: true };

export const centreInsurerSplitSchema = new mongoose.Schema<ICentreInsurerSplit>(
  {
    doctorPercent: { ...percent, default: DEFAULT_DOCTOR_PERCENT },
    agreedAt: { type: Date },
    proposal: {
      type: new mongoose.Schema(
        { doctorPercent: percent, at: { type: Date, required: true }, by: { type: mongoose.Schema.ObjectId, ref: "User" } },
        { _id: false },
      ),
      default: undefined,
    },
    declined: {
      type: new mongoose.Schema({ doctorPercent: percent, at: { type: Date, required: true } }, { _id: false }),
      default: undefined,
    },
    history: {
      type: [new mongoose.Schema({ doctorPercent: percent, from: { type: Date, required: true } }, { _id: false })],
      default: undefined,
    },
  },
  { _id: false },
);
