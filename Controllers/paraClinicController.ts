import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import * as z from "zod";
import AppError, {
  AccessError,
  BadInputError,
  MiddlewareError,
} from "../Lib/AppError";
import ParaClinic from "../Models/Paraclinic";
import BecomeParaClinicRequest from "../Models/BecomeParaClinicRequest";

const becomeAParaClinicSchema = z.strictObject({ name: z.string() });
export const becomeAParaClinic: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success, error } =
      await becomeAParaClinicSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError(error.message));
    const cur = await ParaClinic.findOne({ user: req.user._id });
    if (!!cur) return next(new AppError("شما قبلا پاراکلینیک شده اید", 409));
    const pending = await BecomeParaClinicRequest.findOne({
      user: req.user._id,
      status: "Pending",
    });
    if (pending) return next(new AppError("درخواست شما قبلا ثبت شده است", 409));
    await BecomeParaClinicRequest.findOneAndUpdate(
      { user: req.user._id },
      {
        ...data,
        user: req.user._id,
        status: "Pending",
      },
      { upsert: true },
    );
    res.status(200).json({ message: "becomeAParaClinic" });
  },
);

export const getMyBecomeParaClinicRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await BecomeParaClinicRequest.findOne({ user: req.user._id });
    res.status(200).json({ message: "getMyBecomeParaClinicRequest", data });
  },
);

export const getMyParaClinicProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const data = await ParaClinic.findById(req.paraClinic._id);
    if (!data) return next(new AccessError());
    res.status(200).json({ message: "getMyParaClinicProfile", data });
  },
);
