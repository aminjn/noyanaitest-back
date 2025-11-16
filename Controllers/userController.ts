import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  MiddlewareError,
  NotFoundError,
  ServerError,
} from "../Lib/AppError";
import Invoice from "../Models/Invoice";
import { isValidObjectId } from "mongoose";
import Booking from "../Models/Booking";
import UserIdentity from "../Models/UserIdentity";
import * as z from "zod";
import fs from "fs/promises";
import path from "path";
import User, { IUser } from "../Models/User";
import UserVital from "../Models/UserVitals";
import MedicalDetail, { bloodTypes } from "../Models/MedicalDetail";
import { datish, numerish } from "../Lib/helpers";
import { isPhone, isSSID } from "../Lib/validators";
import moment from "moment-jalaali";
import * as env from "../Lib/Env";
import {
  IdentityResponse,
  MatchNationalIdAndPhoneNumberResponse,
  PodiumReponse,
} from "./authController";
import BadEvent from "../Models/BadEvent";
import PendingUser, { IPendingUser } from "../Models/PendingUser";
import { Gender } from "../Models/BecomeDoctorRequest";
import Relative from "../Models/Relative";

export const getMe: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    res.status(200).json({ message: `getMe`, data: { data: req.user } });
  }
);

const editMeSchema = z.strictObject({ username: z.string().optional() });
export const editMe: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    console.log(req.body);
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await editMeSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    let avatar: undefined | string;
    if (req.file) {
      console.log(req.file);
      avatar = `UserAvatar__${req.user._id.toString()}__${new Date().getTime()}${req.file.originalname
        .split(".")
        .findLast(() => true)}`;
      await fs.writeFile(
        path.join(process.cwd(), "Public", avatar),
        req.file.buffer
      );
    }
    await User.findByIdAndUpdate(req.user._id, { ...data, avatar });
    res.status(200).json({ message: "editMe" });
  }
);

export const getMyIdentity: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await UserIdentity.findOne({ user: req.user._id });
    res.status(200).json({ message: "getMyIdentity", data });
  }
);

