import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";

import * as z from "zod";
import {
  DoctorSessionType,
  doctorSessionTypes,
} from "../Models/DoctorSession";
import AppError, {
  BadInputError,
  MiddlewareError,
  NotFoundError,
} from "../Lib/AppError";
import { isValidObjectId, Model } from "mongoose";
import InPersonSettings from "../Models/InPersonSettings";
import SipCallSettings from "../Models/SipCallSettings";
import TextChatSettings from "../Models/TextChatSettings";
import VideoCallSettings from "../Models/VideoCallSettings";
import VoiceCallSettings from "../Models/voiceCallSetrtings";
import UserIdentity from "../Models/UserIdentity";
import UserRelative from "../Models/UserRelative";
import { datish } from "../Lib/helpers";
import { dateStartOfDay, todayStart } from "../Lib/dateUtils";
import { addTehranDays, tehranParts, tehranSaturdayDay } from "../Lib/tehranTime";
import DoctorShift, { IDoctorShift } from "../Models/DoctorShift";
import { getShiftSessionBounds } from "../Lib/shiftUtils";
import Reservation, { IReservation } from "../Models/Reservation";
import PhoneConsultSettings from "../Models/DoctorPhoneConsultSettings";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import DoctorProfile from "../Models/DoctorProfile";
import updateDoctorAvailability from "../Lib/updateDoctorAvailablity";
import { notifyNewReservation } from "../Services/reservationSmsService";
import { blockedOn, overlapsBlocked } from "../Lib/timeOff";
import { ensureDoctorPatient } from "../Lib/doctorPatient";
import BizClubRedemption from "../Models/BizClubRedemption";
import { bookableDays, quoteBooking, releaseClubCode } from "../Lib/bookingFlow";
import { closeWaitlistOnBooking } from "../Lib/waitlist";
import { InsurancePick, rememberInsurances } from "../Lib/insuranceTariffs";

// the insurances of a quote or a booking: [{insurance, plan?}] (at most a
// basic and a supplementary one)
const insurancePicksSchema = z
  .array(
    z.object({
      insurance: z.string().regex(/^[0-9a-fA-F]{24}$/),
      plan: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
    }),
  )
  .max(2)
  .optional();

const picksOf = (list?: { insurance: string; plan?: string | null }[], single?: string): InsurancePick[] => {
  const out: InsurancePick[] = (list || []).map((p) => ({ insurance: p.insurance, plan: p.plan || null }));
  if (single && !out.some((p) => p.insurance === single)) out.unshift({ insurance: single, plan: null });
  return out.slice(0, 2);
};

export const doctorSessionKindSettingsModelDict: Record<
  DoctorSessionType,
  Model<any>
> = {
  inPerson: InPersonSettings,
  sipCall: SipCallSettings,
  textChat: TextChatSettings,
  videoCall: VideoCallSettings,
  voiceCall: VoiceCallSettings,
  phone: PhoneConsultSettings,
} as const;

// submitABooking (System A: DoctorSession -> Invoice -> Booking, via
// settleInvoice) was removed as part of F-01 - the project decided to
// retire the old /doctors and /dr booking flow in favor of this file's
// submitBookingNew (System B: Reservation), which is the actively
// developed, feature-complete flow (wallet debit, transactions, lifecycle
// sweeps, presence tracking). See AUDIT/FIXES_TODO.md F-01.

const newSubmitBookingSchema = z.strictObject({
  doctor: z.string(),
  date: datish,
  start: z.coerce.number(),
  end: z.coerce.number(),
  // "phone" is retired (2026-10): a phone consult is booked as sipCall
  // (VoIP) or voiceCall (in-app call); old phone reservations still exist
  sessionType: z.enum(doctorSessionTypes).refine((t) => t !== "phone"),
  patient: z.string(),
  // "desk": paid at the visit (in-person only, 2026-10 booking redesign)
  method: z.enum(["wallet", "desk"]),
  // the office the patient picked (an in-person doctor may have several)
  office: z.string().optional(),
  // a code of the doctor's patient club
  code: z.string().trim().max(40).optional(),
  // the insurance they will use (one the doctor accepts)
  insurance: z.string().optional(),
  // (2026-10) the insurances they will use, with their plan: at most one
  // basic and one supplementary (Lib/insuranceTariffs.ts)
  insurances: insurancePicksSchema,
});

