import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  BadTimingError,
  MiddlewareError,
  NotFoundError,
} from "../Lib/AppError";
import DoctorSecretaryRequest from "../Models/DoctorSecretaryRequest";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import DoctorSecretary from "../Models/DoctorSecretary";
import { cookieBuilder } from "./authController";

export const getMyDoctors: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await DoctorSecretary.find({
      secretary: req.user._id,
    }).populate({ path: "doctor" });
    res.status(200).json({ message: "getMyDoctors", data });
  }
);

export const leaveDoctor: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await DoctorSecretary.findOne({
      _id: nodeId,
      secretary: req.user._id,
    });
    if (!node) return next(new NotFoundError());
    await DoctorSecretary.findByIdAndDelete(nodeId);
    res.status(200).json({ message: "leaveDoctor" });
  }
);

export const mountDoctor: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await DoctorSecretary.findOne({
      _id: nodeId,
      secretary: req.user._id,
    });
    if (!node) return next(new NotFoundError());
    cookieBuilder({ name: "doctor", id: node._id.toString(), res });
    res.status(200).json({ message: "mountDoctor" });
  }
);

export const getMyDoctorRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await DoctorSecretaryRequest.find({
      phone: req.user.phone,
    }).populate({ path: "doctor" });
    res.status(200).json({ message: "getMyDoctorRequests", data });
  }
);

const toggleDoctorRequestStatusSchema = z.strictObject({
  status: z.enum(["Approved", "Rejected"]),
});
export const toggleDoctorRequestStatus: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } =
      await toggleDoctorRequestStatusSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const node = await DoctorSecretaryRequest.findOne({
      _id: nodeId,
      phone: req.user.phone,
    });
    if (!node) return next(new NotFoundError());
    if (node.status !== "Pending") return next(new BadTimingError());
    if (data.status === "Approved") {
      const dup = await DoctorSecretary.exists({
        doctor: node.doctor._id,
        user: req.user._id,
      });
      await DoctorSecretaryRequest.findByIdAndUpdate(node._id, data);
      if (dup) return next(new AppError("این درخواست قبلا پردازش شده", 400));
      await DoctorSecretary.create({
        doctor: node.doctor._id,
        secretary: req.user._id,
        accessLevel: node.accessLevel,
        displayName: node.displayName,
      });
    } else {
      await DoctorSecretaryRequest.findByIdAndUpdate(node._id, data);
    }
    res.status(200).json({ message: "toggleDoctorRequestStatus" });
  }
);
