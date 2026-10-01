import { NextFunction, Request, RequestHandler, Response } from "express";
import mongoose, { isValidObjectId } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import Reservation, {
  IReservation,
  IReservationAdminAction,
  reservationStatuses,
} from "../Models/Reservation";
import { doctorSessionTypes } from "../Models/DoctorSession";
import Transaction from "../Models/Transaction";
import DoctorProfile from "../Models/DoctorProfile";
import DoctorShift from "../Models/DoctorShift";
import DoctorFeedback from "../Models/DoctorFeedback";
import UserIdentity from "../Models/UserIdentity";
import User from "../Models/User";
import Office from "../Models/Office";
import CallRoom from "../Models/CallRoom";
import CallRecording from "../Models/CallRecording";
import Notification from "../Models/Notification";
import updateDoctorAvailability from "../Lib/updateDoctorAvailablity";
import { saturdayBasedDay } from "../Lib/dateUtils";
import { getShiftSessionBounds } from "../Lib/shiftUtils";
import { reservationStartsAt } from "../Services/reservationCancelService";
import { handleReservationSuccess } from "../Services/reservationProgressService";
import { moveWalletMoneyByAdmin } from "../Services/adminWalletService";

// Reservations back office (2026-10, audit P1-1). What Doctolib Pro /
// Docplanner / Practo Ray support desks have: one searchable list of every
// appointment, the record with its money trail, and the few one-way actions
// support needs - cancel with a full or partial refund, move to another free
// slot of the same doctor, and settle the no-show / error outcomes the
// lifecycle sweeps leave behind. Every money move goes through the wallet
// ledger (Services/adminWalletService.ts) and is logged on the reservation
// (adminActions) besides the global admin audit (auditAdminActions).

const MAX_LIMIT = 100;
const IDENTITY_MATCH_LIMIT = 500;
// an admin money action holds the reservation this long at most
const LOCK_MS = 60 * 1000;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toAsciiDigits = (text: string) =>
  text
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

// "YYYY-MM-DD" -> local midnight of that day (reservation.date is stored as
// local midnight, see bookingController.submitBookingNew); anything else
// Date can parse is taken to its local day start.
const dayStart = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  if (isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
};
const nextDay = (date: Date) => {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  return next;
};
const objectId = z.string().refine(isValidObjectId, "invalid id");
const hhmm = (m: number) =>
  `${`${Math.floor(m / 60)}`.padStart(2, "0")}:${`${m % 60}`.padStart(2, "0")}`;

const DOCTOR_FIELDS = "firstName lastName slug user";
const IDENTITY_FIELDS = "givenName lastName nationalId";
const USER_FIELDS = "phone username";

// ---------------------------------------------------------------- list

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(reservationStatuses).optional(),
  sessionType: z.enum(doctorSessionTypes).optional(),
  doctor: objectId.optional(),
  // the account that booked (and paid)
  user: objectId.optional(),
  // the patient identity the visit is for
  patient: objectId.optional(),
  office: objectId.optional(),
  clinic: objectId.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  // only the ones a person must look at: error, noShow not yet settled
  needsAction: z.enum(["1", "true"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(25),
});

