import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// One to-do (2026-10, nexxacrm's checklistItem): in a list or loose, with
// sub-items (`parent`), a star, a priority (0-3), a due date and a repeat.
// Ticking a repeating top-level item done makes its next one (sub-items
// never repeat).
export const bizRepeats = ["none", "daily", "weekly", "monthly"] as const;
export type BizRepeat = (typeof bizRepeats)[number];

export interface IBizChecklistItem extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  list?: mongoose.Types.ObjectId;
  parent?: mongoose.Types.ObjectId;
  title: string;
  note?: string;
  priority: number;
  repeat: BizRepeat;
  dueAt?: Date;
  starred: boolean;
  done: boolean;
  doneAt?: Date;
  doneBy?: mongoose.Types.ObjectId;
  sequence: number;
  createdBy?: IUser;
  createdAt: Date;
}

const BizChecklistItemSchema = new mongoose.Schema<IBizChecklistItem, Model<IBizChecklistItem>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    list: { type: mongoose.Schema.ObjectId, ref: "BizChecklist" },
    parent: { type: mongoose.Schema.ObjectId, ref: "BizChecklistItem" },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    note: { type: String, trim: true, maxlength: 1000 },
    priority: { type: Number, min: 0, max: 3, default: 0 },
    repeat: { type: String, enum: bizRepeats, default: "none" },
    dueAt: Date,
    starred: { type: Boolean, default: false },
    done: { type: Boolean, default: false },
    doneAt: Date,
    doneBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    sequence: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizChecklistItemSchema.index({ ownerKind: 1, ownerId: 1, list: 1, parent: 1, sequence: 1 });

const BizChecklistItem = mongoose.model("BizChecklistItem", BizChecklistItemSchema);
export default BizChecklistItem;
