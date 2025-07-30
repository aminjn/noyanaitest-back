import mongoose, { Model } from "mongoose";
import { MongoDoc } from "../User";

export interface IOldSpeciality extends MongoDoc {
  name: string;
  image?: string;
  featured: boolean;
  order: number;
  summary?: string;
}

const specialitySchema = new mongoose.Schema<
  IOldSpeciality,
  Model<IOldSpeciality>
>(
  {
    name: { type: String, required: true, trim: true, unique: true },
    image: { type: String },
    featured: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    summary: { type: String },
  },
  { toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

specialitySchema.virtual("diseases", {
  ref: "Disease",
  localField: "_id",
  foreignField: "specialities",
});

specialitySchema.virtual("doctors", {
  ref: "Doctor",
  localField: "_id",
  foreignField: "speciality",
});

specialitySchema.virtual("doctorsCount", {
  ref: "Doctor",
  localField: "_id",
  foreignField: "speciality",
  count: true,
});

const OldSpeciality = mongoose.connection
  .useDb("Noyan")
  .model("Speciality", specialitySchema);

export default OldSpeciality;
