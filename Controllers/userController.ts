import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  MiddlewareError,
  NotFoundError,
} from "../Lib/AppError";
import User from "../Models/User";
import { isNonEmptyStrings, isUndefinedOrString } from "../Lib/validators";
import BecomeDoctorRequest, {
  genders,
  medicalSystemTitles,
} from "../Models/BecomeDoctorRequest";
import { provinces, provinceSlugs } from "../Lib/Provinces";
import { cities, citySlugs } from "../Lib/Cities";
import Speciality, { ISpeciality } from "../Models/Speciality";
import { isValidObjectId } from "mongoose";
import * as z from "zod";

export const getMe: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    res.status(200).json({ message: `getMe`, data: { data: req.user } });
  }
);
