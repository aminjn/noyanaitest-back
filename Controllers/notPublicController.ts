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
import PatientProfileRecord from "../Models/PatientProfileRecord";
import DoctorProfile from "../Models/DoctorProfile";
import DoctorPatient from "../Models/DoctorPatient";
import { useDoctor } from "./aclController";
import { canReadOrderPrescriptionFile } from "../Services/rxPrescriptionAccess";

const runMiddleware = (
  middleware: RequestHandler,
  req: Request,
  res: Response
) =>
  new Promise<void>((resolve) => {
    middleware(req, res, () => resolve());
  });

export const getFile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const file = await UserFile.findById(nodeId).populate({ path: "chat" });
    if (!file) return next(new NotFoundError());
    if (file.chatPath === "Chat") {
      const peopleWithAccess = [
        ...(file.readers || []),
        ...(file.chat?.participants || []),
      ];
      const has = (id?: unknown) =>
        !!id && peopleWithAccess.some((el) => el._id.toString() === String(id));
      if (!has(req.user._id)) {
        // a secretary with "readChat" opens files in the doctor's chats
        // (2026-10, /doctor/chat)
        req.params.name = "doctor";
        await runMiddleware(useDoctor("readChat"), req, res).catch(() => undefined);
        const owner = req.doctor?.user as unknown as { _id?: unknown } | undefined;
        if (!has(owner?._id ?? owner)) return next(new AccessError());
      }
    } else if (file.chatPath === "Order") {
      // a lab result: the buyer, the lab's owner and the uploader (readers)
      const ok = (file.readers || []).some(
        (el) => el._id.toString() === req.user?._id.toString(),
      );
      // a buyer's paper prescription (2026-10): also the pharmacy's staff
      // and the super admin - see Services/rxPrescriptionAccess.ts
      if (!ok && !(await canReadOrderPrescriptionFile(req, res, file)))
        return next(new AccessError());
    } else if (file.chatPath === "PatientProfileRecord") {
      const record = await PatientProfileRecord.findById(
        file.chat?._id
      ).populate({
        path: "profile",
      });
      if (!record) return next(new NotFoundError());
      if (
        record.profile &&
        record.profile.user._id.toString() !== req.user._id.toString()
      ) {
        req.params.name = "doctor";
        await runMiddleware(useDoctor(), req, res);
        if (!req.doctor) return next(new AccessError());
        if (record.isPublic) {
          const patient = await DoctorPatient.exists({
            doctor: req.doctor._id,
            user: record.profile.user._id,
          });
          if (!patient) return next(new AccessError());
        } else {
          if (record.author._id.toString() !== req.doctor._id.toString())
            return next(new AccessError());
        }
      }
    }
    const filePath = path.join(process.cwd(), "NotPublic", file.file);
    if (!fs.existsSync(filePath)) return res.sendStatus(404);
    const mimeType = mime.lookup(filePath) || "application/octet-stream";
    res.setHeader("Content-Type", mimeType);
    fs.createReadStream(filePath).pipe(res);
  }
);
