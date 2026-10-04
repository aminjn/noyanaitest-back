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
  // moderation (2026-10): why it was rejected, by whom and when
  rejectReason?: string;
  moderatedBy?: mongoose.Types.ObjectId;
  moderatedAt?: Date;
  // the doctor's one public reply (2026-10)
  reply?: { content: string; at: Date; by?: mongoose.Types.ObjectId };
}

const DoctorFeedBackSchema = new mongoose.Schema<
  IDoctorFeedBack,
  Model<IDoctorFeedBack>
>({
  overalScore: {
    type: Number,
    min: 1,
    max: 5,
  },
  behavior: {
    type: Number,
    min: 1,
    max: 5,
  },
  commiunication: {
    type: Number,
    min: 1,
    max: 5,
  },
  skill: {
    type: Number,
    min: 1,
    max: 5,
  },
  booking: {
    type: Number,
    min: 1,
    max: 5,
  },
  environment: {
    type: Number,
    min: 1,
    max: 5,
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
  rejectReason: { type: String, trim: true, maxlength: 500 },
  // staff identity stays out of public payloads
  moderatedBy: { type: mongoose.Schema.ObjectId, ref: "User", select: false },
  moderatedAt: { type: Date },
  reply: {
    type: new mongoose.Schema(
      {
        content: { type: String, trim: true, maxlength: 1000, required: true },
        at: { type: Date, default: () => new Date() },
        by: { type: mongoose.Schema.ObjectId, ref: "User", select: false },
      },
      { _id: false },
    ),
  },
});

// one review per visit (older feedback without a reservation is allowed)
DoctorFeedBackSchema.index(
  { reservation: 1 },
  { unique: true, partialFilterExpression: { reservation: { $exists: true } } },
);
DoctorFeedBackSchema.index({ doctor: 1, status: 1, submittedAt: -1 });

// What counts toward a doctor's public score and list: approved reviews
// backed by a completed visit (2026-10). Legacy feedback without a
// reservation stays in the admin list only.
export const publicDoctorFeedbackMatch = (doctor: mongoose.Types.ObjectId) => ({
  doctor,
  status: "Approved",
  reservation: { $exists: true, $ne: null },
});

/**
 * Recomputes averageScore/feedbackCount on a doctor's profile from their
 * approved, verified feedback (overalScore), and persists the result.
 */
export async function recalcDoctorFeedbackStats(doctor: mongoose.Types.ObjectId) {
  const stats = await DoctorFeedBack.aggregate([
    { $match: publicDoctorFeedbackMatch(doctor) },
    {
      $group: {
        _id: "$doctor",
        averageScore: { $avg: "$overalScore" },
        feedbackCount: { $sum: 1 },
        // "would recommend" answers, shown as "N people recommend"
        recommendCount: { $sum: { $cond: [{ $eq: ["$suggest", true] }, 1, 0] } },
      },
    },
  ]);

  const averageScore = stats[0]
    ? Math.round(stats[0].averageScore * 10) / 10
    : 0;
  const feedbackCount = stats[0]?.feedbackCount ?? 0;
  const recommendCount = stats[0]?.recommendCount ?? 0;

  await mongoose
    .model("DoctorProfile")
    .findByIdAndUpdate(doctor, { averageScore, feedbackCount, recommendCount });
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
