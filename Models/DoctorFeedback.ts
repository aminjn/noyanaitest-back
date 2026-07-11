import mongoose, { Model, mongo } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export const scores = [1, 2, 3, 4, 5] as const;

export type Score = (typeof scores)[number];

export interface IDoctorFeedBack extends MongoDoc {
  overalScore: Score; //تعداد ستاره
  behavior: Score; // نحوه برخورد پزشک
  commiunication: Score; // توضیح پزشک در هنگام ویزیت
  skill: Score; //مهارت پزشک در درمان و تشخیص
  booking: Score; //فرآیند پذیرش و رفتار منشی
  environment: Score; //شرایط محیطی
  waitTime: number; // مدت زمان انتظار
  suggest: boolean; // به بقیه پیشنهاد میکنید؟
  privateMessage?: string; // پیام خصوصی به نویان ای آی راجع به پزشک
  publicMessage?: string; // نظر عمومی راجع به پزشک
  doctor: IDoctorProfile;
  user: IUser;
  submittedAt: Date;
}

const DoctorFeedBackSchema = new mongoose.Schema<
  IDoctorFeedBack,
  Model<IDoctorFeedBack>
>({
  overalScore: {
    type: Number,
  },
  behavior: {
    type: Number,
  },
  commiunication: {
    type: Number,
  },
  skill: {
    type: Number,
  },
  booking: {
    type: Number,
  },
  environment: {
    type: Number,
  },
  waitTime: { type: Number },
  suggest: { type: Boolean },
  privateMessage: { type: String },
  publicMessage: { type: String },
  doctor: {
    type: mongoose.Schema.ObjectId,
    ref: "DoctorProfile",
    required: true,
  },
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  submittedAt: { type: Date, default: () => new Date() },
});

const DoctorFeedBack = mongoose.model("DoctorFeedBack", DoctorFeedBackSchema);

export default DoctorFeedBack;
