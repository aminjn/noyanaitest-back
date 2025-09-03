import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { DoctorSessionType, IDoctorSession } from "./DoctorSession";
import { IDoctorProfile } from "./DoctorProfile";

export interface IBooking extends MongoDoc {
  session: IDoctorSession;
  user: IUser;
  doctor: IDoctorProfile;
  bookedAt: Date;
  message?: string;
  kind: DoctorSessionType;
  bookPrice: number;
}

const BookingSchema = new mongoose.Schema<IBooking, Model<IBooking>>({
  session: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorSession",
    required: true,
    unique: true,
  },
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  bookedAt: { type: Date, default: () => new Date() },
  message: { type: String, trim: true },
  kind: { type: String, trim: true },
  bookPrice: { type: Number, min: 0 },
});

const Booking = mongoose.model("Booking", BookingSchema);

export default Booking;
