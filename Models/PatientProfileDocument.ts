import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IPatientProfile } from "./PatiantProfile";

export interface IPatientProfileDocument extends MongoDoc {
  profile: IPatientProfile;
  createdAt: Date;
  text?: string;
  file?: string;
}

const PatientProfileDocumentSchema = new mongoose.Schema<
  IPatientProfileDocument,
  Model<IPatientProfileDocument>
>({});

const PatientProfileDocument = mongoose.model(
  "PatientProfileDocument",
  PatientProfileDocumentSchema
);

export default PatientProfileDocument;
