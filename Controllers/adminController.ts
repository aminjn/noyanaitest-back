import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import DoctorProfile from "../Models/DoctorProfile";
import AccessLevel, {
  accessLevelModels,
  accessOperations,
  IAccessLevel,
} from "../Models/AccessLevel";
import mongoose from "mongoose";
import { AccessError, MiddlewareError } from "../Lib/AppError";
import UserAccessLevel from "../Models/UserAccessLevel";

export const clearUserFromDoctorProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await DoctorProfile.findByIdAndUpdate(req.params.nodeId, {
      $unset: { user: 1 },
    });
    res.status(200).json({ message: "clearUserFromDoctorProfile" });
  }
);

export const debug: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    // const data = await OldDoctor.find().populate("speciality");
    res.status(200).json({ message: "test" });
  }
);

const fullAccess: IAccessLevel = {
  _id: "" as unknown as mongoose.Types.ObjectId,
  name: "admin",
  ...accessLevelModels.reduce(
    (acc, model) => ({
      ...acc,
      [model]: accessOperations.reduce(
        (accc, op) => ({ ...accc, [op]: true }),
        {}
      ),
    }),
    {}
  ),
};

export const getMyAccessLevel: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    if (req.user.role === "admin")
      return res
        .status(200)
        .json({ message: "getMyAccessLevel", data: { data: fullAccess } });
    const accessLevel = await UserAccessLevel.findOne({ user: req.user._id });
    if (!accessLevel) return next(new AccessError());
    const access = await AccessLevel.findById(
      accessLevel.accessLevel?._id.toString()
    );
    if (!access) return next(new AccessError());
    res
      .status(200)
      .json({ message: "getMyAccessLevel", data: { data: access } });
  }
);
