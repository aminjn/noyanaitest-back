import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  DoctorsOnlyError,
  MiddlewareError,
  NotFoundError,
} from "../Lib/AppError";
import BecomeDoctorRequest, {
  genders,
  medicalSystemTitles,
} from "../Models/BecomeDoctorRequest";
import * as z from "zod";
import { provinces, provinceSlugs } from "../Lib/Provinces";
import { cities, citySlugs } from "../Lib/Cities";
import { isValidObjectId } from "mongoose";
import Speciality from "../Models/Speciality";
import DoctorProfile from "../Models/DoctorProfile";

export const becomeDoctor: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const pending = await BecomeDoctorRequest.exists({
      user: req.user._id,
      status: "Pending",
    });
    if (pending)
      return next(
        new AppError("درخواست شما قبلا ثبت شده در دست بررسی میباشد", 411)
      );
    const becomeDoctorSchema = z.strictObject({
      firstName: z.string().trim().min(1),
      lastName: z.string().trim().min(1),
      ssid: z.string().trim().length(10),
      gender: z.enum(genders),
      medicalSystemTitle: z.enum(medicalSystemTitles),
      medicalSystemCode: z.string().min(1),
      province: z.enum(provinceSlugs),
      city: z.enum(citySlugs),
      address: z.string().trim().min(1),
      description: z.string().optional(),
      specialities: z.array(z.string()).min(1),
    });
    const { data, success } = becomeDoctorSchema.safeParse(req.body);
    if (!success) return next(new BadInputError());
    const province = provinces.find((el) => el.slug === data.province);
    const city = cities.find((el) => el.slug === data.city);
    if (!city || !province || city.province_id !== province.id)
      return next(new BadInputError());
    const uniqueIds = new Set(data.specialities);
    if (uniqueIds.size !== data.specialities.length)
      return next(new BadInputError());
    for (let i = 0; i < data.specialities.length; ++i) {
      const _id = data.specialities[i];
      if (!isValidObjectId(_id)) return next(new BadInputError());
      const exists = await Speciality.exists({ _id });
      if (!exists) return next(new NotFoundError());
    }
    await BecomeDoctorRequest.findOneAndUpdate(
      { user: req.user._id },
      {
        ...data,
        user: req.user._id,
        status: "Pending",
      },
      { upsert: true }
    );
    res.status(200).json({ message: "becomeDoctor" });
    return;
  }
);

export const getMyBecomeDoctorRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await BecomeDoctorRequest.findOne({ user: req.user._id });
    res
      .status(200)
      .json({ message: "getMyBecomeDoctorRequest", data: { data } });
  }
);

export const getMyDoctorProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await DoctorProfile.findOne({ user: req.user });
    if (!data) return next(new DoctorsOnlyError());
    res.status(200).json({ message: "getMyDoctorProfile", data: { data } });
  }
);
