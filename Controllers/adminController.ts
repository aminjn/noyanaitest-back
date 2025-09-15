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
import Clinic from "../Models/Clinic";

import ARI from "ari-client";
import { SIP_HOST, SIP_PASSWORD, SIP_USERNAME } from "../Lib/Env";

export const clearUserFromDoctorProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await DoctorProfile.findByIdAndUpdate(req.params.nodeId, {
      $unset: { user: 1 },
    });
    res.status(200).json({ message: "clearUserFromDoctorProfile" });
  }
);

export const clearUserFromClinic: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Clinic.findByIdAndUpdate(req.params.nodeId, { $unset: { user: 1 } });
    res.status(200).json({ message: "clearUserFromClinic" });
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

export const testSip: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { a, b } = req.body;
      const client = await ARI.connect(SIP_HOST, SIP_USERNAME, SIP_PASSWORD);
      const bridge = await client.bridges.create({ type: "mixing" });
      client.start("myapp");
      client.on("StasisStart", async (e) => {
        await bridge.addChannel({ channel: e.channel.id });
      });
      // console.log(app);
      const chanA = await client.channels.originate({
        endpoint: `SIP/${a}@mytrunk`,
        app: "myapp",
        appArgs: "callA",
      });
      console.log("calling A");
      const chanB = await client.channels.originate({
        endpoint: `SIP/${b}@mytrunk`,
        app: "myapp",
        appArgs: "callB",
      });
      console.log("calling B");
    } catch (err) {
      console.log(err);
    }
    res.status(200).json({ message: "testSip" });
  }
);
