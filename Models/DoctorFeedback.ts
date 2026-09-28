import mongoose, { Model, mongo } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { IDoctorProfile } from "./DoctorProfile";

export const scores = [1, 2, 3, 4, 5] as const;

export type Score = (typeof scores)[number];

export const doctorFeedbackStatuses = ["Pending", "Approved", "Rejected"] as const;
export type DoctorFeedbackStatus = (typeof doctorFeedbackStatuses)[number];

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
  // the completed visit this review is about (2026-09): reviews are
  // verified - one per reservation, only from the account that booked it
  reservation?: mongoose.Types.ObjectId;
  // moderation (2026-09): a review is public - on the doctor page, in the
  // doctor's score and the search sort - only once an admin approved it
  status: DoctorFeedbackStatus;
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
  reservation: { type: mongoose.Schema.ObjectId, ref: "Reservation" },
  status: {
    type: String,
    enum: doctorFeedbackStatuses,
    default: "Pending",
    required: true,
  },
});

// one review per visit (older feedback without a reservation is allowed)
DoctorFeedBackSchema.index(
  { reservation: 1 },
  { unique: true, partialFilterExpression: { reservation: { $exists: true } } },
);
DoctorFeedBackSchema.index({ doctor: 1, status: 1, submittedAt: -1 });

/**
 * Recomputes averageScore/feedbackCount on a doctor's profile from all of
 * their feedback (overalScore), and persists the result on that profile.
 */
async function recalcDoctorFeedbackStats(doctor: mongoose.Types.ObjectId) {
  const stats = await DoctorFeedBack.aggregate([
    { $match: { doctor, status: "Approved" } },
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
  // a separate query on the same filter: calling this.findOne() re-ran the
  // update query itself ("Query was already executed"), so every admin
  // edit / delete of a feedback failed with a 500
  const query = this as any;
  query._feedbackBeforeOp = await query.model
    .findOne(query.getFilter())
    .select({ doctor: 1 })
    .lean();
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
