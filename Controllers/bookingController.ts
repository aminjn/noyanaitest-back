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
import { dateStartOfDay, saturdayBasedDay, todayStart } from "../Lib/dateUtils";
import Doctor from "../Models/Doctor";
import DoctorShift, { IDoctorShift } from "../Models/DoctorShift";
import { getShiftSessionBounds } from "../Lib/shiftUtils";
import Reservation, { IReservation } from "../Models/Reservation";
import PhoneConsultSettings from "../Models/DoctorPhoneConsultSettings";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import DoctorProfile from "../Models/DoctorProfile";
import updateDoctorAvailability from "../Lib/updateDoctorAvailablity";
import { notifyNewReservation } from "../Services/reservationSmsService";
import { calcTax, getDoctorVisitTaxPercent } from "../Lib/taxSettings";

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
  sessionType: z.enum(doctorSessionTypes),
  patient: z.string(),
  method: z.enum(["wallet"]),
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
    const todaysStart = todayStart();
    const thenStart = dateStartOfDay(data.date);
    const thenStartTomorrow = new Date(thenStart);
    thenStartTomorrow.setDate(thenStartTomorrow.getDate() + 1);
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
    const doctor = await DoctorProfile.findOne({ _id: data.doctor, active: true });
    if (!doctor) return next(new NotFoundError("پزشک"));
    if (todaysStart.getTime() === thenStart.getTime()) {
      // shift minutes are Tehran wall-clock time, whatever the server's zone
      const nowHour = Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Tehran",
          hour: "2-digit",
          hourCycle: "h23",
        }).format(new Date()),
      );
      if (nowHour >= Math.floor(data.start / 60))
        return next(new AppError("ساعت این نوبت گذشته است", 400));
    }
    const shift = await DoctorShift.findOne({
      doctor: doctor._id,
      day: saturdayBasedDay(new Date(data.date).getDay()),
      start: { $lte: data.start },
      end: { $gte: data.end },
      sessionTypes: data.sessionType,
    });
    if (!shift) return next(new NotFoundError("شیفت"));
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
    const settings = await (
      sesstionTypeToDoctorSettings[data.sessionType] as Model<any>
    ).findOne({ doctor: doctor._id });
    if (!settings || !settings.active || !settings.price)
      return next(
        new AppError("این پزشک قابلیت دریافت جلسه با این تایپ را ندارد", 400),
      );
    const price: number = settings.price;
    // Visit tax (2026-09) - additive on top of the session price shown to
    // the patient throughout the flow; the price itself never changes. See
    // Lib/taxSettings.ts and Models/DoctorTaxSettings.ts's visitTaxPercent.
    const visitTaxPercent = await getDoctorVisitTaxPercent(doctor._id);
    const tax = calcTax(price, visitTaxPercent);
    const total = price + tax;
    const wallet = await Wallet.findOneAndUpdate(
      { user: req.user._id },
      { user: req.user._id },
      { upsert: true, new: true },
    );
    if (wallet.balance < total)
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
      subtotal: price,
      tax,
      total,
      status: "pending",
    });
    // Debit atomically, re-checking the balance in the same update - this
    // closes the race between the read above and this write (two concurrent
    // bookings could otherwise both pass the check and overdraw the wallet).
    const debitedWallet = await Wallet.findOneAndUpdate(
      { _id: wallet._id, balance: { $gte: total } },
      { $inc: { balance: -total } },
    );
    if (!debitedWallet) {
      await Reservation.deleteOne({ _id: reservation._id });
      return next(new AppError("موجودی شما کافی نیست", 400));
    }
    try {
      // Record the balance decrease as a transaction pointing back at the
      // booking it paid for, then link the reservation to it.
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
      // leaving an orphaned debit with no Transaction/Reservation to explain
      // it. See AUDIT/FIXES_TODO.md F-03.
      await Wallet.findByIdAndUpdate(wallet._id, { $inc: { balance: total } });
      await Reservation.deleteOne({ _id: reservation._id });
      throw err;
    }
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
