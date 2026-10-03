import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { ITest } from "./Test";
import { IParaClinic } from "./Paraclinic";

export interface IParaClinicTest extends MongoDoc {
  test: ITest;
  price: number;
  paraClinic: IParaClinic;
  readyTime: string;
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
});

ParaClinicTestSchema.index({ test: 1, paraClinic: 1 }, { unique: true });

const ParaClinicTest = mongoose.model("ParaClinicTest", ParaClinicTestSchema);

export default ParaClinicTest;
