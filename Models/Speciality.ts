import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ISpeciality extends MongoDoc {
  name?: string;
  slug?: string;
  image?: string;
  isHome: boolean;
  order: number;
  summary?: string;
  active: boolean;
  old?: mongoose.Types.ObjectId;
}

const SpecialitySchema = new mongoose.Schema<ISpeciality, Model<ISpeciality>>({
  name: { type: String, trim: true },
  slug: { type: String, trim: true, sparse: true, unique: true },
  image: { type: String },
  isHome: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  summary: { type: String, trim: true },
  active: { type: Boolean, default: false },
  old: { type: mongoose.Schema.ObjectId },
});

const Speciality = mongoose.model("Speciality", SpecialitySchema);

export default Speciality;