const doctorSessionSettings = [
  SipCallSettings,
  PhoneConsultSettings,
  VoiceCallSettings,
  VideoCallSettings,
  InPersonSettings,
  TextChatSettings,
] as const;

type DoctorSessionSettings = (typeof doctorSessionSettings)[number];

const sesstionTypeToDoctorSettings: Record<
  DoctorSessionType,
  DoctorSessionSettings
> = {
  inPerson: InPersonSettings,
  sipCall: SipCallSettings,
  textChat: TextChatSettings,
  videoCall: VideoCallSettings,
  phone: PhoneConsultSettings,
  voiceCall: VoiceCallSettings,
};

export const submitBookingNew: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, error, success } =
      await newSubmitBookingSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError(error.message));
    // the Tehran day the patient picked ("YYYY-MM-DD" from the page, or an
    // older client's device midnight), at its Tehran midnight
    const todaysStart = todayStart();
    const thenStart = dateStartOfDay(data.date);
    const thenStartTomorrow = addTehranDays(thenStart, 1);
    if (thenStart < todaysStart)
      return next(new BadInputError("امکان ثبت نوبت در روز گذشته وجود ندارد"));
    if (!isValidObjectId(data.patient)) return next(new BadInputError());
    const patient = await UserIdentity.findById(data.patient);
    if (!patient) return next(new NotFoundError());
    if (req.user._id.toString() !== patient.user?._id.toString()) {
      // Bug fix (2026-09): this used to query the dead `Relative` model
      // (nothing ever writes to it - Controllers/userController.ts's
      // addRelative only ever creates `UserRelative` docs) and never
      // `await`ed the call, so `isRelative` was always a truthy Promise and
      // this check silently passed for everyone. Querying the real
      // collection and awaiting it makes this an actual ownership check:
      // a booking for someone else's identity is only allowed once that
      // identity has been added as a relative via POST /user/relative.
      const isRelative = await UserRelative.exists({
        user: req.user._id,
        other: patient._id,
      });
      if (!isRelative) return next(new NotFoundError("بیمار"));
    }
    if (!isValidObjectId(data.doctor)) return next(new BadInputError());
    // a deactivated doctor is hidden everywhere - and not bookable by API
    // an unclaimed profile (imported directory entry) has no one to take
    // the visit - it is listed, not bookable
    const doctor = await DoctorProfile.findOne({
      _id: data.doctor,
      active: true,
      claimed: { $ne: false },
      // suspended by an admin (Lib/providerStatus.ts also holds `active`
      // false while suspended; checked here too, explicitly)
      status: { $ne: "suspended" },
    });
    if (!doctor) return next(new NotFoundError("پزشک"));
    const blocked = await blockedOn(doctor._id, thenStart);
    if (blocked.wholeDay)
      return next(new AppError("پزشک در این روز نوبت نمی‌دهد", 400));
    if (overlapsBlocked(blocked.ranges, data.start, data.end))
      return next(new AppError("پزشک این ساعت را برای نوبت بسته است", 400));
    if (todaysStart.getTime() === thenStart.getTime()) {
      // shift minutes are Tehran wall-clock time, whatever the server's zone
      const nowHour = tehranParts().hour;
      if (nowHour >= Math.floor(data.start / 60))
        return next(new AppError("ساعت این نوبت گذشته است", 400));
    }
    const shift = await DoctorShift.findOne({
      doctor: doctor._id,
      day: tehranSaturdayDay(thenStart),
      start: { $lte: data.start },
      end: { $gte: data.end },
      sessionTypes: data.sessionType,
      ...(data.office && isValidObjectId(data.office) ? { office: data.office } : {}),
    });
    if (!shift) return next(new NotFoundError("شیفت"));
    if (data.method === "desk" && data.sessionType !== "inPerson")
      return next(new AppError("پرداخت در مطب فقط برای ویزیت حضوری است", 400));
    // the insurances picked (the older single field is the same as one
    // pick); each must be accepted by the doctor or the office's centre -
    // checked by the quote below
    const picks = picksOf(data.insurances, data.insurance);
    if (picks.some((p) => !isValidObjectId(p.insurance)))
      return next(new AppError("این بیمه طرف قرارداد این پزشک نیست", 400));
    const sessions = getShiftSessionBounds(shift);
    const session = sessions.find(
      (s) => s[0] === data.start && s[1] === data.end,
    );
    if (!session) return next(new NotFoundError("نوبت"));
    const taken = await Reservation.exists({
      doctor: doctor._id,
      // a cancelled booking no longer holds its slot
      status: { $ne: "cancelled" },
      start: session[0],
      end: session[1],
      date: { $gte: thenStart, $lt: thenStartTomorrow },
    });
    if (taken) return next(new AppError("این جلسه قبلا رزرو شده است", 400));
    // one price rule for the quote the page showed and the booking
    // (Lib/bookingFlow.ts): the doctor's price, their club code, the visit
    // tax, then the «پرو» member's discount
    const forRelative = req.user._id.toString() !== patient.user?._id.toString();
    const quote = await quoteBooking({
      doctorId: doctor._id,
      sessionType: data.sessionType,
      office: String(shift.office._id ?? shift.office),
      user: req.user,
      forRelative,
      code: data.code,
      insurances: picks,
      patient: patient._id,
      at: thenStart,
    });
    if (!quote)
      return next(
        new AppError("این پزشک قابلیت دریافت جلسه با این تایپ را ندارد", 400),
      );
    if (data.code && !quote.redemption)
      return next(new AppError(quote.code?.error || "این کد باشگاه پیدا نشد", 400));
    if (quote.insurance.notAccepted.some((n) => picks.some((p) => p.insurance === n._id)))
      return next(new AppError("این بیمه طرف قرارداد این پزشک نیست", 400));
    if (quote.insurance.error) return next(new AppError(quote.insurance.error, 400));
    // the doctor may have turned pay at the desk off (Lib/payAtDesk.ts)
    if (data.method === "desk" && !quote.payAtDesk)
      return next(new AppError("پرداخت در مطب برای این پزشک فعال نیست", 400));
    const atDesk = data.method === "desk";
    const total = atDesk ? 0 : quote.total;
    const wallet = await Wallet.findOneAndUpdate(
      { user: req.user._id },
      { user: req.user._id },
      { upsert: true, new: true },
    );
    if (!atDesk && wallet.balance < total)
      return next(new AppError("موجودی شما کافی نیست", 400));
    // Create the reservation before any money moves - if this throws (e.g. a
    // concurrent booking just took the slot), the wallet is never touched.
    // See AUDIT/FIXES_TODO.md F-03.
    const reservation = await Reservation.create({
      user: req.user._id,
      patient: patient._id,
      doctor: doctor._id,
      date: thenStart,
      start: session[0],
      end: session[1],
      office: shift.office._id,
      sessionType: data.sessionType,
      // paid at the desk: nothing online (like a desk booking), the desk
      // collects deskFee
      subtotal: atDesk ? 0 : quote.price,
      tax: atDesk ? 0 : quote.tax,
      total,
      ...(atDesk ? { payAtDesk: true, deskFee: quote.deskTotal } : {}),
      ...(!atDesk && quote.proDiscount > 0 ? { proDiscount: quote.proDiscount } : {}),
      ...(quote.clubDiscount > 0
        ? { clubDiscount: quote.clubDiscount, clubRedemption: quote.redemption?._id }
        : {}),
      // the insurers' estimated shares, as the patient saw them: paid
      // online they are the doctor's receivable once the visit is done
      // (Services/reservationProgressService.ts); at the desk only shown
      ...(quote.insurance.lines.length
        ? {
            insurance: quote.insurance.lines[0].insurance,
            insurances: quote.insurance.lines.map((l) => l.insurance),
            insuranceQuote: {
              price: quote.price,
              net: Math.max(0, quote.price - quote.clubDiscount),
              insurerShare: quote.insurance.insurerShare,
              patientShare: quote.insurance.patientShare,
              lines: quote.insurance.lines.map((l) => ({
                ...l,
                status: l.share <= 0 ? "none" : atDesk ? "desk" : "pending",
              })),
              at: new Date(),
            },
          }
        : {}),
      status: "pending",
    });
    // a parallel booking may have taken the slot meanwhile
    const clash = await Reservation.exists({
      _id: { $ne: reservation._id },
      doctor: doctor._id,
      status: { $ne: "cancelled" },
      date: { $gte: thenStart, $lt: thenStartTomorrow },
      start: { $lt: session[1] },
      end: { $gt: session[0] },
    });
    if (clash) {
      await Reservation.deleteOne({ _id: reservation._id });
      return next(new AppError("این جلسه قبلا رزرو شده است", 400));
    }
    // the club code is spent on this booking (claimed once: a second
    // booking with the same code loses the race and is undone)
    if (quote.redemption) {
      const claimed = await BizClubRedemption.updateOne(
        { _id: quote.redemption._id, status: "issued" },
        {
          $set: {
            status: "used",
            usedAt: new Date(),
            reservation: reservation._id,
            discountAmount: quote.clubDiscount,
          },
        },
      );
      if (!claimed.modifiedCount) {
        await Reservation.deleteOne({ _id: reservation._id });
        return next(new AppError("این کد قبلاً استفاده یا لغو شده است", 400));
      }
    }
    if (!atDesk && total > 0) {
      // Debit atomically, re-checking the balance in the same update - this
      // closes the race between the read above and this write (two
      // concurrent bookings could otherwise both pass the check and
      // overdraw the wallet).
      const debitedWallet = await Wallet.findOneAndUpdate(
        { _id: wallet._id, balance: { $gte: total } },
        { $inc: { balance: -total } },
      );
      if (!debitedWallet) {
        if (quote.redemption) await releaseClubCode(reservation._id);
        await Reservation.deleteOne({ _id: reservation._id });
        return next(new AppError("موجودی شما کافی نیست", 400));
      }
    }
    if (!atDesk) {
      try {
        // Record the payment as a transaction pointing back at the booking
        // it paid for, then link the reservation to it (the doctor's payout
        // needs it, even when a discount made it free).
        const transaction = await Transaction.create({
          user: req.user._id,
          amount: -total,
          reservation: reservation._id,
        });
        reservation.transaction =
          transaction._id as unknown as IReservation["transaction"];
        await reservation.save();
      } catch (err) {
        // The debit already succeeded but nothing exists to show for it -
        // refund the wallet and remove the unpaid reservation instead of
        // leaving an orphaned debit with no Transaction/Reservation to
        // explain it. See AUDIT/FIXES_TODO.md F-03.
        if (total > 0)
          await Wallet.findByIdAndUpdate(wallet._id, { $inc: { balance: total } });
        if (quote.redemption) await releaseClubCode(reservation._id);
        await Reservation.deleteOne({ _id: reservation._id });
        throw err;
      }
    }
    // the patient shows in the doctor's patient list straight away (it was
    // only filled by a boot-time migration before)
    await ensureDoctorPatient(req.user._id, doctor._id);
    // the patient's wait for this doctor and visit type is over (Lib/waitlist.ts)
    closeWaitlistOnBooking(req.user._id, doctor._id, data.sessionType, reservation._id, {
      id: patient._id,
      self: !forRelative,
    });
    // the next booking starts with the same insurances
    if (picks.length)
      await rememberInsurances(
        patient._id,
        quote.insurance.lines.map((l) => ({ insurance: l.insurance, plan: l.plan || null })),
      );
    const final = await Reservation.findById(reservation._id);
    res.status(200).json({ message: "submitBookingNew", data: final });
    // Fire-and-forget: confirms the booking to the patient and alerts the
    // doctor of a new appointment. Needs doctor.user/user/patient populated
    // for phone-number lookups (reservation/final above are bare refs) - see
    // Services/reservationSmsService.ts.
    const reservationForSms = await Reservation.findById(
      reservation._id,
    ).populate([
      { path: "doctor", populate: { path: "user" } },
      { path: "user" },
      // patient.user is needed too: it's how notifyNewReservation tells a
      // self-booking from a booking-for-a-relative apart, and lets
      // patientPhone() reach a relative's own account phone even when their
      // UserIdentity.phones wasn't populated (e.g. they were linked via the
      // "already has an identity" branch of addRelative).
      { path: "patient", populate: { path: "user" } },
    ]);
    if (reservationForSms) {
      notifyNewReservation(reservationForSms).catch((err) =>
        console.log(
          `[bookingController] failed to send new-reservation SMS for reservation ${reservation._id}:`,
          err,
        ),
      );
    }
    await updateDoctorAvailability({
      doctor: doctor,
      startDate: thenStart,
      endDate: thenStart,
    });
  },
);