// GET /admin/reservations
export const listReservations: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const input = parsed.data;
    const filter: Record<string, unknown> = {};
    if (input.sessionType) filter.sessionType = input.sessionType;
    if (input.doctor) filter.doctor = input.doctor;
    if (input.user) filter.user = input.user;
    if (input.patient) filter.patient = input.patient;
    if (input.office) filter.office = input.office;
    if (input.clinic) {
      const offices = await Office.find({ clinic: input.clinic }).select("_id").lean();
      filter.office = input.office
        ? offices.some((o) => String(o._id) === input.office)
          ? input.office
          : { $in: [] }
        : { $in: offices.map((o) => o._id) };
    }
    const from = input.from ? dayStart(input.from) : null;
    const to = input.to ? dayStart(input.to) : null;
    if (input.from && !from) return next(new BadInputError("from"));
    if (input.to && !to) return next(new BadInputError("to"));
    if (from || to)
      filter.date = { ...(from && { $gte: from }), ...(to && { $lt: nextDay(to) }) };
    if (input.q) {
      const text = toAsciiDigits(input.q);
      const pattern = new RegExp(escapeRegex(text), "i");
      const or: Record<string, unknown>[] = [];
      if (isValidObjectId(text)) or.push({ _id: text });
      const [doctors, identities] = await Promise.all([
        DoctorProfile.find({ $or: [{ firstName: pattern }, { lastName: pattern }] })
          .select("_id")
          .limit(IDENTITY_MATCH_LIMIT)
          .lean(),
        UserIdentity.find({
          $or: [{ givenName: pattern }, { lastName: pattern }, { nationalId: pattern }],
        })
          .select("_id")
          .limit(IDENTITY_MATCH_LIMIT)
          .lean(),
      ]);
      if (doctors.length) or.push({ doctor: { $in: doctors.map((d) => d._id) } });
      if (identities.length) or.push({ patient: { $in: identities.map((i) => i._id) } });
      const digits = text.replace(/\D/g, "");
      if (digits.length >= 3) {
        const local = digits.replace(/^(98|0)/, "");
        const users = await User.find({ phone: new RegExp(escapeRegex(local)) })
          .select("_id")
          .limit(IDENTITY_MATCH_LIMIT)
          .lean();
        if (users.length) or.push({ user: { $in: users.map((u) => u._id) } });
      }
      filter.$or = or.length ? or : [{ _id: { $in: [] } }];
    }
    // counts per status for the tabs: same filter, any status
    const countFilter = { ...filter };
    if (input.status) filter.status = input.status;
    if (input.needsAction) {
      filter.status = input.status
        ? { $in: [input.status].filter((s) => s === "noShow" || s === "error") }
        : { $in: ["noShow", "error"] };
      filter["adminActions.action"] = {
        $nin: ["resolveRefund", "resolveComplete", "resolveAccept"],
      };
    }

    const [items, total, statusCounts] = await Promise.all([
      Reservation.find(filter)
        .sort({ date: -1, start: -1, _id: -1 })
        .skip((input.page - 1) * input.limit)
        .limit(input.limit)
        .populate([
          { path: "doctor", select: DOCTOR_FIELDS },
          { path: "patient", select: IDENTITY_FIELDS },
          { path: "user", select: USER_FIELDS },
          { path: "office", select: "name clinic hospital" },
        ])
        .lean(),
      Reservation.countDocuments(filter),
      Reservation.aggregate([
        { $match: castIds(countFilter) },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    // same envelope as the finance lists (rows + total/page/limit at the
    // top level), so the admin pages share one pager
    res.status(200).json({
      message: "listReservations",
      data: items.map((r: any) => ({
        _id: r._id,
        date: r.date,
        start: r.start,
        end: r.end,
        sessionType: r.sessionType,
        status: r.status,
        noShowParty: r.noShowParty,
        total: r.total,
        doctor: r.doctor || null,
        patient: r.patient || null,
        user: r.user || null,
        office: r.office || null,
        createdAt: r.createdAt,
      })),
      total,
      page: input.page,
      limit: input.limit,
      statusCounts: Object.fromEntries(
        statusCounts.map((row: any) => [row._id, row.count]),
      ),
    });
  },
);

// aggregate() does not cast like find(): turn id strings into ObjectIds
const castIds = (filter: Record<string, unknown>): Record<string, unknown> => {
  const cast = (v: unknown): unknown => {
    if (typeof v === "string" && isValidObjectId(v) && v.length === 24)
      return new mongoose.Types.ObjectId(v);
    if (Array.isArray(v)) return v.map(cast);
    if (v instanceof Date || v instanceof mongoose.Types.ObjectId) return v;
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cast(x)]));
    return v;
  };
  return cast(filter) as Record<string, unknown>;
};

// ---------------------------------------------------------------- money

