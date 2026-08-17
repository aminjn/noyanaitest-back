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

/**
 * Recomputes averageScore/feedbackCount on a doctor's profile from all of
 * their feedback (overalScore), and persists the result on that profile.
 */
async function recalcDoctorFeedbackStats(doctor: mongoose.Types.ObjectId) {
  const stats = await DoctorFeedBack.aggregate([
    { $match: { doctor } },
    {
      $group: {
        _id: "$doctor",
        averageScore: { $avg: "$overalScore" },
        feedbackCount: { $sum: 1 },
      },
    },
  ]);

  const averageScore = stats[0]
    ? Math.round(stats[0].averageScore * 10) / 10
    : 0;
  const feedbackCount = stats[0]?.feedbackCount ?? 0;

  await mongoose
    .model("DoctorProfile")
    .findByIdAndUpdate(doctor, { averageScore, feedbackCount });
}

// Submitting feedback (DoctorFeedBack.create / new DoctorFeedBack().save()).
DoctorFeedBackSchema.post("save", function (doc) {
  recalcDoctorFeedbackStats(
    doc.doctor as unknown as mongoose.Types.ObjectId,
  ).catch((err) =>
    console.error("Failed to recalc doctor feedback stats after save:", err),
  );
});

// Updates and deletes both go through findOneAndUpdate / findOneAndDelete
// (including the findById* variants, which delegate to these under the
// hood). Capture the affected feedback before the operation runs so we know
// which doctor to recalc afterwards.
DoctorFeedBackSchema.pre(/^findOneAnd/, async function (next) {
  (this as any)._feedbackBeforeOp = await (this as any).findOne();
  next();
});

DoctorFeedBackSchema.post(/^findOneAnd/, function () {
  const before = (this as any)._feedbackBeforeOp as IDoctorFeedBack | null;
  if (!before) return;
  recalcDoctorFeedbackStats(
    before.doctor as unknown as mongoose.Types.ObjectId,
  ).catch((err) =>
    console.error(
      "Failed to recalc doctor feedback stats after update/delete:",
      err,
    ),
  );
});

const DoctorFeedBack = mongoose.model("DoctorFeedBack", DoctorFeedBackSchema);

export default DoctorFeedBack;
