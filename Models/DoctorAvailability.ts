import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export interface IDoctorAvailability extends MongoDoc {
  doctor: IDoctorProfile;
  date: Date;
  bounds: { start: number; end: number }[];
  isAvailable: boolean;
  start: number;
  end: number;
}

const DoctorAvailabilitySchema = new mongoose.Schema<
  IDoctorAvailability,
  Model<IDoctorAvailability>
>({
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  date: { type: Date, required: true },
  bounds: {
    type: [
      {
        type: {
          start: { type: Number, required: true },
          end: { type: Number, required: true },
        },
        required: true,
      },
    ],
    required: true,
  },
  start: { type: Number, required: true },
  end: { type: Number, required: true },
  isAvailable: { type: Boolean, required: true },
});

const DoctorAvailability = mongoose.model(
  "DoctorAvailability",
  DoctorAvailabilitySchema,
);

export default DoctorAvailability;
