import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { MiddlewareError } from "../Lib/AppError";

export const getMe: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    res.status(200).json({ message: `getMe`, data: { data: req.user } });
  }
);
