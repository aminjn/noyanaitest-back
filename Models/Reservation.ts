import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IUserIdentity } from "./UserIdentity";
import { IDoctorProfile } from "./DoctorProfile";
import { IOffice } from "./Office";
import { DoctorSessionType, doctorSessionTypes } from "./DoctorSession";
import { ITransaction } from "./Transaction";

export interface IReservation extends MongoDoc {
  user: IUser;
  patient: IUserIdentity;
  doctor: IDoctorProfile;
  date: Date;
  start: number;
  end: number;
  office: IOffice;
  sessionType: DoctorSessionType;
  transaction?: ITransaction;
  createdAt: Date;
}

const ReservationSchema = new mongoose.Schema<
  IReservation,
  Model<IReservation>
>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  patient: {
    type: mongoose.Schema.ObjectId,
    ref: "UserIdentity",
    required: true,
  },
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  date: { type: Date, required: true },
  start: { type: Number, required: true },
  end: { type: Number, required: true },
  office: { type: mongoose.Schema.ObjectId, required: true, ref: "Office" },
  sessionType: { type: String, enum: doctorSessionTypes, required: true },
  transaction: { type: mongoose.Schema.ObjectId, ref: "Transaction" },
  createdAt: { type: Date, default: () => new Date() },
});

const Reservation = mongoose.model("Reservation", ReservationSchema);

export default Reservation;
