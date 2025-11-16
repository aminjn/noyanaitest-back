import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

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
}

const DoctorFeedBackSchema = new mongoose.Schema<
  IDoctorFeedBack,
  Model<IDoctorFeedBack>
>({});

const DoctorFeedBack = mongoose.model("DoctorFeedBack", DoctorFeedBackSchema);

export default DoctorFeedBack;
