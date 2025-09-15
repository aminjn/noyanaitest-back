import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  AccessError,
  BadInputError,
  MiddlewareError,
} from "../Lib/AppError";
import * as z from "zod";
import Pharmacy from "../Models/Pharmacy";
import BecomePharmacyRequest from "../Models/BecomePharmacyRequest";

const becomePharmacyRequestSchema = z.strictObject({ name: z.string() });
export const becomeAPharmacy: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await becomePharmacyRequestSchema.safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    const cur = await Pharmacy.findOne({ user: req.user._id });
    if (!!cur) return next(new AppError("شما قبلا داروخانه شده اید", 409));
    const pending = await BecomePharmacyRequest.findOne({
      user: req.user._id,
      status: "Pending",
    });
    if (pending) return next(new AppError("درخواست شما قبلا ثبت شده است", 409));
    await BecomePharmacyRequest.findOneAndUpdate(
      { user: req.user._id },
      {
        ...data,
        user: req.user._id,
        status: "Pending",
      },
      { upsert: true }
    );
    res.status(200).json({ message: "becomeAPharmacy" });
  }
);

export const getMyBecomePharmacyRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await BecomePharmacyRequest.findOne({ user: req.user._id });
    res.status(200).json({ message: "getMyBecomePharmacyRequest", data });
  }
);

export const getMyPharmacyProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const data = await Pharmacy.findById(req.pharmacy._id);
    if (!data) return next(new AccessError());
    res.status(200).json({ message: "getMyPharmacyProfile", data });
  }
);
