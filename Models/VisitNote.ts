import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IReservation } from "./Reservation";
import { IDoctorProfile } from "./DoctorProfile";

// The doctor's note for one visit, in SOAP sections. The AI scribe only
// fills a draft in the editor; what is stored here is what the doctor saved.
// Audio is never stored - only the text the doctor keeps.
export interface IVisitNote extends MongoDoc {
  reservation: IReservation;
  doctor: IDoctorProfile;
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
  patientInstructions?: string;
  transcript?: string;
  // true when the saved text started from an AI draft
  aiAssisted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const text = (max: number) => ({ type: String, maxlength: max });

const VisitNoteSchema = new mongoose.Schema<IVisitNote, Model<IVisitNote>>({
  reservation: { type: mongoose.Schema.ObjectId, ref: "Reservation", required: true, unique: true },
  doctor: { type: mongoose.Schema.ObjectId, ref: "DoctorProfile", required: true },
  subjective: text(5000),
  objective: text(5000),
  assessment: text(5000),
  plan: text(5000),
  patientInstructions: text(3000),
  transcript: text(30000),
  aiAssisted: { type: Boolean, default: false },
  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() },
});

VisitNoteSchema.index({ doctor: 1, updatedAt: -1 });

const VisitNote = mongoose.model("VisitNote", VisitNoteSchema);

export default VisitNote;
