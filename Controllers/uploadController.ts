import { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import catchAsync from "../Lib/catchAsync";
import fs from "fs/promises";
import path from "path";

const multerStorage = multer.memoryStorage();

//TODO: add filter
export const upload = multer({
  storage: multerStorage,
  fileFilter: (req, file, cb) => cb(null, true),
});

export const saveUplaodsToBody: (args: { name: string }) => RequestHandler = ({
  name,
}) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (Array.isArray(req.files) && !!req.files.length) {
      for (let i = 0; i < req.files.length; i++) {
        const filename = `${name}__${
          req.files[i].fieldname
        }__${new Date().getTime()}.${req.files[i].originalname
          .split(".")
          .findLast(() => true)}`;
        await fs.writeFile(
          path.join(process.cwd(), "Public", filename),
          req.files[i].buffer
        );
        req.body[req.files[i].fieldname] = filename;
      }
    }
    next();
  });
