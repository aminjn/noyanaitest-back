import mongoose, { Model } from "mongoose";
import { MongoDoc, IUser } from "./User";
import { BizOwnerKind, bizOwnerKinds } from "./BizAccount";

// A saved, dynamic filter over one owner's contacts (2026-10, Lib/business/
// crm.ts contactRules): "no visit in 6 months", "tag: diabetes", "birthday
// this month", "no-show in the last 90 days", "high value". Its members are
// worked out each time it is read, so the count is always live; a campaign
// or an automation may use it as its audience.
export interface IBizRules {
  tags?: string[];
  // every tag (true) or any of them (default)
  tagsAll?: boolean;
  excludeTags?: string[];
  sources?: string[];
  gender?: "male" | "female";
  ageMin?: number;
  ageMax?: number;
  city?: string;
  insurer?: string;
  // the last visit or order: at least / at most this many days ago
  inactiveDays?: number;
  activeDays?: number;
  minVisits?: number;
  maxVisits?: number;
  minSpent?: number;
  // a no-show of their own in the last N days
  noShowDays?: number;
  birthday?: "today" | "week" | "month";
  // added to the list in the last N days
  newDays?: number;
  // the top fifth by money spent
  highValue?: boolean;
}

export const bizRulesSchema = {
  tags: { type: [String], default: undefined },
  tagsAll: Boolean,
  excludeTags: { type: [String], default: undefined },
  sources: { type: [String], default: undefined },
  gender: { type: String, enum: ["male", "female"] },
  ageMin: Number,
  ageMax: Number,
  city: { type: String, maxlength: 100 },
  insurer: { type: String, maxlength: 20 },
  inactiveDays: Number,
  activeDays: Number,
  minVisits: Number,
  maxVisits: Number,
  minSpent: Number,
  noShowDays: Number,
  birthday: { type: String, enum: ["today", "week", "month"] },
  newDays: Number,
  highValue: Boolean,
};

export const BizRulesSchema = new mongoose.Schema(bizRulesSchema, { _id: false });

export interface IBizSegment extends MongoDoc {
  ownerKind: BizOwnerKind;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  rules: IBizRules;
  createdBy?: IUser;
  createdAt: Date;
}

const BizSegmentSchema = new mongoose.Schema<IBizSegment, Model<IBizSegment>>(
  {
    ownerKind: { type: String, enum: bizOwnerKinds, required: true },
    ownerId: { type: mongoose.Schema.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    rules: { type: BizRulesSchema, default: {} },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

BizSegmentSchema.index({ ownerKind: 1, ownerId: 1, name: 1 }, { unique: true });

const BizSegment = mongoose.model("BizSegment", BizSegmentSchema);
export default BizSegment;
