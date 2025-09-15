import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  BadTimingError,
  MiddlewareError,
  NotFoundError,
  PathNotFoundError,
} from "../Lib/AppError";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import { cookieBuilder } from "./authController";
import Secretary from "../Models/Secretary";
import {
  nameToAclModelName,
  nameToModelName,
  nodesWithAcl,
} from "./aclController";
import SecretaryRequest from "../Models/SecretaryRequest";

export const getMyBosses: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    const data = await Secretary.find({
      secretary: req.user._id,
      ownerPath: nameToModelName[name],
    }).populate({ path: "owner" });
    res.status(200).json({ message: "getMyBosses", data });
  }
);

export const leaveBoss: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await Secretary.findOne({
      _id: nodeId,
      secretary: req.user._id,
    });
    if (!node) return next(new NotFoundError());
    await Secretary.findByIdAndDelete(nodeId);
    res.status(200).json({ message: "leaveBoss" });
  }
);

export const mountBoss: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await Secretary.findOne({
      _id: nodeId,
      secretary: req.user._id,
    });
    if (!node) return next(new NotFoundError());
    cookieBuilder({ name, id: node._id.toString(), res });
    res.status(200).json({ message: "mountBoss" });
  }
);

export const getMyRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req.user) return next(new MiddlewareError());
    const data = await SecretaryRequest.find({
      phone: req.user.phone,
      ownerPath: nameToModelName[name],
    }).populate({ path: "owner" });
    res.status(200).json({ message: "getMyRequests", data });
  }
);

const toggleRequestStatusSchema = z.strictObject({
  status: z.enum(["Approved", "Rejected"]),
});
export const toggleDoctorRequestStatus: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await toggleRequestStatusSchema.safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    const node = await SecretaryRequest.findOne({
      _id: nodeId,
      phone: req.user.phone,
    });
    if (!node) return next(new NotFoundError());
    if (node.status !== "Pending") return next(new BadTimingError());
    if (data.status === "Approved") {
      const dup = await Secretary.exists({
        owner: node.owner._id,
        user: req.user._id,
      });
      await SecretaryRequest.findByIdAndUpdate(node._id, data);
      if (dup) return next(new AppError("این درخواست قبلا پردازش شده", 400));
      await Secretary.create({
        owner: node.owner._id,
        secretary: req.user._id,
        acl: node.acl,
        displayName: node.displayName,
        ownerPath: nameToModelName[name],
        aclPath: nameToAclModelName[name],
      });
    } else {
      await SecretaryRequest.findByIdAndUpdate(node._id, data);
    }
    res.status(200).json({ message: "toggleDoctorRequestStatus" });
  }
);