// The reservation's money trail, from the ledger (never trusted from the
// client): what the booker paid, what came back to them, and what the doctor
// was paid net of any reversal.
const moneyOf = async (reservation: IReservation) => {
  const rows = await Transaction.find({ reservation: reservation._id })
    .sort({ createdAt: 1 })
    .populate({ path: "adminBy", select: USER_FIELDS })
    .populate({ path: "user", select: USER_FIELDS })
    .lean();
  const booker = String((reservation.user as any)?._id ?? reservation.user);
  const userOf = (t: any) => String(t.user?._id ?? t.user);
  const payment =
    rows.find((t: any) => reservation.transaction && String(t._id) === String((reservation.transaction as any)?._id ?? reservation.transaction)) ||
    rows.find((t: any) => !t.doctor && t.amount < 0 && userOf(t) === booker);
  const paid = payment ? Math.abs(payment.amount) : 0;
  const refunded = rows
    .filter((t: any) => !t.doctor && t.amount > 0 && userOf(t) === booker)
    .reduce((sum, t: any) => sum + t.amount, 0);
  const doctorPaid = rows
    .filter((t: any) => !!t.doctor)
    .reduce((sum, t: any) => sum + t.amount, 0);
  return {
    rows,
    paid,
    refunded,
    refundable: Math.max(0, paid - refunded),
    doctorPaid: Math.max(0, doctorPaid),
  };
};

const claim = async (id: string) =>
  Reservation.findOneAndUpdate(
    {
      _id: id,
      $or: [
        { adminLockAt: { $exists: false } },
        { adminLockAt: { $lt: new Date(Date.now() - LOCK_MS) } },
      ],
    },
    { $set: { adminLockAt: new Date() } },
    { new: true },
  ).populate({ path: "doctor", populate: { path: "user", select: "_id" } });

const release = (id: string) =>
  Reservation.updateOne({ _id: id }, { $unset: { adminLockAt: 1 } }).catch(() => {});

// runs one admin action with the reservation held, so two admins (or a
// double click) can never move this reservation's money at the same time
const withReservation = async (
  id: string,
  run: (reservation: IReservation) => Promise<void>,
) => {
  if (!isValidObjectId(id)) throw new NotFoundError("نوبت");
  const reservation = await claim(id);
  if (!reservation) {
    if (!(await Reservation.exists({ _id: id }))) throw new NotFoundError("نوبت");
    throw new AppError("عملیات دیگری روی این نوبت در جریان است؛ چند لحظه بعد دوباره تلاش کنید", 409);
  }
  try {
    await run(reservation as unknown as IReservation);
  } finally {
    await release(id);
  }
};

const logAction = (id: unknown, entry: Omit<IReservationAdminAction, "at">) =>
  Reservation.updateOne(
    { _id: id },
    { $push: { adminActions: { ...entry, at: new Date() } } },
  );

const bookerOf = (r: IReservation) => (r.user as any)?._id ?? r.user;
const doctorUserOf = (r: IReservation) =>
  (r.doctor as any)?.user?._id ?? (r.doctor as any)?.user;

const notify = (docs: { user: unknown; title: string; message: string; link: string }[]) =>
  Notification.insertMany(
    docs.filter((d) => !!d.user).map((d) => ({ ...d, source: "System" })),
  ).catch(() => {});

const reasonSchema = z.string().trim().min(3).max(500);
const requestKeySchema = z.string().trim().min(8).max(100);

const refundToBooker = (
  r: IReservation,
  amount: number,
  adminBy: unknown,
  reason: string,
  requestKey: string,
) =>
  moveWalletMoneyByAdmin({
    user: bookerOf(r),
    amount,
    action: "reservationRefund",
    adminBy: adminBy as string,
    note: reason,
    requestKey: `${requestKey}:refund`,
    extra: { reservation: r._id },
  });

// ---------------------------------------------------------------- detail

