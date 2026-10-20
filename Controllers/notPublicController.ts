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
import OrderReturn from "../Models/OrderReturn";
import UserAccessLevel from "../Models/UserAccessLevel";

// types a browser shows but never runs as a page (no text/html, image/svg+xml, xml...)
const INLINE_TYPES = /^(image\/(jpeg|png|gif|webp|avif|bmp)|application\/pdf|audio\/[\w.+-]+|video\/[\w.+-]+)$/;

const canReadReturnPhoto = async (req: Request, fileId: unknown) => {
  if (!req.user || !(await OrderReturn.exists({ photos: fileId }))) return false;
  if (req.user.role === "admin") return true;
  if (req.user.role !== "notadmin") return false;
  const access = await UserAccessLevel.findOne({ user: req.user._id }).populate("accessLevel");
  const level = access?.accessLevel as unknown as Record<string, Record<string, boolean> | undefined> | undefined;
  return !!level?.Order?.readOne;
};

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
      // (2026-10) a return's photos: also support with the right to read
      // orders (the readers are the buyer and the seller's owner)
      if (!ok && !(await canReadOrderPrescriptionFile(req, res, file)) && !(await canReadReturnPhoto(req, file._id)))
        return next(new AccessError());
    } else if (file.chatPath === "PatientProfileRecord") {
      const record = await PatientProfileRecord.findById(
        file.chat?._id
      ).populate({
        path: "profile",
      });
      if (!record) return next(new NotFoundError());
      // a record whose profile (or its user) is gone is nobody's: it was
      // readable by every signed-in user before
      const profileUser = (record.profile?.user as unknown as { _id?: unknown } | undefined)?._id ?? record.profile?.user;
      if (!profileUser) return next(new AccessError());
      if (String(profileUser) !== req.user._id.toString()) {
        req.params.name = "doctor";
        await runMiddleware(useDoctor(), req, res);
        if (!req.doctor) return next(new AccessError());
        if (record.isPublic) {
          const patient = await DoctorPatient.exists({
            doctor: req.doctor._id,
            user: profileUser,
          });
          if (!patient) return next(new AccessError());
        } else {
          if (String((record.author as unknown as { _id?: unknown })?._id ?? record.author) !== req.doctor._id.toString())
            return next(new AccessError());
        }
      }
    } else {
      // a kind this check does not know is never served
      return next(new AccessError());
    }
    const dir = path.join(process.cwd(), "NotPublic");
    const filePath = path.join(dir, String(file.file || ""));
    if (path.dirname(filePath) !== dir || !fs.existsSync(filePath)) return res.sendStatus(404);
    // shown in the browser only when it can't run script on our origin
    // (an image, a PDF, audio/video); anything else (an .html or .svg sent
    // in a chat) is a download, never rendered
    const mimeType = mime.lookup(filePath) || "application/octet-stream";
    const inline = INLINE_TYPES.test(mimeType);
    res.setHeader("Content-Type", inline ? mimeType : "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // (a sandboxed page can't open the browser's PDF viewer: not for a PDF)
    if (mimeType !== "application/pdf")
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
    );
    fs.createReadStream(filePath).pipe(res);
  }
);
