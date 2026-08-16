import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  MiddlewareError,
  MissingIdentityError,
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
import { isPhone, isSSID, isPositiveInt } from "../Lib/validators";
import { pageLimit } from "../Lib/enums";
import Notification from "../Models/Notification";
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
import UserRelative from "../Models/UserRelative";
import { getPodiumIdentity, shahkar } from "../Lib/Podium";
import Wallet from "../Models/Wallet";
import InlineAdvertisement from "../Models/InlineAdvertisement";
import Reservation from "../Models/Reservation";

export const getMe: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    res.status(200).json({ message: `getMe`, data: { data: req.user } });
  },
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
        req.file.buffer,
      );
    }
    await User.findByIdAndUpdate(req.user._id, { ...data, avatar });
    res.status(200).json({ message: "editMe" });
  },
);

export const getMyIdentity: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await UserIdentity.findOne({ user: req.user._id });
    res.status(200).json({ message: "getMyIdentity", data });
  },
);

// const getOtherIdentitySchema = z.strictObject({
//   birthDate: datish,
//   nationalId: z.string(),
//   mobileNumber: z.string().optional(),
// });
// export const getOtherIdentity: RequestHandler = catchAsync(
//   async (req: Request, res: Response, next: NextFunction) => {
//     if (!req.user) return next(new MiddlewareError());
//     const { data, success } = await getOtherIdentitySchema.safeParseAsync(
//       req.body,
//     );
//     if (!success) return next(new BadInputError());
//     const phone = isPhone(data.mobileNumber);
//     if (data.mobileNumber && !phone) return next(new BadInputError());
//     if (!isSSID(data.nationalId)) return next(new BadInputError());
//     const incomingBirthDate = new Date(data.birthDate);
//     const now = new Date();
//     if (phone) {
//       if (
//         now.getTime() - incomingBirthDate.getTime() <
//         18 * 365 * 24 * 60 * 60 * 1000
//       )
//         return next(
//           new AppError(
//             "برای افزودن بیمار بالای 18 سال باید موبایل رو وارد کنید",
//             400,
//           ),
//         );
//     }
//     const existing = await UserIdentity.findOne({
//       nationalId: data.nationalId,
//     });
//     if (existing) {
//       if (
//         incomingBirthDate.toLocaleDateString("fa-IR") !==
//         new Date(existing.dateOfbirth).toLocaleDateString("fa-IR")
//       )
//         return next(new AppError("اطلاعات وارد شده مطابقت ندارد", 400));
//       res.status(200).json({ message: "getOtherIdentity", data: existing });
//     } else {
//       ///////////////////////////////////////
//       const {
//         status: identityStatus,
//         data: incomingIdentity,
//         error: identityError,
//       } = await getPodiumIdentity({
//         birthdate: incomingBirthDate,
//         nationalId: data.nationalId,
//         requester: req.user,
//       });
//       if (!identityStatus) {
//         return next(new AppError(identityError, 400));
//       }
//       let pendingUser: Partial<IPendingUser> | undefined;
//       const {
//         nationalCode,
//         firstName,
//         lastName,
//         fatherName,
//         gender,
//         identificationNumber,
//         identificationSerialCode,
//         identificationSerialNumber,
//         birthPlaceCode,
//         birthPlace,
//       } = incomingIdentity;
//       pendingUser = {
//         phone,
//         nationalCode,
//         firstName,
//         lastName,
//         fatherName,
//         gender: gender.toLowerCase() as Gender,
//         identificationNumber: identificationNumber.toString(),
//         identificationSerialCode,
//         identificationSerialNumber: identificationSerialNumber.toString(),
//         birthPlaceCode: birthPlaceCode.toString(),
//         birthPlace,
//         birthDate: incomingBirthDate,
//         matched: false,
//       };
//       if (!pendingUser) return next(new ServerError());
//       if (phone) {
//         try {
//           const response = await fetch(env.podiumUrl, {
//             method: "POST",
//             headers: {
//               Authorization: `bearer ${env.PODIUM_TOKEN}`,
//               "Content-Type": "application/json",
//             },
//             body: JSON.stringify({
//               productEntityId: "46645324",
//               apiKey: env.MATCH_NATIONAL_ID_AND_PHONE_NUMBER_API_KEY,
//               providerParameters: {
//                 body: {
//                   nationalCode: pendingUser.nationalCode,
//                   mobileNumber: phone,
//                 },
//               },
//             }),
//           });
//           const data = (await response.json()) as PodiumReponse;
//           if (!data.result) {
//             await BadEvent.create({
//               place: "matchNationalIdAndPhoneOther",
//               payload: JSON.stringify({
//                 incoming: phone,
//                 errro: "Bad Response",
//               }),
//             });
//             return next(new AppError("مشکلی در دریافت اطلاعات پیش آمد", 400));
//           }
//           try {
//             const matchResult = JSON.parse(
//               data.result,
//             ) as MatchNationalIdAndPhoneNumberResponse;
//             if (!matchResult.matched)
//               return next(
//                 new AppError(
//                   "این شماره موبایل با کد ملی وارد شده تطابق ندارد",
//                   400,
//                 ),
//               );
//             pendingUser.matched = true;
//             // await PendingUser.findByIdAndUpdate(pendingUser._id, {
//             //   matched: true,
//             // });
//           } catch {
//             await BadEvent.create({
//               place: "matchNationalIdAndPhoneOther",
//               payload: JSON.stringify({
//                 incoming: req.user._id,
//                 errro: "Response is NOt JSON",
//               }),
//             });
//             return next(new AppError("مشکلی در دریافت اطلاعات پیش آمد", 400));
//           }
//         } catch (e) {
//           await BadEvent.create({
//             place: "matchNationalIdAndPhoneOther",
//             payload: JSON.stringify({
//               incoming: req.user._id,
//               errro: e instanceof Error ? e.message : "UNknonw",
//             }),
//           });
//         }
//       }
//       let user: IUser | undefined;
//       if (phone) {
//         user = await User.create({ phone: phone });
//       }
//       const {
//         nationalCode,
//         firstName,
//         lastName,
//         fatherName,
//         gender,
//         identificationNumber,
//         identificationSerialCode,
//         identificationSerialNumber,
//         birthPlaceCode,
//         birthPlace,
//         birthDate,
//       } = pendingUser;
//       const identity = await UserIdentity.create({
//         user: user?._id,
//         nationalId: nationalCode,
//         givenName: firstName,
//         lastName,
//         gender,
//         dateOfbirth: birthDate,
//         fatherName,
//         identificationNumber,
//         identificationSerialCode,
//         identificationSerialNumber,
//         birthPlaceCode,
//         birthPlace,
//       });
//       await Relative.findOneAndUpdate(
//         {
//           user: req.user._id,
//           other: identity._id,
//         },
//         { user: req.user._id, other: identity._id },
//         { upsert: true },
//       );
//       res.status(200).json({ message: "getOtherIdentity", data: identity });
//     }
//     res.status(200).json({ message: "getOtherIdentity" });
//   },
// );

