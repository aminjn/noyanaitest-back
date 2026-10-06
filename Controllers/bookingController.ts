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
import { calcTax, getVisitTaxPercent } from "../Lib/taxSettings";
import Office from "../Models/Office";
import { bookingDiscountFor } from "../Lib/patientPro";
import { blockedOn, overlapsBlocked } from "../Lib/timeOff";
import { ensureDoctorPatient } from "../Lib/doctorPatient";

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
    // an in-person visit in a clinic office is taxed at the clinic's rate
    const office =
      data.sessionType === "inPerson" && shift.office
        ? await Office.findById(shift.office).select("clinic hospital")
        : null;
    const visitTaxPercent = await getVisitTaxPercent(doctor._id, office);
    const tax = calcTax(price, visitTaxPercent);
    // «پرو» (2026-10, Lib/patientPro.ts): the member's discount comes off
    // what the wallet pays; subtotal stays the doctor's price, so the
    // payout (Services/reservationProgressService.ts) does not change
    const { discount: proDiscount } = await bookingDiscountFor({
      userId: req.user._id,
      price,
      sessionType: data.sessionType,
      doctorId: doctor._id,
      forRelative: req.user._id.toString() !== patient.user?._id.toString(),
    });
    const total = Math.max(0, price + tax - proDiscount);
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
      ...(proDiscount > 0 ? { proDiscount } : {}),
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
    // the patient shows in the doctor's patient list straight away (it was
    // only filled by a boot-time migration before)
    await ensureDoctorPatient(req.user._id, doctor._id);
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
