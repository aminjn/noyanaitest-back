import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { ITest } from "./Test";
import { IParaClinic } from "./Paraclinic";

export interface IParaClinicTest extends MongoDoc {
  test: ITest;
  price: number;
  paraClinic: IParaClinic;
  readyTime: string;
  // the lab pauses one test (kit out, device down) without deleting it
  // (2026-10): a paused offer is not shown publicly nor sold
  isActive: boolean;
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
});

ParaClinicTestSchema.index({ test: 1, paraClinic: 1 }, { unique: true });

const ParaClinicTest = mongoose.model("ParaClinicTest", ParaClinicTestSchema);

export default ParaClinicTest;
