import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  AccessError,
  BadInputError,
  MiddlewareError,
} from "../Lib/AppError";
import * as z from "zod";
import Insurance from "../Models/Insurance";
import BecomeInsuranceRequest from "../Models/BecomeInsuranceRequest";

const becomeInsuramceRequestSchema = z.strictObject({ name: z.string() });
export const becomeAInsurance: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await becomeInsuramceRequestSchema.safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    const cur = await Insurance.findOne({ user: req.user._id });
    if (!!cur) return next(new AppError("شما قبلا بیمه شده اید", 409));
    const pending = await BecomeInsuranceRequest.findOne({
      user: req.user._id,
      status: "Pending",
    });
    if (pending) return next(new AppError("درخواست شما قبلا ثبت شده است", 409));
    await BecomeInsuranceRequest.findOneAndUpdate(
      { user: req.user._id },
      {
        ...data,
        user: req.user._id,
        status: "Pending",
      },
      { upsert: true }
    );
    res.status(200).json({ message: "becomeAInsurance" });
  }
);

export const getMyBecomeInsuranceRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await BecomeInsuranceRequest.findOne({ user: req.user._id });
    res.status(200).json({ message: "getMyBecomeInsuranceRequest", data });
  }
);

export const getMyInsuranceProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const data = await Insurance.findById(req.insurance._id);
    if (!data) return next(new AccessError());
    res.status(200).json({ message: "getMyInsuranceProfile", data });
  }
);
