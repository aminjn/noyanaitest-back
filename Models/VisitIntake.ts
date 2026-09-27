import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IReservation } from "./Reservation";

// Pre-visit questionnaire the patient fills for one reservation. Structured
// on purpose (not free chat): the doctor always gets the answers as fields,
// and the optional AI summary is only a shortcut on top of them.
export const intakeOnsets = ["today", "days", "week", "month", "longer"] as const;
export type IntakeOnset = (typeof intakeOnsets)[number];

export const intakeConditions = [
  "diabetes",
  "hypertension",
  "heart",
  "asthma",
  "kidney",
  "thyroid",
  "pregnancy",
] as const;
export type IntakeCondition = (typeof intakeConditions)[number];

// Symptoms that need emergency care rather than a booked visit.
export const intakeRedFlags = [
  "chestPain",
  "breathing",
  "fainting",
  "bleeding",
  "weakness",
  "highFever",
] as const;
export type IntakeRedFlag = (typeof intakeRedFlags)[number];

export interface IVisitIntake extends MongoDoc {
  reservation: IReservation;
  user: IUser;
  complaint: string;
  onset?: IntakeOnset;
  severity?: number;
  conditions: IntakeCondition[];
  medications?: string;
  allergies?: string;
  redFlags: IntakeRedFlag[];
  notes?: string;
  // AI shortcut for the doctor; absent when no clinical AI is configured
  aiSummary?: string;
  aiQuestions: string[];
  submittedAt: Date;
  updatedAt: Date;
}

const VisitIntakeSchema = new mongoose.Schema<IVisitIntake, Model<IVisitIntake>>({
  reservation: { type: mongoose.Schema.ObjectId, ref: "Reservation", required: true, unique: true },
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  complaint: { type: String, required: true, maxlength: 1000 },
  onset: { type: String, enum: intakeOnsets },
  severity: { type: Number, min: 0, max: 10 },
  conditions: { type: [{ type: String, enum: intakeConditions }], default: [] },
  medications: { type: String, maxlength: 1000 },
  allergies: { type: String, maxlength: 500 },
  redFlags: { type: [{ type: String, enum: intakeRedFlags }], default: [] },
  notes: { type: String, maxlength: 1000 },
  aiSummary: { type: String },
  aiQuestions: { type: [String], default: [] },
  submittedAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() },
});

const VisitIntake = mongoose.model("VisitIntake", VisitIntakeSchema);

export default VisitIntake;
