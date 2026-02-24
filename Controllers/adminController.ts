import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import DoctorProfile from "../Models/DoctorProfile";
import AccessLevel, {
  accessLevelModels,
  accessOperations,
  IAccessLevel,
} from "../Models/AccessLevel";
import mongoose from "mongoose";
import AppError, {
  AccessError,
  BadTaminResponseError,
  MiddlewareError,
  NotFoundError,
  TaminRideError,
} from "../Lib/AppError";
import UserAccessLevel from "../Models/UserAccessLevel";
import Clinic from "../Models/Clinic";

import ARI from "ari-client";
import { SIP_HOST, SIP_PASSWORD, SIP_USERNAME } from "../Lib/Env";
import User from "../Models/User";
import { io } from "../server";
import CallRoom from "../Models/CallRoom";
import UserIdentity from "../Models/UserIdentity";
import TaminServiceType from "../Models/TaminServiceType";
import TaminPrescriptionType from "../Models/TaminPrescriptionType";
import TaminService from "../Models/TaminService";
import TaminParTaref from "../Models/TaminParTaref";
import TaminDrugUsage from "../Models/TaminDrugUsage";
import TaminDrugInstruction from "../Models/TaminDrugInstruction";
import TaminDrugAmount from "../Models/TaminDrugAmount";
import TaminPhPlan from "../Models/TaminPhPlan";
import TaminPhIllness from "../Models/TaminPhIllness";

export const clearUserFromDoctorProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await DoctorProfile.findByIdAndUpdate(req.params.nodeId, {
      $unset: { user: 1 },
    });
    res.status(200).json({ message: "clearUserFromDoctorProfile" });
  },
);

export const clearUserFromClinic: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Clinic.findByIdAndUpdate(req.params.nodeId, { $unset: { user: 1 } });
    res.status(200).json({ message: "clearUserFromClinic" });
  },
);

//TODO: Temperory
export const debug: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    // const data = await OldDoctor.find().populate("speciality");
    res.status(200).json({ message: "test" });
  },
);

const fullAccess: IAccessLevel = {
  _id: "" as unknown as mongoose.Types.ObjectId,
  name: "admin",
  ...accessLevelModels.reduce(
    (acc, model) => ({
      ...acc,
      [model]: accessOperations.reduce(
        (accc, op) => ({ ...accc, [op]: true }),
        {},
      ),
    }),
    {},
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
      accessLevel.accessLevel?._id.toString(),
    );
    if (!access) return next(new AccessError());
    res
      .status(200)
      .json({ message: "getMyAccessLevel", data: { data: access } });
  },
);

//TODO: Temperory
export const testSip: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { a, b } = req.body;
      const client = await ARI.connect(SIP_HOST, SIP_USERNAME, SIP_PASSWORD);
      const bridge = await client.bridges.create({ type: "mixing" });
      client.start("ai-agent");
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
  },
);

//TODO: Temperory
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
      caller._id.toString(),
    );
    if (callerSocketRoom) {
      callerSocketRoom.forEach((id) => {
        const socket = io.sockets.sockets.get(id);
        if (socket) socket.join(room._id.toString());
      });
    }
    const calleeSocketRoom = io.sockets.adapter.rooms.get(
      callee._id.toString(),
    );
    if (calleeSocketRoom) {
      calleeSocketRoom.forEach((id) => {
        const socket = io.sockets.sockets.get(id);
        if (socket) socket.join(room._id.toString());
      });
    }
    res.status(200).json({ message: "callUser" });
  },
);

//TODO: Temperory
export const fillUserIdentity: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const user = await User.findById(req.body.user);
    if (!user) return next(new NotFoundError());
    await UserIdentity.create({
      user: user?._id,
      dateOfbirth: new Date(806889600000),
      gender: "male",
      givenName: "Haji",
      lastName: "Abdolblack",
      nationalId: "0018243460",
    });
    res.status(200).json({ message: "FillUserIdentity" });
  },
);

//TODO: Temp
export const pod: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    console.log("requesting Api Key");
    res.status(200).json({ message: "pod" });
  },
);

export const refreshTaminServiceTypes: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-service-type";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data?.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      if (!data.data[i].srvType) continue;
      await TaminServiceType.findOneAndUpdate(
        {
          srvType: data.data[i].srvType,
        },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminServiceTypes" });
  },
);

export const refreshTaminPrescriptionTypes: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-prescription-type";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data?.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      if (!data.data[i].prescTypeCode) continue;
      await TaminPrescriptionType.findOneAndUpdate(
        { prescTypeCode: data.data[i].prescTypeCode },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminPrescriptionTypes" });
  },
);

export const refreshTaminServices: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const serviceTypes = await TaminServiceType.find();
    if (!serviceTypes.length)
      return next(new AppError("لطفا اول سرویس تایپ ها رو بگیرید", 400));
    for (let j = 0; j < serviceTypes.length; ++j) {
      console.log(`getting Shit For ${serviceTypes[j].srvTypeDes}`);
      const url = `https://ep-test.tamin.ir/api/v2/ws-services?serviceType=${serviceTypes[j].srvType}`;
      const response = await fetch(url);
      if (
        !response.ok ||
        !response.headers.get("Content-Type")?.includes("json")
      ) {
        console.log(`failed For ${serviceTypes[j].srvTypeDes}`);
        // return next(new TaminRideError());
        continue;
      }
      const data = await response.json();
      if (!Array.isArray(data?.data)) return next(new BadTaminResponseError());
      for (let i = 0; i < data.data.length; ++i) {
        if (!data.data[i].wsSrvCode) continue;
        const stripped = {
          ...data.data[i],
          srvType: data.data[i].srvType?.srvType,
          parTarefGrp: data.data[i].parTarefGrp?.parGrpCode,
        };
        await TaminService.findOneAndUpdate(
          {
            wsSrvCode: data.data[i].wsSrvCode,
          },
          stripped,
          { upsert: true },
        );
      }
    }
    res.status(200).json({ message: "refreshTaminServices" });
  },
);

export const refreshTaminParTarefs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-par-taref";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data?.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      await TaminParTaref.findOneAndUpdate(
        { parGrpCode: data.data[i].parGrpCode },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminParTarefs" });
  },
);

export const refreshTaminDrugUsages: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-drug-usage";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data?.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      await TaminDrugUsage.findOneAndUpdate(
        { drugUsageId: data.data[i].drugUsageId },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminDrugUsages" });
  },
);

export const refreshTaminDrugInstructions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-drug-instruction";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      await TaminDrugInstruction.findOneAndUpdate(
        { drugInstId: data.data[i].drugInstId },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminDrugInstructions" });
  },
);

export const refreshTaminDrugAmounts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-drug-amount";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      await TaminDrugAmount.findOneAndUpdate(
        {
          drugAmntId: data.data[i].drugAmntId,
        },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminDrugAmounts" });
  },
);

export const refreshTaminPhPlans: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-ph-plan";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data?.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      await TaminPhPlan.findOneAndUpdate(
        { planId: data.data[i].planId },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminPhPlans" });
  },
);

export const refreshTaminPhIllnesses: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-ph-illness";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data?.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      await TaminPhIllness.findOneAndUpdate(
        { illnessId: data.data[i].illnessId },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminPhIllnesses" });
  },
);
