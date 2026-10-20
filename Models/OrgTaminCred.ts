import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// A pharmacy's or lab's own Tamin token (2026-10). Their Tamin calls used to
// borrow whichever doctor's token came first (DoctorTaminCred.findOne()),
// acting in that doctor's name; each centre now has its own, or none.
export interface IOrgTaminCred extends MongoDoc {
  org: mongoose.Types.ObjectId;
  orgModel: "Pharmacy" | "ParaClinic";
  token?: string;
  tokenRefreshedAt?: Date;
}

const OrgTaminCredSchema = new mongoose.Schema<IOrgTaminCred, Model<IOrgTaminCred>>({
  org: { type: mongoose.Schema.ObjectId, refPath: "orgModel", required: true, unique: true },
  orgModel: { type: String, enum: ["Pharmacy", "ParaClinic"], required: true },
  token: { type: String, select: false },
  tokenRefreshedAt: { type: Date },
});

const OrgTaminCred = mongoose.model("OrgTaminCred", OrgTaminCredSchema);

// the centre's own credential; nothing without a centre
export const orgTaminCred = async (org?: { _id?: unknown } | null) =>
  org?._id ? OrgTaminCred.findOne({ org: org._id }).select("+token").lean<{ token?: string }>() : null;

export default OrgTaminCred;