export const getMyRelatives: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await UserRelative.find({ user: req.user._id });
    res.status(200).json({ message: "getMyRelatives", data });
  },
);

const addRelativeSchema = z.strictObject({
  nationalCode: z
    .string()
    .regex(/[0-9]*/)
    .length(10),
  birthDate: datish,
  phone: z
    .string()
    .regex(/[0-9]*/)
    .length(11),
});
export const addRelative: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const thisUserIdentity = await UserIdentity.findOne({ user: req.user._id });
    if (!thisUserIdentity)
      return next(new AppError("احراز هویت شما انجام نشده است", 400));
    const { success, data, error } = await addRelativeSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError(error.message));
    const existing = await UserIdentity.findOne({
      nationalId: data.nationalCode,
    });
    if (!!existing) {
      if (thisUserIdentity._id.toString() === existing._id.toString())
        return next(new AppError("شما مشخصات خود را وارد کرده اید", 400));
      const dupRelative = await UserRelative.exists({
        user: req.user._id,
        other: existing._id,
      });
      if (dupRelative)
        return next(new BadInputError("این شخص را قبلا اضافه کردید"));
      if (
        new Date(existing.dateOfbirth).toLocaleDateString("fa-IR") !==
        new Date(data.birthDate).toLocaleDateString("fa-IR")
      )
        return next(new NotFoundError());
      await UserRelative.create({ user: req.user._id, other: existing._id });
    } else {
      const {
        status: identityStatus,
        data: identityData,
        error: identityError,
      } = await getPodiumIdentity({
        nationalId: data.nationalCode,
        birthdate: data.birthDate,
        requester: req.user,
      });
      if (!identityStatus) {
        return next(new AppError(identityError, 400));
      }
      const { status: matchStatus, error: matchError } = await shahkar({
        phone: data.phone,
        nationalCode: data.nationalCode,
        requester: req.user,
      });
      if (!matchStatus) return next(new AppError(matchError, 400));
      const newIdentity = await UserIdentity.create({
        nationalId: identityData.nationalCode,
        givenName: identityData.firstName,
        lastName: identityData.lastName,
        gender: identityData.gender.toLowerCase(),
        dateOfbirth: data.birthDate,
        fatherName: identityData.fatherName,
        identificationNumber: identityData.identificationNumber,
        identificationSerialCode: identityData.identificationSerialCode,
        identificationSerialNumber: identityData.identificationSerialNumber,
        birthPlaceCode: identityData.birthPlaceCode,
        birthPlace: identityData.birthPlace,
        phones: [data.phone],
      });
      await UserRelative.create({ user: req.user._id, other: newIdentity._id });
    }
    res.status(200).json({ message: "addRelative" });
  },
);

