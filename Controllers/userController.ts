import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import Invoice from "../Models/Invoice";
import { isValidObjectId } from "mongoose";
import Booking from "../Models/Booking";

export const getMe: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    res.status(200).json({ message: `getMe`, data: { data: req.user } });
  }
);

export const getMyInvoices: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    //TODO: maybe add pagination shit
    const data = await Invoice.find({ user: req.user._id }).populate({
      path: "checkout",
    });
    res.status(200).json({ message: "getMyInvoices", data });
  }
);

export const getMyInvoice: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Invoice.findOne({
      _id: nodeId,
      user: req.user._id,
    }).populate({
      path: "checkout",
    });
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyInvoice", data });
  }
);

export const getMyBookings: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    //TODO: may be add pagination maybe not
    if (!req.user) return next(new MiddlewareError());
    const data = await Booking.find({ user: req.user._id }).populate([
      { path: "doctor" },
      { path: "session" },
    ]);
    res.status(200).json({ message: "getMyBookings", data });
  }
);

export const getMyBooking: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Booking.findOne({
      _id: nodeId,
      user: req.user._id,
    }).populate([
      { path: "doctor" },
      { path: "session" },
    ]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyBooking", data });
  }
);
