import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IParaClinic } from "./Paraclinic";
import { IUserAddress } from "./UserAddress";

// One sampling appointment of a cart order (2026-10, Lib/labSampling.ts):
// the test lines of one lab in one order that need a sample share it - an
// in-lab slot, or a home visit window at one of the buyer's addresses.
//
// status
//   active    -> holds its seat in the slot (LabSamplingSlot.booked); also
//                while the order's online payment is still pending
//   cancelled -> every line it covers was cancelled, or the order was never
//                paid; its seat was given back (exactly once: the flip from
//                "active" is the lock)
//   done      -> its lines are finished and at least one was fulfilled
//
// confirmedAt -> the lab accepted the appointment (accepting a line or the
//                agenda's "confirm"); until then it is NOT the lab's answer
//                to the order (Lib/orderResponse.ts keeps running)
// collectedAt -> the lab took the sample
// feeSettled  -> where the home-sampling fee went, set atomically once:
//                "lab" (a line was fulfilled) or "buyer" (all cancelled)
// moves       -> every reschedule (Lib/labSampling.ts rescheduleSampling):
//                who moved it, from where to where, and the home-fee
//                difference charged (+) or refunded (-) on the buyer's
//                wallet (Transaction.orderItem = the move's _id, once)
// moveCount   -> moves.length, the lock of a reschedule (two moves racing
//                on the same version: one wins)
// proposals   -> the lab's proposals to switch in-lab <-> home with a new
//                slot (Lib/labSamplingProposal.ts): the buyer accepts (the
//                buyer's own reschedule runs) or declines; at most one
//                "open" at a time, each leaves "open" once (the flip is the
//                lock)
// slotSetAt   -> when the current time was set (booking or last move):
//                the day-before reminder is skipped when that was already
//                inside its window - the booking / move notice told them
export const labSamplingKinds = ["lab", "home"] as const;
export type LabSamplingKind = (typeof labSamplingKinds)[number];

export const labSamplingStatuses = ["active", "cancelled", "done"] as const;
export type LabSamplingStatus = (typeof labSamplingStatuses)[number];

export const labSamplingActors = ["buyer", "lab", "admin"] as const;
export type LabSamplingActor = (typeof labSamplingActors)[number];

export interface ILabSamplingPlace {
  kind: LabSamplingKind;
  ymd: string;
  start: number;
  end: number;
  startsAt: Date;
  address?: mongoose.Types.ObjectId;
  fee: number;
}

// open      -> waiting for the buyer, until expiresAt
// accepted  -> the buyer accepted; the appointment moved (moves[].proposal)
// declined  -> the buyer said no; nothing changed
// withdrawn -> the lab took it back
// expired   -> no answer before expiresAt (the appointment minus the lab's
//              notice); nothing changed
// closed    -> the appointment moved some other way, was cancelled, or its
//              sample was taken before an answer
export const labSamplingProposalStatuses = [
  "open",
  "accepted",
  "declined",
  "withdrawn",
  "expired",
  "closed",
] as const;
export type LabSamplingProposalStatus = (typeof labSamplingProposalStatuses)[number];

export interface ILabSamplingProposal {
  _id: mongoose.Types.ObjectId;
  at: Date;
  byUser?: mongoose.Types.ObjectId;
  // the proposed place: always the other kind, a slot of the lab
  kind: LabSamplingKind;
  ymd: string;
  start: number;
  end: number;
  startsAt: Date;
  // the home fee of the proposed place, and the difference to what the
  // buyer paid (+ charged on accept, - refunded), as of the proposal
  fee: number;
  feeDelta: number;
  reason?: string;
  expiresAt: Date;
  status: LabSamplingProposalStatus;
  answeredAt?: Date;
}

export interface ILabSamplingMove {
  _id: mongoose.Types.ObjectId;
  at: Date;
  by: LabSamplingActor;
  byUser?: mongoose.Types.ObjectId;
  from: ILabSamplingPlace;
  to: ILabSamplingPlace;
  feeDelta: number;
  reason?: string;
  // the lab's proposal the buyer accepted
  proposal?: mongoose.Types.ObjectId;
}

