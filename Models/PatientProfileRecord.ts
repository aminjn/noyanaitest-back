import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPatientProfile } from "./PatiantProfile";
import { IUserFile } from "./UserFile";
import { IDoctorProfile } from "./DoctorProfile";
import { ISymptom } from "./Symptom";

export interface IPatientProfileRecord extends MongoDoc {
  profile: IPatientProfile;
  createdAt: Date;
  title: string;
  description?: string;
  files?: IUserFile[];
  author: IDoctorProfile;
  isPublic: boolean;
  symptoms: ISymptom[];
}

const PatientProfileRecordSchema = new mongoose.Schema<
  IPatientProfileRecord,
  Model<IPatientProfileRecord>
>(
  {
    profile: {
      type: mongoose.Schema.ObjectId,
      ref: "PatientProfile",
      required: true,
    },
    createdAt: { type: Date, default: () => new Date() },
    title: { type: String, required: true },
    description: { type: String },
    author: {
      type: mongoose.Schema.ObjectId,
      ref: "DoctorProfile",
      required: true,
    },
    isPublic: { type: Boolean, default: false },
    symptoms: {
      type: [
        { type: mongoose.Schema.ObjectId, ref: "Symptom", required: true },
      ],
      default: [],
    },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

PatientProfileRecordSchema.virtual("files", {
  ref: "UserFile",
  localField: "_id",
  foreignField: "chat",
});

const PatientProfileRecord = mongoose.model(
  "PatientProfileRecord",
  PatientProfileRecordSchema
);

export default PatientProfileRecord;