// GET /admin/reservations/:nodeId
export const getReservation: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError("نوبت"));
    const reservation = await Reservation.findById(nodeId)
      .select("+adminActions")
      .populate([
        {
          path: "doctor",
          select: DOCTOR_FIELDS,
          populate: { path: "user", select: USER_FIELDS },
        },
        {
          path: "patient",
          select: `${IDENTITY_FIELDS} gender dateOfbirth phones user`,
        },
        { path: "user", select: USER_FIELDS },
        {
          path: "office",
          select: "name address tel clinic hospital",
          populate: [
            { path: "clinic", select: "name" },
            { path: "hospital", select: "name" },
          ],
        },
        { path: "adminActions.by", select: USER_FIELDS },
      ]);
    if (!reservation) return next(new NotFoundError("نوبت"));
    const money = await moneyOf(reservation as unknown as IReservation);
    const roomFilter = reservation.callRoom
      ? { $or: [{ _id: reservation.callRoom }, { reservation: reservation._id }] }
      : { reservation: reservation._id };
    const [rooms, feedback] = await Promise.all([
      CallRoom.find(roomFilter)
        .select("callType status startedAt connectedAt endedAt participants")
        .sort({ startedAt: 1 })
        .lean(),
      DoctorFeedback.findOne({ reservation: reservation._id }).lean(),
    ]);
    const recordings = rooms.length
      ? await CallRecording.find({ room: { $in: rooms.map((r) => r._id) } })
          .select("room kind status startedAt endedAt")
          .lean()
      : [];
    const r = reservation.toObject() as any;
    const resolved = (r.adminActions || []).some((a: any) =>
      String(a.action).startsWith("resolve"),
    );
    res.status(200).json({
      message: "getReservation",
      data: {
        data: {
          ...r,
          startsAt: reservationStartsAt(reservation as unknown as IReservation),
          money: {
            paid: money.paid,
            refunded: money.refunded,
            refundable: money.refundable,
            doctorPaid: money.doctorPaid,
            subtotal: r.subtotal,
            tax: r.tax,
            total: r.total,
            transactions: money.rows,
          },
          calls: rooms.map((room: any) => ({
            ...room,
            recordings: recordings.filter((x: any) => String(x.room) === String(room._id)).length,
          })),
          feedback: feedback || null,
          resolved,
          adminActions: r.adminActions || [],
        },
      },
    });
  },
);

// ---------------------------------------------------------------- cancel

const cancelSchema = z.strictObject({
  reason: reasonSchema,
  refund: z.enum(["full", "partial", "none"]),
  amount: z.coerce.number().int().positive().optional(),
  requestKey: requestKeySchema,
});

// POST /admin/reservations/:nodeId/cancel
// A still-pending reservation only (an active one is in progress; settle it
// once it is over). Refund full / part / nothing to the booker's wallet.
export const cancelReservationByAdmin: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = cancelSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const input = parsed.data;
    await withReservation(req.params.nodeId, async (r) => {
      if (r.status !== "pending")
        throw new AppError("فقط نوبتی که هنوز برگزار نشده را می‌توان لغو کرد", 400);
      const money = await moneyOf(r);
      const amount =
        input.refund === "full"
          ? money.refundable
          : input.refund === "partial"
            ? input.amount || 0
            : 0;
      if (input.refund === "partial" && (amount <= 0 || amount > money.refundable))
        throw new AppError("مبلغ بازپرداخت باید بیشتر از صفر و حداکثر برابر مبلغ قابل بازپرداخت باشد", 400);
      const now = new Date();
      const flipped = await Reservation.findOneAndUpdate(
        { _id: r._id, status: "pending" },
        {
          $set: {
            status: "cancelled",
            cancelledAt: now,
            cancelledBy: "admin",
            cancelReason: input.reason,
          },
        },
      );
      if (!flipped)
        throw new AppError("فقط نوبتی که هنوز برگزار نشده را می‌توان لغو کرد", 400);
      if (amount > 0) {
        try {
          await refundToBooker(r, amount, req.user!._id, input.reason, input.requestKey);
        } catch (err) {
          // nothing was refunded: the reservation stays as it was
          await Reservation.updateOne(
            { _id: r._id, status: "cancelled" },
            {
              $set: { status: "pending" },
              $unset: { cancelledAt: 1, cancelledBy: 1, cancelReason: 1 },
            },
          );
          throw err;
        }
      }
      await logAction(r._id, {
        action: "cancel",
        by: req.user!._id as any,
        reason: input.reason,
        amount,
      });
      const doctor = await DoctorProfile.findById((r.doctor as any)?._id ?? r.doctor);
      if (doctor)
        updateDoctorAvailability({ doctor, startDate: r.date, endDate: r.date }).catch(() => {});
      const when = hhmm(r.start);
      notify([
        {
          user: bookerOf(r),
          title: "نوبت شما توسط پشتیبانی لغو شد",
          message:
            amount > 0
              ? `نوبت ساعت ${when} لغو شد و ${amount.toLocaleString("fa-IR")} تومان به کیف پول شما برگشت.`
              : `نوبت ساعت ${when} لغو شد.`,
          link: `/dashboard/booking/${r._id}`,
        },
        {
          user: doctorUserOf(r),
          title: "یک نوبت توسط پشتیبانی لغو شد",
          message: `نوبت ساعت ${when} لغو شد و زمان آن دوباره قابل رزرو است.`,
          link: `/doctorpanel/booking/${r._id}`,
        },
      ]);
    });
    res.status(200).json({ message: "cancelReservationByAdmin" });
  },
);

