import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import * as z from "zod";

import catchAsync from "../Lib/catchAsync";
import { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import { callTypes } from "../Models/CallRoom";
import { callService } from "../Services/Call";

const createCallSchema = z.strictObject({
  participantIds: z.array(z.string()).min(1),
  callType: z.enum(callTypes),
});

export const createCall: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await createCallSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    if (data.participantIds.some((id) => !isValidObjectId(id)))
      return next(new BadInputError());
    const room = await callService.initiateCall({
      initiatorId: req.user._id.toString(),
      participantIds: data.participantIds,
      callType: data.callType,
    });
    res.status(201).json({ message: "createCall", data: room });
  },
);

const createFromBookingSchema = z.strictObject({
  callType: z.enum(callTypes).optional(),
});

export const createCallFromBooking: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { bookingId } = req.params;
    if (!isValidObjectId(bookingId)) return next(new BadInputError());
    const { data, success } = await createFromBookingSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const room = await callService.initiateCall({
      initiatorId: req.user._id.toString(),
      participantIds: [],
      callType: data.callType,
      bookingId,
    });
    res.status(201).json({ message: "createCallFromBooking", data: room });
  },
);

export const getMyOngoingCalls: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await callService.listOngoing(req.user._id.toString());
    res.status(200).json({ message: "getMyOngoingCalls", data });
  },
);

export const getMyCallHistory: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || undefined;
    const data = await callService.listHistory(req.user._id.toString(), {
      page,
      ...(limit && { limit }),
    });
    res.status(200).json({ message: "getMyCallHistory", data });
  },
);

export const getMyCall: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await callService.getCall(nodeId, req.user._id.toString());
    res.status(200).json({ message: "getMyCall", data });
  },
);

// Purely an audit marker for clients that want to acknowledge the ring
// before actually connecting media (which happens over the socket via
// call:join). Actually connecting media is what flips a participant to
// "joined" in the DB.
export const answerCall: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { room } = await callService.getCall(nodeId, req.user._id.toString());
    if (!room) return next(new NotFoundError("تماس"));
    res.status(200).json({ message: "answerCall" });
  },
);

export const rejectCall: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    await callService.rejectCall({
      roomId: nodeId,
      userId: req.user._id.toString(),
    });
    res.status(200).json({ message: "rejectCall" });
  },
);

export const leaveCall: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    await callService.leaveCall({
      roomId: nodeId,
      userId: req.user._id.toString(),
    });
    res.status(200).json({ message: "leaveCall" });
  },
);

export const endCall: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await callService.endCall({
      roomId: nodeId,
      byUserId: req.user._id.toString(),
    });
    res.status(200).json({ message: "endCall", data });
  },
);

export const adminEndCall: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await callService.adminEndCall({
      roomId: nodeId,
      byUserId: req.user._id.toString(),
    });
    res.status(200).json({ message: "adminEndCall", data });
  },
);

const kickSchema = z.strictObject({ targetUserId: z.string() });

export const kickParticipant: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await kickSchema.safeParseAsync(req.body);
    if (!success || !isValidObjectId(data.targetUserId))
      return next(new BadInputError());
    await callService.kickParticipant({
      roomId: nodeId,
      targetUserId: data.targetUserId,
      byUserId: req.user._id.toString(),
    });
    res.status(200).json({ message: "kickParticipant" });
  },
);

const muteParticipantSchema = z.strictObject({
  targetUserId: z.string(),
  kind: z.enum(["audio", "video"]),
  muted: z.boolean(),
});

export const muteParticipant: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await muteParticipantSchema.safeParseAsync(
      req.body,
    );
    if (!success || !isValidObjectId(data.targetUserId))
      return next(new BadInputError());
    const result = await callService.forceMuteParticipant({
      roomId: nodeId,
      targetUserId: data.targetUserId,
      byUserId: req.user._id.toString(),
      kind: data.kind,
      muted: data.muted,
    });
    res.status(200).json({ message: "muteParticipant", data: result });
  },
);

export const startRecording: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    await callService.startRecording({
      roomId: nodeId,
      byUserId: req.user._id.toString(),
    });
    res.status(200).json({ message: "startRecording" });
  },
);

export const stopRecording: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    await callService.stopRecording({
      roomId: nodeId,
      byUserId: req.user._id.toString(),
    });
    res.status(200).json({ message: "stopRecording" });
  },
);

export const listRecordings: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await callService.listRecordings(
      nodeId,
      req.user._id.toString(),
    );
    res.status(200).json({ message: "listRecordings", data });
  },
);
