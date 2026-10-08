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
export const labSamplingKinds = ["lab", "home"] as const;
export type LabSamplingKind = (typeof labSamplingKinds)[number];

export const labSamplingStatuses = ["active", "cancelled", "done"] as const;
export type LabSamplingStatus = (typeof labSamplingStatuses)[number];

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
  createdAt: Date;
}

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
  createdAt: { type: Date, default: () => new Date() },
});

LabSamplingSchema.index({ paraClinic: 1, ymd: 1, start: 1 });
LabSamplingSchema.index({ order: 1 });
LabSamplingSchema.index({ status: 1, startsAt: 1 });

const LabSampling = mongoose.model("LabSampling", LabSamplingSchema);

export default LabSampling;
