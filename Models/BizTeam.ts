import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A team of the owner's staff (2026-10, Nexxa Team): the panel owner and
// its secretaries grouped under a manager - the base of a team assignment
// rule and of a supervisor's team commission. The manager is always a member.
export interface IBizTeam extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  manager?: mongoose.Types.ObjectId;
  members: mongoose.Types.ObjectId[];
  createdAt: Date;
}

const BizTeamSchema = new mongoose.Schema<IBizTeam, Model<IBizTeam>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    manager: { type: mongoose.Schema.ObjectId, ref: "User" },
    members: { type: [{ type: mongoose.Schema.ObjectId, ref: "User" }], default: [] },
  },
  { timestamps: true },
);

BizTeamSchema.index({ ownerKind: 1, ownerId: 1 });

const BizTeam = mongoose.model("BizTeam", BizTeamSchema);
export default BizTeam;
