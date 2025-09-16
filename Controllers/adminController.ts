import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import DoctorProfile from "../Models/DoctorProfile";
import AccessLevel, {
  accessLevelModels,
  accessOperations,
  IAccessLevel,
} from "../Models/AccessLevel";
import mongoose from "mongoose";
import { AccessError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import UserAccessLevel from "../Models/UserAccessLevel";
import Clinic from "../Models/Clinic";

import ARI from "ari-client";
import { SIP_HOST, SIP_PASSWORD, SIP_USERNAME } from "../Lib/Env";
import User from "../Models/User";
import { io } from "../server";
import CallRoom from "../Models/CallRoom";

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

export const callUser: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { callee: calleeId, caller: callerId } = req.body;
    const callee = await User.findById(calleeId);
    if (!callee) return next(new NotFoundError());
    const caller = await User.findById(callerId);
    if (!caller) return next(new NotFoundError());
    const room = await CallRoom.create({
      participants: [callee._id, caller._id],
      callType: "voice",
    });
    io.to(callee._id.toString()).emit("ring", { room: room._id });
    io.to(caller._id.toString()).emit("ring", { room: room._id });
    const callerSocketRoom = io.sockets.adapter.rooms.get(
      caller._id.toString()
    );
    if (callerSocketRoom) {
      callerSocketRoom.forEach((id) => {
        const socket = io.sockets.sockets.get(id);
        if (socket) socket.join(room._id.toString());
      });
    }
    const calleeSocketRoom = io.sockets.adapter.rooms.get(
      callee._id.toString()
    );
    if (calleeSocketRoom) {
      calleeSocketRoom.forEach((id) => {
        const socket = io.sockets.sockets.get(id);
        if (socket) socket.join(room._id.toString());
      });
    }
    res.status(200).json({ message: "callUser" });
  }
);
