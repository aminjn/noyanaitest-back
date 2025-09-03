import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";

import * as z from "zod";
import DoctorSession, {
  DoctorSessionType,
  doctorSessionTypes,
} from "../Models/DoctorSession";
import AppError, { BadInputError, MiddlewareError } from "../Lib/AppError";
import { isValidObjectId, Model } from "mongoose";
import InPersonSettings from "../Models/InPersonSettings";
import SipCallSettings from "../Models/SipCallSettings";
import TextChatSettings from "../Models/TextChatSettings";
import VideoCallSettings from "../Models/VideoCallSettings";
import VoiceCallSettings from "../Models/voiceCallSetrtings";
import Invoice from "../Models/Invoice";

export const doctorSessionKindSettingsModelDict: Record<
  DoctorSessionType,
  Model<any>
> = {
  inPerson: InPersonSettings,
  sipCall: SipCallSettings,
  textChat: TextChatSettings,
  videoCall: VideoCallSettings,
  voiceCall: VoiceCallSettings,
} as const;

const submitBookingSchema = z.strictObject({
  session: z.string(),
  kind: z.enum(doctorSessionTypes),
});
export const submitABooking: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await submitBookingSchema.safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(data.session)) return next(new BadInputError());
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
      return next(new AppError("بازار خیلی خرابه؟", 400));
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
      { upsert: true, new: true }
    );
    if (!settings.active || !settings.price)
      return next(
        new AppError("این پزشک در حال حاضر امکان رزرو وقت ندارد", 400)
      );
    const invoice = await Invoice.create({
      session: session._id,
      sessionKind: data.kind,
      user: req.user._id,
      total: settings.price,
    });
    res.status(200).json({ message: "submitABooking", data: invoice });
  }
);
