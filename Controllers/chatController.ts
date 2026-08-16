import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  MiddlewareError,
  NotFoundError,
} from "../Lib/AppError";
import Chat from "../Models/Chat";
import mongoose, { isValidObjectId } from "mongoose";
import Message from "../Models/Message";
import * as z from "zod";
import fs from "fs/promises";
import path from "path";
import UserFile, { IUserFile } from "../Models/UserFile";

export const getMyChats: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await Chat.find({ participants: req.user._id }).populate([
      {
        path: "messages",
        select: { _id: 1 },
      },
      { path: "participants", populate: { path: "identity" } },
    ]);
    res.status(200).json({ message: "getMyChats", data });
  },
);

export const getMyChat: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Chat.findOne({
      _id: nodeId,
      participants: req.user._id,
    }).populate([
      { path: "participants", populate: { path: "identity" } },
      { path: "messages", select: { _id: 1 } },
    ]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyChat", data });
  },
);

export const getMessage: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const result = await Message.aggregate([
      {
        $match: { _id: new mongoose.Types.ObjectId(nodeId) },
      },
      {
        $lookup: {
          from: "chats",
          localField: "chat",
          foreignField: "_id",
          as: "chat",
        },
      },
      { $unwind: "$chat" },
      {
        $match: {
          "chat.participants": new mongoose.Types.ObjectId(req.user._id),
        },
      },
      {
        $lookup: {
          from: "userfiles",
          localField: "file",
          foreignField: "_id",
          as: "uploads",
        },
      },
    ]);
    if (!result.length) return next(new NotFoundError());
    await Message.findByIdAndUpdate(result[0]._id, {
      $addToSet: { readBy: req.user._id },
    });
    res.status(200).json({ message: "getMessage", data: result[0] });
  },
);

const sendMessageSchema = z.strictObject({
  message: z.string().trim().optional(),
});
export const sendMessage: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await sendMessageSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const chat = await Chat.findOne({
      _id: nodeId,
      participants: req.user._id,
    });
    if (!chat) return next(new NotFoundError());
    if (chat.closedAt) return next(new AppError("این چت بسته شده است", 400));
    let file: IUserFile | undefined;
    if (req.file) {
      const name = `NoyanAi-${new Date().getTime()}-${req.file.originalname}`;
      await fs.writeFile(
        path.join(process.cwd(), "NotPublic", name),
        req.file.buffer,
      );
      file = await UserFile.create({ chat: chat._id, file: name });
    }
    if (!file && !data.message) return next(new BadInputError());
    await Message.create({
      chat: chat._id,
      sender: req.user._id,
      file,
      message: data.message,
    });
    res.status(200).json({ message: "sendMessage" });
  },
);