// ---------------------------------------------------------------- refund

const refundSchema = z.strictObject({
  reason: reasonSchema,
  // omitted: everything still refundable
  amount: z.coerce.number().int().positive().optional(),
  requestKey: requestKeySchema,
});

// POST /admin/reservations/:nodeId/refund
// A further refund of a reservation that is over without a visit the doctor
// was paid for (cancelled, noShow or error with no payout). Never more than
// what the booker paid minus what already came back.
export const refundReservationByAdmin: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = refundSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const input = parsed.data;
    await withReservation(req.params.nodeId, async (r) => {
      if (!["cancelled", "noShow", "error"].includes(r.status))
        throw new AppError("بازپرداخت فقط برای نوبت لغوشده، غیبت یا خطا ممکن است", 400);
      const money = await moneyOf(r);
      if (money.doctorPaid > 0)
        throw new AppError("مبلغ این نوبت به پزشک تسویه شده است؛ برای بازپرداخت از «حل وضعیت» استفاده کنید", 400);
      const amount = input.amount ?? money.refundable;
      if (amount <= 0 || amount > money.refundable)
        throw new AppError("مبلغ بازپرداخت باید بیشتر از صفر و حداکثر برابر مبلغ قابل بازپرداخت باشد", 400);
      const { duplicate } = await refundToBooker(r, amount, req.user!._id, input.reason, input.requestKey);
      if (duplicate) return;
      await logAction(r._id, { action: "refund", by: req.user!._id as any, reason: input.reason, amount });
      notify([
        {
          user: bookerOf(r),
          title: "بازپرداخت نوبت",
          message: `${amount.toLocaleString("fa-IR")} تومان بابت نوبت شما به کیف پولتان برگشت.`,
          link: `/dashboard/booking/${r._id}`,
        },
      ]);
    });
    res.status(200).json({ message: "refundReservationByAdmin" });
  },
);

// ---------------------------------------------------------------- resolve

const resolveSchema = z.strictObject({
  // refund:   the visit did not happen through the patient's fault - give
  //           back what is left and take back a no-show payout if one was made
  // complete: the visit did happen - mark it done and pay the doctor
  // accept:   the automatic outcome stands; just mark it handled
  action: z.enum(["refund", "complete", "accept"]),
  reason: reasonSchema,
  requestKey: requestKeySchema,
});

