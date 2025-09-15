import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  AccessError,
  BadInputError,
  MiddlewareError,
} from "../Lib/AppError";
import Clinic from "../Models/Clinic";
import * as z from "zod";
import BecomeClinicRequest from "../Models/BecomeClinicRequest";

const becomeClinicRequestSchema = z.strictObject({ name: z.string() });
export const becomeAClinic: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await becomeClinicRequestSchema.safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    const cur = await Clinic.findOne({ user: req.user._id });
    if (!!cur) return next(new AppError("شما قبلا کلینیک شده اید", 409));
    const pending = await BecomeClinicRequest.findOne({
      user: req.user._id,
      status: "Pending",
    });
    if (pending) return next(new AppError("درخواست شما قبلا ثبت شده است", 409));
    await BecomeClinicRequest.findOneAndUpdate(
      { user: req.user._id },
      {
        ...data,
        user: req.user._id,
        status: "Pending",
      },
      { upsert: true }
    );
    res.status(200).json({ message: "becomeAClinic" });
  }
);

export const getMyBecomeClinicRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await BecomeClinicRequest.findOne({ user: req.user._id });
    res.status(200).json({ message: "getMyBecomeClinicRequest", data });
  }
);

export const getMyClinicProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.clinic) return next(new MiddlewareError());
    const data = await Clinic.findById(req.clinic._id);
    if (!data) return next(new AccessError());
    res.status(200).json({ message: "getMyClinicProfile", data });
  }
);