const getOtherIdentitySchema = z.strictObject({
  birthDate: datish,
  nationalId: z.string(),
  mobileNumber: z.string().optional(),
});
export const getOtherIdentity: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await getOtherIdentitySchema.safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    const phone = isPhone(data.mobileNumber);
    if (data.mobileNumber && !phone) return next(new BadInputError());
    if (!isSSID(data.nationalId)) return next(new BadInputError());
    const incomingBirthDate = new Date(data.birthDate);
    const now = new Date();
    if (phone) {
      if (
        now.getTime() - incomingBirthDate.getTime() <
        18 * 365 * 24 * 60 * 60 * 1000
      )
        return next(
          new AppError(
            "برای افزودن بیمار بالای 18 سال باید موبایل رو وارد کنید",
            400
          )
        );
    }
    const existing = await UserIdentity.findOne({
      nationalId: data.nationalId,
    });
    if (existing) {
      if (
        incomingBirthDate.toLocaleDateString("fa-IR") !==
        new Date(existing.dateOfbirth).toLocaleDateString("fa-IR")
      )
        return next(new AppError("اطلاعات وارد شده مطابقت ندارد", 400));
      res.status(200).json({ message: "getOtherIdentity", data: existing });
    } else {
      const jBirthDate = moment(incomingBirthDate).format("jYYYYjMMjDD");
      let pendingUser: Partial<IPendingUser> | undefined;
      try {
        const response = await fetch(env.podiumUrl, {
          headers: {
            Authorization: `bearer ${env.PODIUM_TOKEN}`,
            "Content-Type": "application/json",
          },
          method: "POST",
          body: JSON.stringify({
            productEntityId: 46659320,
            apiKey: env.GET_IDENTITY_INFO_API_KEY,
            providerParameters: {
              nationalCode: data.nationalId,
              birthDate: jBirthDate,
            },
          }),
        });
        const identityData = (await response.json()) as PodiumReponse;
        if (identityData.hasError || !identityData.result) {
          await BadEvent.create({
            place: "GetOtherIdentity",
            payload: JSON.stringify({
              incoming: req.user._id,
              error: identityData.message,
              result: identityData.result,
            }),
          });
          return next(
            new AppError(
              "سرویس مورد نظر به مشکل خورده لطفا بعدا دوباره امتحان کنید",
              400
            )
          );
        }
        const incomingIdentityInfo = JSON.parse(
          identityData.result
        ) as IdentityResponse;
        if (!incomingIdentityInfo.identityInfo) {
          await BadEvent.create({
            place: "GetOtherIdentity",
            payload: JSON.stringify({
              incoming: req.user._id,
              error: incomingIdentityInfo.message,
            }),
          });
          return next(new AppError(incomingIdentityInfo.message, 400));
        }
        if (!incomingIdentityInfo.identityInfo.alive) {
          await BadEvent.create({
            place: "GetOtherIdentity",
            payload: JSON.stringify({
              incoming: req.user._id,
              error: "Dead Guy",
            }),
          });
          return next(new AppError("شخص موردنظر متوفی میباشد", 400));
        }
        const {
          nationalCode,
          firstName,
          lastName,
          fatherName,
          gender,
          identificationNumber,
          identificationSerialCode,
          identificationSerialNumber,
          birthPlaceCode,
          birthPlace,
        } = incomingIdentityInfo.identityInfo;
        pendingUser = {
          phone,
          nationalCode,
          firstName,
          lastName,
          fatherName,
          gender: gender.toLowerCase() as Gender,
          identificationNumber: identificationNumber.toString(),
          identificationSerialCode,
          identificationSerialNumber: identificationSerialNumber.toString(),
          birthPlaceCode: birthPlaceCode.toString(),
          birthPlace,
          birthDate: incomingBirthDate,
          matched: false,
        };
      } catch (e: unknown) {
        await BadEvent.create({
          place: "GetOtherIdentity",
          payload: JSON.stringify({
            incoming: phone,
            errro: e instanceof Error ? e.message : "UNKOWN",
          }),
        });
      }
      if (!pendingUser) return next(new ServerError());
      if (phone) {
        try {
          const response = await fetch(env.podiumUrl, {
            method: "POST",
            headers: {
              Authorization: `bearer ${env.PODIUM_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              productEntityId: "46645324",
              apiKey: env.MATCH_NATIONAL_ID_AND_PHONE_NUMBER_API_KEY,
              providerParameters: {
                body: {
                  nationalCode: pendingUser.nationalCode,
                  mobileNumber: phone,
                },
              },
            }),
          });
          const data = (await response.json()) as PodiumReponse;
          if (!data.result) {
            await BadEvent.create({
              place: "matchNationalIdAndPhoneOther",
              payload: JSON.stringify({
                incoming: phone,
                errro: "Bad Response",
              }),
            });
            return next(new AppError("مشکلی در دریافت اطلاعات پیش آمد", 400));
          }
          try {
            const matchResult = JSON.parse(
              data.result
            ) as MatchNationalIdAndPhoneNumberResponse;
            if (!matchResult.matched)
              return next(
                new AppError(
                  "این شماره موبایل با کد ملی وارد شده تطابق ندارد",
                  400
                )
              );
            pendingUser.matched = true;
            // await PendingUser.findByIdAndUpdate(pendingUser._id, {
            //   matched: true,
            // });
          } catch {
            await BadEvent.create({
              place: "matchNationalIdAndPhoneOther",
              payload: JSON.stringify({
                incoming: req.user._id,
                errro: "Response is NOt JSON",
              }),
            });
            return next(new AppError("مشکلی در دریافت اطلاعات پیش آمد", 400));
          }
        } catch (e) {
          await BadEvent.create({
            place: "matchNationalIdAndPhoneOther",
            payload: JSON.stringify({
              incoming: req.user._id,
              errro: e instanceof Error ? e.message : "UNknonw",
            }),
          });
        }
      }
      let user: IUser | undefined;
      if (phone) {
        user = await User.create({ phone: phone });
      }
      const {
        nationalCode,
        firstName,
        lastName,
        fatherName,
        gender,
        identificationNumber,
        identificationSerialCode,
        identificationSerialNumber,
        birthPlaceCode,
        birthPlace,
        birthDate,
      } = pendingUser;
      const identity = await UserIdentity.create({
        user: user?._id,
        nationalId: nationalCode,
        givenName: firstName,
        lastName,
        gender,
        dateOfbirth: birthDate,
        fatherName,
        identificationNumber,
        identificationSerialCode,
        identificationSerialNumber,
        birthPlaceCode,
        birthPlace,
      });
      await Relative.findOneAndUpdate(
        {
          user: req.user._id,
          other: identity._id,
        },
        { user: req.user._id, other: identity._id },
        { upsert: true }
      );
      res.status(200).json({ message: "getOtherIdentity", data: identity });
    }
    res.status(200).json({ message: "getOtherIdentity" });
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
    }).populate([
      {
        path: "checkout",
      },
      {
        path: "session",
        populate: [
          { path: "doctor" },
          { path: "booking", populate: { path: "patient" } },
        ],
      },
    ]);
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
    }).populate([{ path: "doctor" }, { path: "session" }]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyBooking", data });
  }
);

export const getMyCurrentVital: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await UserVital.findOne({ user: req.user._id }).sort({
      createdAt: -1,
    });
    res.status(200).json({ message: "getMyCurrentVital", data });
  }
);

export const getMyVitalHistory: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await UserVital.find({ user: req.user._id }).populate({
      path: "author",
      select: { firstName: 1, lastName: 1 },
    });
    res.status(200).json({ message: "getMyVitalHistory", data });
  }
);

export const getMyMedicalDetails: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await MedicalDetail.findOneAndUpdate(
      { user: req.user._id },
      { user: req.user._id },
      { upsert: true, new: true }
    );
    res.status(200).json({ message: "getMyMedicalDetails", data });
  }
);

const editMedicalDetailsSchema = z.strictObject({
  bloodType: z.enum(bloodTypes).optional(),
  height: numerish(0, 300).optional(),
  weight: numerish(0, 300).optional(),
});

("5420034875-1b09bdf45d8844d9b4f746c44a5af008.XzIwMjU5");

export const editMyMedicalDetails: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { success, data } = await editMedicalDetailsSchema.safeParseAsync(
      req.body
    );
    if (!success) return;
    await MedicalDetail.findOneAndUpdate(
      { user: req.user._id },
      { user: req.user._id, ...data },
      { upsert: true }
    );
    res.status(200).json({ message: "editMyMedicalDetails" });
  }
);