// POST /admin/reservations/:nodeId/resolve
export const resolveReservationByAdmin: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = resolveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const input = parsed.data;
    await withReservation(req.params.nodeId, async (r) => {
      if (r.status !== "noShow" && r.status !== "error")
        throw new AppError("فقط نوبت‌های «غیبت» یا «خطا» نیاز به حل وضعیت دارند", 400);
      const actions = await Reservation.findById(r._id).select("+adminActions").lean();
      if ((actions?.adminActions || []).some((a) => a.action.startsWith("resolve")))
        throw new AppError("وضعیت این نوبت قبلاً حل شده است", 400);
      const money = await moneyOf(r);
      const by = req.user!._id as any;

      if (input.action === "refund") {
        let reversed = 0;
        if (money.doctorPaid > 0) {
          const doctorUser = doctorUserOf(r);
          if (!doctorUser) throw new AppError("پزشک این نوبت حساب کاربری ندارد", 400);
          try {
            const result = await moveWalletMoneyByAdmin({
              user: doctorUser,
              amount: -money.doctorPaid,
              action: "payoutReversal",
              adminBy: by,
              note: input.reason,
              requestKey: `${input.requestKey}:reversal`,
              extra: { reservation: r._id, doctor: (r.doctor as any)?._id ?? r.doctor },
            });
            if (!result.duplicate) reversed = money.doctorPaid;
          } catch (err) {
            if (err instanceof AppError && err.statusCode === 400)
              throw new AppError("موجودی کیف پول پزشک برای برگشت تسویه‌ی این نوبت کافی نیست", 400);
            throw err;
          }
        }
        let refunded = 0;
        if (money.refundable > 0) {
          const result = await refundToBooker(r, money.refundable, by, input.reason, input.requestKey);
          if (!result.duplicate) refunded = money.refundable;
        }
        await logAction(r._id, {
          action: "resolveRefund",
          by,
          reason: input.reason,
          amount: refunded,
          reversedPayout: reversed,
        });
        notify([
          ...(refunded > 0
            ? [
                {
                  user: bookerOf(r),
                  title: "بازپرداخت نوبت",
                  message: `${refunded.toLocaleString("fa-IR")} تومان بابت نوبت شما به کیف پولتان برگشت.`,
                  link: `/dashboard/booking/${r._id}`,
                },
              ]
            : []),
          ...(reversed > 0
            ? [
                {
                  user: doctorUserOf(r),
                  title: "تسویه‌ی یک نوبت برگشت خورد",
                  message: `پس از بررسی پشتیبانی، ${reversed.toLocaleString("fa-IR")} تومان تسویه‌ی این نوبت از کیف پول شما برگشت خورد.`,
                  link: `/doctorpanel/booking/${r._id}`,
                },
              ]
            : []),
        ]);
        return;
      }

      if (input.action === "complete") {
        if (money.refunded > 0)
          throw new AppError("مبلغ این نوبت به بیمار برگشت داده شده و نمی‌توان آن را انجام‌شده ثبت کرد", 400);
        if (money.paid <= 0)
          throw new AppError("پرداختی برای این نوبت ثبت نشده است", 400);
        if (!doctorUserOf(r))
          throw new AppError("پزشک این نوبت حساب کاربری ندارد", 400);
        // same idempotent payout the finalization sweep makes
        await handleReservationSuccess(r);
        await Reservation.updateOne(
          { _id: r._id, status: r.status },
          { $set: { status: "completed", finalizedAt: r.finalizedAt || new Date() }, $unset: { noShowParty: 1 } },
        );
        await logAction(r._id, { action: "resolveComplete", by, reason: input.reason });
        notify([
          {
            user: doctorUserOf(r),
            title: "نوبت انجام‌شده ثبت شد",
            message: "پس از بررسی پشتیبانی، این نوبت انجام‌شده ثبت و مبلغ آن به کیف پول شما واریز شد.",
            link: `/doctorpanel/booking/${r._id}`,
          },
        ]);
        return;
      }

      await logAction(r._id, { action: "resolveAccept", by, reason: input.reason });
    });
    res.status(200).json({ message: "resolveReservationByAdmin" });
  },
);

// ---------------------------------------------------------------- reschedule

// the doctor's sessions on that day for this reservation's session type,
// each marked free or taken (this reservation itself never blocks)
const slotsFor = async (r: IReservation, day: Date) => {
  const doctorId = (r.doctor as any)?._id ?? r.doctor;
  const [shifts, reservations] = await Promise.all([
    DoctorShift.find({
      doctor: doctorId,
      day: saturdayBasedDay(day.getDay()),
      sessionTypes: r.sessionType,
    })
      .populate({ path: "office", select: "name" })
      .lean(),
    Reservation.find({
      doctor: doctorId,
      status: { $ne: "cancelled" },
      date: { $gte: day, $lt: nextDay(day) },
      _id: { $ne: r._id },
    })
      .select("start end")
      .lean(),
  ]);
  const now = Date.now();
  return shifts
    .flatMap((shift: any) =>
      getShiftSessionBounds(shift).map(([start, end]) => ({
        start,
        end,
        office: shift.office || null,
        taken: reservations.some((x) => !(x.end <= start || x.start >= end)),
        past: day.getTime() + start * 60000 <= now,
      })),
    )
    .sort((a, b) => a.start - b.start);
};

// GET /admin/reservations/:nodeId/slots?date=YYYY-MM-DD
export const getRescheduleSlots: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError("نوبت"));
    const day = typeof req.query.date === "string" ? dayStart(req.query.date) : null;
    if (!day) return next(new BadInputError("date"));
    const reservation = await Reservation.findById(nodeId);
    if (!reservation) return next(new NotFoundError("نوبت"));
    const data = await slotsFor(reservation as unknown as IReservation, day);
    res.status(200).json({ message: "getRescheduleSlots", data: { data } });
  },
);

