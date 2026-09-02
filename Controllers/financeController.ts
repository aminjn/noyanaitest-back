import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { MiddlewareError } from "../Lib/AppError";
import Wallet from "../Models/Wallet";

export const getMyBalance: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const wallet = await Wallet.findOneAndUpdate(
      { user: req.user._id },
      { user: req.user._id },
      { upsert: true, new: true },
    );
    res.status(200).json({ message: "getMyBalance", data: wallet.balance });
  },
);
