import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// The contract library of one owner (2026-10, Nexxa ContractType and
// ContentTemplate): a contract type ("type", a name only), a reusable
// clause ("clause") and a whole contract text kept as a template
// ("template").
export const bizBlockKinds = ["type", "clause", "template"] as const;

export interface IBizContentBlock extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  kind: (typeof bizBlockKinds)[number];
  name: string;
  body?: string;
  createdAt: Date;
}

const BizContentBlockSchema = new mongoose.Schema<IBizContentBlock, Model<IBizContentBlock>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    kind: { type: String, enum: bizBlockKinds, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, maxlength: 60_000 },
  },
  { timestamps: true },
);

BizContentBlockSchema.index({ ownerKind: 1, ownerId: 1, kind: 1, name: 1 });

const BizContentBlock = mongoose.model("BizContentBlock", BizContentBlockSchema);
export default BizContentBlock;
