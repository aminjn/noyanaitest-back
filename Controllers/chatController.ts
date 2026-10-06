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
import Reservation from "../Models/Reservation";
import { markReservationPresent } from "../Services/reservationProgressService";

// Whose inbox a request reads (2026-10): the logged-in user, or, under
// /doctor/chat, the doctor's own account, so a secretary with "readChat"
// answers the doctor's patients instead of seeing their own chats. Messages
// a secretary sends go out as the doctor's practice.
type ChatRequest = Request & { chatActor?: mongoose.Types.ObjectId };
const actorOf = (req: Request) =>
  (req as ChatRequest).chatActor ?? (req.user!._id as mongoose.Types.ObjectId);

export const actAsDoctor: RequestHandler = (req, res, next) => {
  if (!req.doctor?.user) return next(new MiddlewareError());
  const user = req.doctor.user as unknown as { _id?: mongoose.Types.ObjectId };
  (req as ChatRequest).chatActor = (user._id ?? user) as mongoose.Types.ObjectId;
  next();
};

// messages the actor has not read yet, per chat (the other side's only)
const unreadByChat = async (actor: mongoose.Types.ObjectId, chatIds: unknown[]) => {
  if (!chatIds.length) return new Map<string, number>();
  const rows = await Message.aggregate([
    {
      $match: {
        chat: { $in: chatIds.map((id) => new mongoose.Types.ObjectId(String(id))) },
        sender: { $ne: new mongoose.Types.ObjectId(String(actor)) },
        readBy: { $ne: new mongoose.Types.ObjectId(String(actor)) },
      },
    },
    { $group: { _id: "$chat", count: { $sum: 1 } } },
  ]);
  return new Map<string, number>(rows.map((r: { _id: unknown; count: number }) => [String(r._id), r.count]));
};

export const getMyChats: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const chats = await Chat.find({ participants: actorOf(req) }).populate([
      {
        path: "messages",
        select: { _id: 1 },
      },
      { path: "participants", populate: { path: "identity" } },
    ]);
    // each chat says how many of its messages are still unread (2026-10:
    // the inbox and the panels' chat tab show it)
    const unread = await unreadByChat(actorOf(req), chats.map((c) => c._id));
    const data = chats.map((c) => ({ ...c.toObject(), unread: unread.get(String(c._id)) || 0 }));
    res.status(200).json({ message: "getMyChats", data });
  },
);

// PATCH /doctor/chat/:nodeId/close - the practice ends a conversation (the
// header's "close chat"); the patient can't send to it any more (sendMessage
// refuses a chat with closedAt). A visit's chat also closes at its end.
export const closeMyChat: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const chat = await Chat.findOne({ _id: nodeId, participants: actorOf(req) });
    if (!chat) return next(new NotFoundError());
    if (!chat.closedAt) {
      chat.closedAt = new Date();
      await chat.save();
    }
    res.status(200).json({ message: "closeMyChat", data: { _id: chat._id, closedAt: chat.closedAt } });
  },
);

// GET /chat/unread - unread messages across open chats, for tab badges
export const getMyUnreadCount: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const chatIds = await Chat.find({ participants: actorOf(req), closedAt: { $exists: false } }).distinct("_id");
    const unread = await unreadByChat(actorOf(req), chatIds);
    let count = 0;
    unread.forEach((n) => (count += n));
    res.status(200).json({ message: "getMyUnreadCount", data: { count, chats: unread.size } });
  },
);

export const getMyChat: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Chat.findOne({
      _id: nodeId,
      participants: actorOf(req),
    }).populate([
      { path: "participants", populate: { path: "identity" } },
      { path: "messages", select: { _id: 1 } },
    ]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyChat", data });
  },
);

// textChat half of reservation in-progress tracking: a reservation counts
// a party "present" once they've sent at least one message in the chat the
// activation sweep opened for their session (chat.reservation set). See
// Services/reservationProgressService.ts for what "present" means and
// Services/reservationActivationService.ts for the voiceCall/videoCall/
// sipCall/inPerson equivalents.
const markChatReservationPresence = async (
  chat: { _id: unknown; reservation?: unknown },
  senderId: string,
): Promise<void> => {
  if (!chat.reservation) return;
  try {
    const reservation = await Reservation.findById(chat.reservation).populate(
      { path: "doctor", populate: { path: "user" } },
    );
    if (!reservation) return;
    if (reservation.doctor?.user?._id?.toString() === senderId) {
      await markReservationPresent(reservation._id, "doctor");
    } else if (reservation.user?.toString() === senderId) {
      await markReservationPresent(reservation._id, "patient");
    }
  } catch (err) {
    console.log(
      `[chat] failed to mark reservation presence for chat ${chat._id}:`,
      err,
    );
  }
};

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
          "chat.participants": new mongoose.Types.ObjectId(actorOf(req)),
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
      $addToSet: { readBy: actorOf(req) },
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
      participants: actorOf(req),
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
      sender: actorOf(req),
      file,
      message: data.message,
    });
    await markChatReservationPresence(chat, actorOf(req).toString());
    res.status(200).json({ message: "sendMessage" });
  },
);