export const getWallet: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await Wallet.findOneAndUpdate(
      { user: req.user._id },
      { user: req.user._id },
      { upsert: true, new: true },
    );
    res.status(200).json({ message: "getWallet", data });
  },
);

export const getMyInvoices: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    //TODO: maybe add pagination shit
    const data = await Invoice.find({ user: req.user._id }).populate({
      path: "checkout",
    });
    res.status(200).json({ message: "getMyInvoices", data });
  },
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
  },
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
  },
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
  },
);

export const getMyCurrentVital: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await UserVital.findOne({ user: req.user._id }).sort({
      createdAt: -1,
    });
    res.status(200).json({ message: "getMyCurrentVital", data });
  },
);

export const getMyVitalHistory: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await UserVital.find({ user: req.user._id }).populate({
      path: "author",
      select: { firstName: 1, lastName: 1 },
    });
    res.status(200).json({ message: "getMyVitalHistory", data });
  },
);

export const getMyMedicalDetails: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await MedicalDetail.findOneAndUpdate(
      { user: req.user._id },
      { user: req.user._id },
      { upsert: true, new: true },
    );
    res.status(200).json({ message: "getMyMedicalDetails", data });
  },
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
      req.body,
    );
    if (!success) return;
    await MedicalDetail.findOneAndUpdate(
      { user: req.user._id },
      { user: req.user._id, ...data },
      { upsert: true },
    );
    res.status(200).json({ message: "editMyMedicalDetails" });
  },
);

export const getMyNotifications: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { page: _page, unread: _unread } = req.query;
    let page = 1;
    if (_page !== undefined) {
      const parsed = Number(_page);
      if (!isPositiveInt(parsed)) return next(new BadInputError());
      page = parsed;
    }
    const query: Record<string, unknown> = { user: req.user._id };
    if (_unread === "true") query.isRead = false;
    const [data, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1, _id: -1 })
        .limit(pageLimit)
        .skip((page - 1) * pageLimit)
        .populate({ path: "createdBy", select: { username: 1, avatar: 1 } }),
      Notification.countDocuments(query),
      Notification.countDocuments({ user: req.user._id, isRead: false }),
    ]);
    res.status(200).json({
      message: "getMyNotifications",
      data: { data, total, page, unreadCount },
    });
  },
);

export const getMyUnreadNotificationsCount: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const count = await Notification.countDocuments({
      user: req.user._id,
      isRead: false,
    });
    res
      .status(200)
      .json({ message: "getMyUnreadNotificationsCount", data: { count } });
  },
);

export const getMyNotification: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Notification.findOne({
      _id: nodeId,
      user: req.user._id,
    }).populate({ path: "createdBy", select: { username: 1, avatar: 1 } });
    if (!data) return next(new NotFoundError());
    await data.markAsRead();
    res.status(200).json({ message: "getMyNotification", data });
  },
);

export const markMyNotificationAsRead: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const notification = await Notification.findOne({
      _id: nodeId,
      user: req.user._id,
    });
    if (!notification) return next(new NotFoundError());
    await notification.markAsRead();
    res.status(200).json({ message: "markMyNotificationAsRead" });
  },
);

export const markAllMyNotificationsAsRead: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    await Notification.updateMany(
      { user: req.user._id, isRead: false },
      { isRead: true, readAt: new Date() },
    );
    res.status(200).json({ message: "markAllMyNotificationsAsRead" });
  },
);

export const getMyReservations: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const identity = await UserIdentity.findOne({ user: req.user._id });
    if (!identity) return next(new MissingIdentityError());
    const data = await Reservation.find({ patient: identity._id }).populate([
      { path: "doctor" },
      { path: "user" },
      { path: "office" },
    ]);
    res.status(200).json({ message: "getMyReservations", data });
  },
);

export const getMyReservation: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Reservation.findOne({
      _id: nodeId,
      user: req.user._id,
    }).populate([
      { path: "doctor" },
      { path: "user" },
      { path: "office" },
      { path: "patient" },
      { path: "transaction" },
    ]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyReservation", data });
  },
);
