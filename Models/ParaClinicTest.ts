import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { ITest } from "./Test";
import { IParaClinic } from "./Paraclinic";

// How the sample of a test is taken (2026-10, Lib/labSampling.ts):
//   lab       -> at the lab: the patient books an in-lab slot at checkout
//   labOrHome -> at the lab, or at home when the lab offers home sampling
//   none      -> no appointment (a sample the patient brings or uploads,
//                a result read from earlier images...)
// A slot is asked for only once the lab switched its schedule on
// (ParaClinicSamplingSettings.enabled); until then tests sell as before.
export const paraClinicTestSamplings = ["lab", "labOrHome", "none"] as const;
export type ParaClinicTestSampling = (typeof paraClinicTestSamplings)[number];

export interface IParaClinicTest extends MongoDoc {
  test: ITest;
  price: number;
  paraClinic: IParaClinic;
  readyTime: string;
  // the lab pauses one test (kit out, device down) without deleting it
  // (2026-10): a paused offer is not shown publicly nor sold
  isActive: boolean;
  sampling: ParaClinicTestSampling;
}

const ParaClinicTestSchema = new mongoose.Schema<
  IParaClinicTest,
  Model<IParaClinicTest>
>({
  test: { type: mongoose.Schema.ObjectId, ref: "Test", required: true },
  // the panel already required a positive price; the admin path now too
  price: { type: Number, required: true, min: 1 },
  paraClinic: {
    type: mongoose.Schema.ObjectId,
    ref: "ParaClinic",
    required: true,
  },
  readyTime: { type: String },
  isActive: { type: Boolean, default: true },
  // absent on rows older than 2026-10: read as "lab" (most tests take a
  // sample at the lab), which changes nothing until the lab's schedule is on
  sampling: { type: String, enum: paraClinicTestSamplings, default: "lab" },
});

ParaClinicTestSchema.index({ test: 1, paraClinic: 1 }, { unique: true });

const ParaClinicTest = mongoose.model("ParaClinicTest", ParaClinicTestSchema);

export default ParaClinicTest;