export interface ILabSampling extends MongoDoc {
  paraClinic: IParaClinic;
  order: mongoose.Types.ObjectId;
  user: IUser;
  kind: LabSamplingKind;
  ymd: string;
  start: number;
  end: number;
  startsAt: Date;
  // the order's test lines (their _id) this appointment is for
  lines: mongoose.Types.ObjectId[];
  fee: number;
  address?: IUserAddress;
  status: LabSamplingStatus;
  confirmedAt?: Date;
  collectedAt?: Date;
  cancelledAt?: Date;
  remindedAt?: Date;
  feeSettled?: "lab" | "buyer";
  moves?: ILabSamplingMove[];
  moveCount?: number;
  proposals?: ILabSamplingProposal[];
  slotSetAt?: Date;
  createdAt: Date;
}

const PlaceSchema = new mongoose.Schema<ILabSamplingPlace>(
  {
    kind: { type: String, enum: labSamplingKinds, required: true },
    ymd: { type: String, required: true },
    start: { type: Number, required: true },
    end: { type: Number, required: true },
    startsAt: { type: Date, required: true },
    address: { type: mongoose.Schema.ObjectId, ref: "UserAddress" },
    fee: { type: Number, min: 0, default: 0 },
  },
  { _id: false },
);

const LabSamplingSchema = new mongoose.Schema<ILabSampling, Model<ILabSampling>>({
  paraClinic: { type: mongoose.Schema.ObjectId, ref: "ParaClinic", required: true },
  order: { type: mongoose.Schema.ObjectId, ref: "Order", required: true },
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  kind: { type: String, enum: labSamplingKinds, required: true },
  ymd: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  start: { type: Number, min: 0, max: 1440, required: true },
  end: { type: Number, min: 0, max: 1440, required: true },
  startsAt: { type: Date, required: true },
  lines: { type: [{ type: mongoose.Schema.ObjectId }], default: [] },
  fee: { type: Number, min: 0, default: 0 },
  address: { type: mongoose.Schema.ObjectId, ref: "UserAddress" },
  status: { type: String, enum: labSamplingStatuses, default: "active", required: true },
  confirmedAt: { type: Date },
  collectedAt: { type: Date },
  cancelledAt: { type: Date },
  remindedAt: { type: Date },
  feeSettled: { type: String, enum: ["lab", "buyer"] },
  moves: {
    type: [
      {
        at: { type: Date, required: true },
        by: { type: String, enum: labSamplingActors, required: true },
        byUser: { type: mongoose.Schema.ObjectId, ref: "User" },
        from: { type: PlaceSchema, required: true },
        to: { type: PlaceSchema, required: true },
        feeDelta: { type: Number, default: 0 },
        reason: { type: String, trim: true, maxlength: 1000 },
        proposal: { type: mongoose.Schema.ObjectId },
      },
    ],
    default: [],
  },
  proposals: {
    type: [
      {
        at: { type: Date, required: true },
        byUser: { type: mongoose.Schema.ObjectId, ref: "User" },
        kind: { type: String, enum: labSamplingKinds, required: true },
        ymd: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        start: { type: Number, min: 0, max: 1440, required: true },
        end: { type: Number, min: 0, max: 1440, required: true },
        startsAt: { type: Date, required: true },
        fee: { type: Number, min: 0, default: 0 },
        feeDelta: { type: Number, default: 0 },
        reason: { type: String, trim: true, maxlength: 500 },
        expiresAt: { type: Date, required: true },
        status: { type: String, enum: labSamplingProposalStatuses, default: "open", required: true },
        answeredAt: { type: Date },
      },
    ],
    default: [],
  },
  moveCount: { type: Number, min: 0, default: 0 },
  slotSetAt: { type: Date },
  createdAt: { type: Date, default: () => new Date() },
});

LabSamplingSchema.index({ paraClinic: 1, ymd: 1, start: 1 });
LabSamplingSchema.index({ order: 1 });
LabSamplingSchema.index({ status: 1, startsAt: 1 });
LabSamplingSchema.index({ "proposals.status": 1, "proposals.expiresAt": 1 });

const LabSampling = mongoose.model("LabSampling", LabSamplingSchema);

export default LabSampling;
