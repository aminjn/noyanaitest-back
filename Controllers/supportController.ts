import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import Ticket, { ticketSubjects } from "../Models/Ticket";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import TicketMessage from "../Models/TicketMessage";

export const getMyTickets: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await Ticket.find({ submittedBy: req.user._id });
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
    const node = await Ticket.findOneAndUpdate(
      {
        submittedBy: req.user._id,
        _id: nodeId,
      },
      { status: "Open" },
    );
    if (!node) return next(new NotFoundError());
    await TicketMessage.create({
      ticket: node._id,
      content: input.content,
      isAdmin: false,
    });
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
    await Ticket.findByIdAndUpdate(node._id, { status: "Closed" });
    res.status(200).json({ message: "closeTicket" });
  },
);