// GET /public/dr/:nodeId/slots?sessionType=&office=
// The free slots a patient can book, per Tehran day, for one visit type
// (and office): the same rules the booking checks (Lib/bookingFlow.ts), so
// the picker never offers a slot the API then refuses. `nextAvailable` is
// the first of them - the "first available" shortcut and the empty-day
// hint. Each day keeps the DoctorAvailability shape ({date, bounds}), so
// Components/Booking/availabilityDay.ts reads it as is.
const slotsQuerySchema = z.object({
  sessionType: z.enum(doctorSessionTypes).optional(),
  office: z.string().optional(),
});

export const getBookableSlots: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = slotsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return next(new BadInputError());
    const doctor = await DoctorProfile.findOne({
      _id: nodeId,
      active: true,
      claimed: { $ne: false },
      status: { $ne: "suspended" },
    }).select("_id");
    if (!doctor) return next(new NotFoundError("پزشک"));
    const { days, horizon } = await bookableDays({
      doctorId: doctor._id,
      sessionType: parsed.data.sessionType,
      office: parsed.data.office,
    });
    const first = days[0];
    res.status(200).json({
      message: "getBookableSlots",
      data: {
        days,
        horizon,
        nextAvailable: first
          ? { date: first.date, ymd: first.ymd, ...first.bounds[0] }
          : null,
      },
    });
  },
);

