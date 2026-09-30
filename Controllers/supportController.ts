import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  MiddlewareError,
  NotFoundError,
} from "../Lib/AppError";
import Ticket, { ITicket, ticketSubjects } from "../Models/Ticket";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import TicketMessage from "../Models/TicketMessage";
import { notifyUserAlertSubscribers } from "../Services/userAlertService";

// Fire-and-forget: staff members who opted in (Models/UserAlert.ts,
// pushNotificationOnNewTicket/sendSMSOnNewTicket) get a push/SMS ping
// whenever a user creates or replies to a ticket. Must never fail or slow
// down the request that's actually persisting the ticket/message, so
// callers below don't await this. `pushMessage` is only for the in-app/push
// channel; the SMS channel gets its own {ticketId, userPhone, ticketTitle}
// variables (Models/UserAlert.ts's UserAlertSmsVariables) - whatever the
// admin's own gateway pattern for "newTicket" actually needs, not a
// title/message pair.
const alertStaffOfTicketActivity = (
  ticket: Pick<ITicket, "_id" | "title">,
  pushMessage: string,
  userPhone: string,
) =>
  notifyUserAlertSubscribers(
    "newTicket",
    { title: "تیکت پشتیبانی", message: pushMessage },
    {
      ticketId: ticket._id.toString(),
      userPhone,
      ticketTitle: ticket.title,
    },
  ).catch((err) =>
    console.log(
      `[supportController] failed to notify staff of ticket ${ticket._id} activity:`,
      err,
    ),
  );

export const getMyTickets: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const tickets = await Ticket.find({ submittedBy: req.user._id }).sort({
      submittedAt: -1,
    });
    // last message per ticket, so the list can show a preview and whether
    // support has answered (waiting on the user vs. waiting on support)
    const last = tickets.length
      ? await TicketMessage.aggregate<{
          _id: unknown;
          content: string;
          isAdmin: boolean;
          submittedAt: Date;
          count: number;
        }>([
          { $match: { ticket: { $in: tickets.map((t) => t._id) } } },
          { $sort: { submittedAt: -1 } },
          {
            $group: {
              _id: "$ticket",
              content: { $first: "$content" },
              isAdmin: { $first: "$isAdmin" },
              submittedAt: { $first: "$submittedAt" },
              count: { $sum: 1 },
            },
          },
        ])
      : [];
    const byTicket = new Map(last.map((l) => [String(l._id), l]));
    const data = tickets.map((t) => {
      const l = byTicket.get(String(t._id));
      return {
        ...t.toObject(),
        lastMessage: l
          ? {
              content: (l.content || "").slice(0, 160),
              isAdmin: !!l.isAdmin,
              submittedAt: l.submittedAt,
            }
          : null,
        messageCount: l?.count || 0,
      };
    });
    res.status(200).json({ message: "getMyTickets", data });
  },
);

export const getMyTicket: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Ticket.findOne({
      submittedBy: req.user._id,
      _id: nodeId,
    }).populate({ path: "messages" });
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyTicket", data });
  },
);

const submitTicketSchema = z.strictObject({
  content: z.string(),
  title: z.string(),
  subject: z.enum(ticketSubjects),
});

export const submitTicket: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const {
      data: input,
      success,
      error,
    } = await submitTicketSchema.spa(req.body);
    if (!success) return next(new BadInputError(error.message));
    const data = await Ticket.create({
      title: input.title,
      subject: input.subject,
      submittedBy: req.user._id,
    });
    await TicketMessage.create({
      ticket: data._id,
      isAdmin: false,
      content: input.content,
    });
    alertStaffOfTicketActivity(
      data,
      `کاربر ${req.user.phone} تیکت جدیدی با عنوان «${input.title}» ثبت کرد.`,
      req.user.phone,
    );
    res.status(200).json({ message: "submitTicket", data });
  },
);

const respondTicketSchema = z.strictObject({ content: z.string() });

export const respondTicket: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const {
      data: input,
      error,
      success,
    } = await respondTicketSchema.spa(req.body);
    if (!success) return next(new BadInputError(error.message));
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await Ticket.findOne({
      submittedBy: req.user._id,
      _id: nodeId,
    });
    if (!node) return next(new NotFoundError());
    // a closed ticket stays closed - the user opens a new one (Zendesk /
    // Freshdesk pattern); a resolved one is reopened by the reply
    if (node.status === "Closed")
      return next(
        new AppError("این تیکت بسته شده است؛ لطفا تیکت جدیدی ثبت کنید", 400),
      );
    await Ticket.updateOne({ _id: node._id }, { $set: { status: "Open" } });
    await TicketMessage.create({
      ticket: node._id,
      content: input.content,
      isAdmin: false,
    });
    alertStaffOfTicketActivity(
      node,
      `کاربر ${req.user.phone} به تیکت «${node.title}» پاسخ داد.`,
      req.user.phone,
    );
    res.status(200).json({ message: "respondTicket" });
  },
);

export const closeTicket: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await Ticket.findOne({
      submittedBy: req.user._id,
      _id: nodeId,
    });
    if (!node) return next(new NotFoundError());
    // updateOne: the user closed it themselves, no "your ticket was closed" notice
    await Ticket.updateOne({ _id: node._id }, { $set: { status: "Closed" } });
    res.status(200).json({ message: "closeTicket" });
  },
);
