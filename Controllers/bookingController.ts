import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";

import * as z from "zod";
import DoctorSession, {
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
import Invoice from "../Models/Invoice";
import UserIdentity, { IUserIdentity } from "../Models/UserIdentity";
import Relative from "../Models/Relative";
import { datish } from "../Lib/helpers";
import { dateStartOfDay, saturdayBasedDay, todayStart } from "../Lib/dateUtils";
import Doctor from "../Models/Doctor";
import DoctorShift, { IDoctorShift } from "../Models/DoctorShift";
import { getShiftSessionBounds } from "../Lib/shiftUtils";
import Reservation from "../Models/Reservation";
import PhoneConsultSettings from "../Models/DoctorPhoneConsultSettings";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import DoctorProfile from "../Models/DoctorProfile";
import updateDoctorAvailability from "../Lib/updateDoctorAvailablity";

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

const submitBookingSchema = z.strictObject({
  session: z.string(),
  kind: z.enum(doctorSessionTypes),
  patient: z.string().optional(),
});
export const submitABooking: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await submitBookingSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(data.session)) return next(new BadInputError());
    if (data.patient && !isValidObjectId(data.patient))
      return next(new BadInputError());
    let patient: IUserIdentity | null | undefined;
    if (data.patient) {
      const node = await Relative.findOne({
        user: req.user._id,
        other: data.patient,
      });
      if (!node) return next(new NotFoundError());
      patient = await UserIdentity.findById(node.other._id);
    } else {
      patient = await UserIdentity.findOne({ user: req.user._id });
    }
    if (!patient)
      return next(new AppError("اطلاعات هویتی بیمار یافت نشد", 400));
    const session = await DoctorSession.findById(data.session).populate([
      {
        path: "booking",
      },
      { path: "doctor" },
    ]);
    if (!session) return next(new BadInputError());
    if (!session.doctor.user)
      return next(new AppError("این پزشک با نویان قطع همکاری کرده", 400));
    if (req.user._id.toString() === session.doctor.user._id.toString())
      return next(new AppError("امکان رزرو برای خودتان وجود ندارد", 400));
    if (!!session.booking)
      return next(new AppError("این جلسه قبلا رزرو شده است.", 400));
    if (!session[data.kind])
      return next(new AppError("روش انتخابی برای این جلسه موجود نیست", 400));
    const settings = await doctorSessionKindSettingsModelDict[
      data.kind
    ].findOneAndUpdate(
      {
        doctor: session.doctor._id,
      },
      { doctor: session.doctor._id },
      { upsert: true, new: true },
    );
    if (!settings.active || !settings.price)
      return next(
        new AppError("این پزشک در حال حاضر امکان رزرو وقت ندارد", 400),
      );
    const invoice = await Invoice.create({
      session: session._id,
      sessionKind: data.kind,
      user: req.user._id,
      total: settings.price,
      patient: patient._id,
    });
    res.status(200).json({ message: "submitABooking", data: invoice });
  },
);

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
      const isRelative = Relative.exists({
        user: req.user._id,
        other: patient._id,
      });
      if (!isRelative) return next(new NotFoundError("بیمار"));
    }
    if (!isValidObjectId(data.doctor)) return next(new BadInputError());
    const doctor = await DoctorProfile.findById(data.doctor);
    if (!doctor) return next(new NotFoundError("پزشک"));
    if (todaysStart.getTime() === thenStart.getTime()) {
      const nowHour = new Date().getHours();
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
    const wallet = await Wallet.findOneAndUpdate(
      { user: req.user._id },
      { user: req.user._id },
      { upsert: true, new: true },
    );
    if (wallet.balance < price)
      return next(new AppError("موجودی شما کافی نیست", 400));
    await Wallet.findByIdAndUpdate(wallet._id, { $inc: { balance: -price } });
    const transaction = await Transaction.create({
      user: req.user._id,
      amount: -price,
    });
    await Reservation.create({
      user: req.user._id,
      patient: patient._id,
      doctor: doctor._id,
      date: thenStart,
      transaction: transaction._id,
      start: session[0],
      end: session[1],
      office: shift.office._id,
      sessionType: data.sessionType,
    });
    res.status(200).json({ message: "submitBookingNew" });
    await updateDoctorAvailability({
      doctor: doctor,
      startDate: thenStart,
      endDate: thenStart,
    });
  },
);
