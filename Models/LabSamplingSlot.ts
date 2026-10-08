import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { LabSamplingKind, labSamplingKinds } from "./LabSampling";

// Seats taken in one sampling slot of a lab (Lib/labSampling.ts): one row
// per lab, kind, Tehran day and start minute. A seat is taken by a single
// conditional update ({ booked: { $lt: capacity } } -> $inc 1), so two
// buyers racing for the last seat can never both get it; a cancelled
// appointment gives its seat back with $inc -1.
export interface ILabSamplingSlot extends MongoDoc {
  paraClinic: mongoose.Types.ObjectId;
  kind: LabSamplingKind;
  ymd: string;
  start: number;
  booked: number;
}

const LabSamplingSlotSchema = new mongoose.Schema<ILabSamplingSlot, Model<ILabSamplingSlot>>({
  paraClinic: { type: mongoose.Schema.ObjectId, ref: "ParaClinic", required: true },
  kind: { type: String, enum: labSamplingKinds, required: true },
  ymd: { type: String, required: true },
  start: { type: Number, required: true },
  booked: { type: Number, default: 0, min: 0 },
});

LabSamplingSlotSchema.index({ paraClinic: 1, kind: 1, ymd: 1, start: 1 }, { unique: true });

const LabSamplingSlot = mongoose.model("LabSamplingSlot", LabSamplingSlotSchema);

export default LabSamplingSlot;
