import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import UserFile from "../Models/UserFile";
import {
  AccessError,
  BadInputError,
  MiddlewareError,
  NotFoundError,
} from "../Lib/AppError";
import { isValidObjectId } from "mongoose";
import fs from "fs";
import path from "path";
import mime from "mime-types";

export const getFile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const file = await UserFile.findById(nodeId).populate({ path: "chat" });
    if (!file) return next(new NotFoundError());
    const peopleWithAccess = [
      ...(file.readers || []),
      ...(file.chat?.participants || []),
    ];
    if (
      !peopleWithAccess.find(
        (el) => el._id.toString() === req.user?._id.toString()
      )
    )
      return next(new AccessError());
    const filePath = path.join(process.cwd(), "NotPublic", file.file);
    if (!fs.existsSync(filePath)) return res.sendStatus(404);
    const mimeType = mime.lookup(filePath) || "application/octet-stream";
    res.setHeader("Content-Type", mimeType);
    fs.createReadStream(filePath).pipe(res);
  }
);