// POST /booking/quote {doctor, sessionType, office?, patient?, code?}
// What this booking costs this user, line by line - the checkout shows
// exactly what POST /booking/reserve will charge.
const quoteSchema = z.object({
  doctor: z.string(),
  sessionType: z.enum(doctorSessionTypes),
  office: z.string().optional(),
  patient: z.string().optional(),
  code: z.string().trim().max(40).optional(),
  // (2026-10) the insurances picked, and the visit's day (a tariff's
  // validity and monthly / yearly limits)
  insurances: insurancePicksSchema,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const getBookingQuote: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const parsed = quoteSchema.safeParse(req.body ?? {});
    if (!parsed.success || !isValidObjectId(parsed.data.doctor))
      return next(new BadInputError());
    const input = parsed.data;
    let forRelative = false;
    let patientId: unknown = null;
    if (input.patient && isValidObjectId(input.patient)) {
      const p = await UserIdentity.findById(input.patient).select("user");
      forRelative = !!p && String(p.user ?? "") !== String(req.user._id);
      // only the booker's own identity or a relative's (their saved
      // insurances and limits are read)
      if (p && (!forRelative || (await UserRelative.exists({ user: req.user._id, other: p._id })))) patientId = p._id;
    }
    const quote = await quoteBooking({
      doctorId: input.doctor,
      sessionType: input.sessionType,
      office: input.office,
      user: req.user,
      forRelative,
      code: input.code || undefined,
      insurances: picksOf(input.insurances),
      patient: patientId,
      at: input.date ? dateStartOfDay(input.date) : undefined,
    });
    if (!quote)
      return next(
        new AppError("این پزشک قابلیت دریافت جلسه با این تایپ را ندارد", 400),
      );
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { redemption, ...data } = quote;
    const wallet = await Wallet.findOne({ user: req.user._id }).select("balance");
    res.status(200).json({
      message: "getBookingQuote",
      data: { ...data, balance: wallet?.balance || 0 },
    });
  },
);