const rescheduleSchema = z.strictObject({
  date: z.string().min(8).max(40),
  start: z.coerce.number().int().min(0).max(24 * 60),
  end: z.coerce.number().int().min(0).max(24 * 60),
  reason: reasonSchema,
});

// POST /admin/reservations/:nodeId/reschedule
// Moves a pending reservation to another free session of the same doctor
// and session type (the same checks as booking). The price paid is kept.
export const rescheduleReservationByAdmin: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = rescheduleSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const input = parsed.data;
    const day = dayStart(input.date);
    if (!day) return next(new BadInputError("date"));
    await withReservation(req.params.nodeId, async (r) => {
      if (r.status !== "pending")
        throw new AppError("فقط نوبتی که هنوز برگزار نشده را می‌توان جابه‌جا کرد", 400);
      if (day.getTime() === new Date(r.date).getTime() && input.start === r.start && input.end === r.end)
        throw new AppError("زمان جدید با زمان فعلی نوبت یکی است", 400);
      const slots = await slotsFor(r, day);
      const slot = slots.find((s) => s.start === input.start && s.end === input.end);
      if (!slot) throw new NotFoundError("نوبت");
      if (slot.past) throw new AppError("ساعت این نوبت گذشته است", 400);
      if (slot.taken) throw new AppError("این جلسه قبلا رزرو شده است", 400);
      const from = { date: r.date, start: r.start, end: r.end };
      const moved = await Reservation.findOneAndUpdate(
        { _id: r._id, status: "pending" },
        {
          $set: {
            date: day,
            start: slot.start,
            end: slot.end,
            ...(slot.office?._id ? { office: slot.office._id } : {}),
          },
          // the reminder / nudges belong to the old time
          $unset: {
            reminderSentAt: 1,
            reminderError: 1,
            doctorNoShowNudgeSentAt: 1,
            patientNoShowNudgeSentAt: 1,
            dispatchError: 1,
          },
        },
      );
      if (!moved)
        throw new AppError("فقط نوبتی که هنوز برگزار نشده را می‌توان جابه‌جا کرد", 400);
      // a booking may have taken the slot meanwhile: undo the move then
      const clash = await Reservation.exists({
        _id: { $ne: r._id },
        doctor: (r.doctor as any)?._id ?? r.doctor,
        status: { $ne: "cancelled" },
        date: { $gte: day, $lt: nextDay(day) },
        start: { $lt: slot.end },
        end: { $gt: slot.start },
      });
      if (clash) {
        await Reservation.updateOne(
          { _id: r._id },
          { $set: { date: from.date, start: from.start, end: from.end, office: (r.office as any)?._id ?? r.office } },
        );
        throw new AppError("این جلسه قبلا رزرو شده است", 400);
      }
      await logAction(r._id, {
        action: "reschedule",
        by: req.user!._id as any,
        reason: input.reason,
        fromDate: from.date,
        fromStart: from.start,
        fromEnd: from.end,
      });
      const doctor = await DoctorProfile.findById((r.doctor as any)?._id ?? r.doctor);
      if (doctor) {
        updateDoctorAvailability({ doctor, startDate: from.date, endDate: from.date }).catch(() => {});
        updateDoctorAvailability({ doctor, startDate: day, endDate: day }).catch(() => {});
      }
      const when = `${day.toLocaleDateString("fa-IR-u-ca-persian")} ${hhmm(slot.start)}`;
      notify([
        {
          user: bookerOf(r),
          title: "زمان نوبت شما تغییر کرد",
          message: `نوبت شما توسط پشتیبانی به ${when} منتقل شد.`,
          link: `/dashboard/booking/${r._id}`,
        },
        {
          user: doctorUserOf(r),
          title: "زمان یک نوبت تغییر کرد",
          message: `یک نوبت توسط پشتیبانی به ${when} منتقل شد.`,
          link: `/doctorpanel/booking/${r._id}`,
        },
      ]);
    });
    res.status(200).json({ message: "rescheduleReservationByAdmin" });
  },
);
