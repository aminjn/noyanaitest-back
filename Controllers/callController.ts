import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import CallRoom from "../Models/CallRoom";
import { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import { isValidObjectId } from "mongoose";
import { io } from "../server";

export const getMyOngoingCalls: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await CallRoom.find({ participants: req.user._id });
    res.status(200).json({ message: "getMyOngoingCalls", data });
  }
);

export const joinACall: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const room = await CallRoom.findOne({
      participants: req.user._id,
      _id: nodeId,
    });
    if (!room) return next(new NotFoundError());
    await CallRoom.findByIdAndUpdate(room._id, {
      $addToSet: { joined: req.user._id },
    });
    const userSocketRoom = io.sockets.adapter.rooms.get(
      req.user._id.toString()
    );
    if (userSocketRoom) {
      userSocketRoom.forEach((id) => {
        const socket = io.sockets.sockets.get(id);
        if (socket) socket.join(room._id.toString());
      });
    }
    io.to(room._id.toString()).emit("peer-joined", {
      user: req.user._id.toString(),
    });
    res.status(200).json({ message: "joinACall" });
  }
);

export const leaveACall: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    res.status(200).json({ message: "leaveACall" });
  }
);
