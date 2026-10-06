import { sameCalendarDay } from "../Lib/tehranTime";
import { freeCancelHoursFor } from "../Lib/patientPro";
import { notifyUserAlertSubscribers } from "../Services/userAlertService";
import { requestLocale } from "../Lib/locales";
import { translateNotification } from "../Lib/i18n/translateNotification";
import {
  notifySellerOfBuyerCancel,
  settleOrderLine,
} from "../Services/orderSettlementService";
import { NextFunction, Request, RequestHandler, Response } from "express";
import DoctorFeedBack from "../Models/DoctorFeedback";
import {
  cancelReservation,
  patientCanCancel,
  getPatientFreeCancelHours,
} from "../Services/reservationCancelService";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  MiddlewareError,
  MissingIdentityError,
  NotFoundError,
  ServerError,
} from "../Lib/AppError";
import Invoice from "../Models/Invoice";
import InvoiceCheckout from "../Models/InvocieCheckout";
import { isValidObjectId } from "mongoose";
import Booking from "../Models/Booking";
import UserIdentity from "../Models/UserIdentity";
import * as z from "zod";
import fs from "fs/promises";
import path from "path";
import User, { IUser } from "../Models/User";
import UserVital from "../Models/UserVitals";
import MedicalDetail, { bloodTypes } from "../Models/MedicalDetail";
import { datish, isPoint, numerish } from "../Lib/helpers";
import City from "../Models/Geo/City";
import UserAddress from "../Models/UserAddress";
import { isPhone, isSSID, isPositiveInt } from "../Lib/validators";
import { pageLimit } from "../Lib/enums";
import Notification from "../Models/Notification";
import PushSubscription from "../Models/PushSubscription";
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
import VisitIntake from "../Models/VisitIntake";
import Transaction from "../Models/Transaction";
import Order from "../Models/Order";

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
    const data = await UserRelative.find({ user: req.user._id }).populate({
      path: "other",
    });
    res
      .status(200)
      .json({ message: "getMyRelatives", data: data.map((el) => el.other) });
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
const completeIdentitySchema = z.strictObject({
  nationalId: z.string().regex(/^[0-9]{10}$/),
  birthDate: datish,
});

// POST /user/identity {nationalId, birthDate} - identity verification for
// an account that has none yet (2026-09). Signup already does this, but
// accounts created another way (migrated from the old database, created by
// an admin) had no way to add it, and every flow that needs an identity -
// becoming a doctor, booking for oneself - was a dead end. Same checks as
// signup: 18+, national ID not taken by another account, Sabt (civil
// registry) lookup, and Shahkar to confirm this phone belongs to that ID.
export const completeMyIdentity: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const own = await UserIdentity.exists({ user: req.user._id });
    if (own)
      return next(new AppError("احراز هویت شما قبلا انجام شده است", 400));
    const { success, data } = await completeIdentitySchema.safeParseAsync(
      req.body,
    );
    if (!success || !isSSID(data.nationalId))
      return next(new AppError("کد ملی وارد شده در سامانه یافت نشد", 400));
    const birthDate = new Date(data.birthDate);
    if (isNaN(birthDate.getTime())) return next(new BadInputError());
    if (Date.now() - birthDate.getTime() < 18 * 365 * 24 * 60 * 60 * 1000)
      return next(
        new AppError("برای ثبت نام باید حداقل 18 سال سن داشته باشید", 400),
      );
    const taken = await UserIdentity.exists({
      nationalId: data.nationalId,
      user: { $exists: true },
    });
    if (taken)
      return next(
        new AppError(
          "با این کد ملی و شماره دیگری فبلا در سایت ثبت نام شده لطفا با همان شماره وارد شوید",
          400,
        ),
      );
    const {
      status: identityStatus,
      data: identityData,
      error: identityError,
    } = await getPodiumIdentity({
      nationalId: data.nationalId,
      birthdate: birthDate,
      requester: req.user,
    });
    if (!identityStatus) return next(new AppError(identityError, 400));
    const { status: matchStatus, error: matchError } = await shahkar({
      phone: req.user.phone,
      nationalCode: data.nationalId,
      requester: req.user,
    });
    if (!matchStatus) return next(new AppError(matchError, 400));
    // an identity may already exist without an owner (added earlier as
    // someone's relative) - attach it rather than create a duplicate
    const identity = await UserIdentity.findOneAndUpdate(
      { nationalId: identityData.nationalCode },
      {
        user: req.user._id,
        nationalId: identityData.nationalCode,
        givenName: identityData.firstName,
        lastName: identityData.lastName,
        gender: identityData.gender?.toLowerCase(),
        dateOfbirth: birthDate,
        fatherName: identityData.fatherName,
        identificationNumber: identityData.identificationNumber,
        identificationSerialCode: identityData.identificationSerialCode,
        identificationSerialNumber: identityData.identificationSerialNumber,
        birthPlaceCode: identityData.birthPlaceCode,
        birthPlace: identityData.birthPlace,
      },
      { upsert: true, new: true },
    );
    res.status(200).json({ message: "completeMyIdentity", data: identity });
  },
);

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
      // the same calendar day, read in Tehran (Lib/tehranTime.ts), not in
      // the server's zone
      if (!sameCalendarDay(existing.dateOfbirth, data.birthDate))
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
    const { page: _page } = req.query;
    let page = 1;
    if (_page !== undefined) {
      const parsed = Number(_page);
      if (!isPositiveInt(parsed)) return next(new BadInputError());
      page = parsed;
    }
    const { status } = req.query;
    if (status !== undefined && status !== "paid" && status !== "unpaid")
      return next(new BadInputError());
    // checkout is a virtual, so paid/unpaid is resolved through the
    // checkouts of this user's invoices; a patient has few invoices, so
    // the same pass also yields the summary tiles.
    const mine = await Invoice.find({ user: req.user._id }).select("total").lean();
    const paidIds = await InvoiceCheckout.distinct("invoice", {
      invoice: { $in: mine.map((i) => i._id) },
    });
    const paidSet = new Set(paidIds.map(String));
    const summary = mine.reduce(
      (acc, i) => {
        if (paidSet.has(String(i._id))) {
          acc.paidTotal += i.total || 0;
          acc.paidCount++;
        } else {
          acc.unpaidTotal += i.total || 0;
          acc.unpaidCount++;
        }
        return acc;
      },
      { paidTotal: 0, paidCount: 0, unpaidTotal: 0, unpaidCount: 0 },
    );
    const query: Record<string, unknown> = { user: req.user._id };
    if (status === "paid") query._id = { $in: paidIds };
    if (status === "unpaid") query._id = { $nin: paidIds };
    const [data, total] = await Promise.all([
      Invoice.find(query)
        .sort({ submittedAt: -1, _id: -1 })
        .limit(pageLimit)
        .skip((page - 1) * pageLimit)
        .populate([
          { path: "checkout" },
          {
            path: "session",
            select: "doctor date start end",
            populate: {
              path: "doctor",
              select: "firstName lastName avatar mainSpeciality",
              populate: { path: "mainSpeciality", select: "name" },
            },
          },
        ]),
      Invoice.countDocuments(query),
    ]);
    res.status(200).json({
      message: "getMyInvoices",
      data: { data, total, page, summary },
    });
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
    if (!req.user) return next(new MiddlewareError());
    const { page: _page } = req.query;
    let page = 1;
    if (_page !== undefined) {
      const parsed = Number(_page);
      if (!isPositiveInt(parsed)) return next(new BadInputError());
      page = parsed;
    }
    const query = { user: req.user._id };
    const [data, total] = await Promise.all([
      Booking.find(query)
        .sort({ bookedAt: -1, _id: -1 })
        .limit(pageLimit)
        .skip((page - 1) * pageLimit)
        .populate([{ path: "doctor" }, { path: "session" }]),
      Booking.countDocuments(query),
    ]);
    res.status(200).json({
      message: "getMyBookings",
      data: { data, total, page },
    });
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
    const locale = requestLocale(req.headers);
    res.status(200).json({
      message: "getMyNotifications",
      data: {
        data: data.map((n) => translateNotification(n.toObject(), locale)),
        total,
        page,
        unreadCount,
      },
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
    res.status(200).json({
      message: "getMyNotification",
      data: translateNotification(data.toObject(), requestLocale(req.headers)),
    });
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

// --- Web push (Services/pushNotificationService.ts) -----------------------
// The public key is handed to PushManager.subscribe() as the
// applicationServerKey; subscribe/unsubscribe persist/remove the
// PushSubscription doc that sendPushToUser() reads from whenever a
// Notification gets created (see Models/Notification.ts).

export const getPushPublicKey: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    res.status(200).json({
      message: "getPushPublicKey",
      data: { publicKey: env.VAPID_PUBLIC_KEY },
    });
  },
);

const subscribeToPushSchema = z.strictObject({
  endpoint: z.string().min(1),
  keys: z.strictObject({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().optional(),
});

export const subscribeToPush: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await subscribeToPushSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    // A browser occasionally reuses the same endpoint for a fresh
    // subscription (e.g. after the user re-grants permission) - upsert by
    // endpoint rather than user, so that doesn't create a duplicate that
    // trips the unique index, and correctly re-homes it if a different
    // account subscribes from the same browser profile.
    await PushSubscription.findOneAndUpdate(
      { endpoint: data.endpoint },
      { ...data, user: req.user._id, locale: requestLocale(req.headers) },
      { upsert: true },
    );
    res.status(200).json({ message: "subscribeToPush" });
  },
);

const unsubscribeFromPushSchema = z.strictObject({
  endpoint: z.string().min(1),
});

export const unsubscribeFromPush: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await unsubscribeFromPushSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    await PushSubscription.deleteOne({
      endpoint: data.endpoint,
      user: req.user._id,
    });
    res.status(200).json({ message: "unsubscribeFromPush" });
  },
);

export const getMyTransactions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await Transaction.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .populate([
        {
          path: "reservation",
          populate: [{ path: "doctor" }, { path: "patient" }],
        },
      ]);
    res.status(200).json({ message: "getMyTransactions", data });
  },
);

export const getMyReservations: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const identity = await UserIdentity.findOne({ user: req.user._id });
    if (!identity) return next(new MissingIdentityError());
    const reservations = await Reservation.find({ patient: identity._id }).populate([
      { path: "doctor", populate: { path: "mainSpeciality", select: "name" } },
      { path: "user" },
      { path: "office" },
    ]);
    // pre-visit questionnaire status for the open ones (list chip + the
    // assistant's "fill the questionnaire" hint)
    const open = reservations.filter((r) => ["pending", "active"].includes(r.status)).map((r) => r._id);
    const filled = new Set(
      open.length
        ? (await VisitIntake.find({ reservation: { $in: open } }).distinct("reservation")).map(String)
        : [],
    );
    const data = reservations.map((r) => ({
      ...r.toObject(),
      intakeFilled: filled.has(String(r._id)),
    }));
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

const cancelMyReservationSchema = z.strictObject({
  reason: z.string().max(500).optional(),
});

// Patient-side cancel (2026-09): free, fully refunded to the wallet, up to
// the super admin's free-cancel window (AppConfig.patientFreeCancelHours,
// default 24h) before the start - the booking page promises exactly that. Later than that the patient has to contact the office.
export const cancelMyReservation: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data: input, success } =
      await cancelMyReservationSchema.safeParseAsync(req.body ?? {});
    if (!success) return next(new BadInputError());
    const reservation = await Reservation.findOne({
      _id: nodeId,
      user: req.user._id,
    });
    if (!reservation) return next(new NotFoundError());
    if (reservation.status !== "pending")
      return next(new AppError("این نوبت قابل لغو نیست", 400));
    // a «پرو» member's window is shorter (Lib/patientPro.ts)
    const freeCancelHours = await freeCancelHoursFor(
      req.user._id,
      await getPatientFreeCancelHours(),
    );
    if (!patientCanCancel(reservation, new Date(), freeCancelHours))
      return next(
        new AppError(
          `لغو آنلاین نوبت فقط تا ${freeCancelHours.toLocaleString("fa-IR")} ساعت پیش از زمان نوبت ممکن است`,
          400,
        ),
      );
    const data = await cancelReservation(nodeId, "patient", input.reason);
    if (!data) return next(new AppError("این نوبت قابل لغو نیست", 400));
    res.status(200).json({ message: "cancelMyReservation", data });
  },
);

// The patient's objection to an in-person visit that was counted as done
// without a check-in (2026-10): only within the dispute window, once. The
// reservation becomes a doctor no-show claim in the admin's "needs action"
// queue; the doctor's payout is still in its settlement hold, so an
// upheld objection refunds the patient from it (adminReservationController
// resolve "refund"), a rejected one keeps the visit as done ("complete").
const disputeMyReservationSchema = z.strictObject({
  reason: z.string().trim().min(3).max(1000),
});

export const disputeMyReservation: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = disputeMyReservationSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return next(new AppError("دلیل اعتراض را بنویسید", 400));
    const now = new Date();
    const data = await Reservation.findOneAndUpdate(
      {
        _id: nodeId,
        user: req.user._id,
        status: "completed",
        autoCompleted: true,
        disputeDeadline: { $gt: now },
        dispute: { $exists: false },
      },
      {
        $set: {
          status: "noShow",
          noShowParty: "doctor",
          dispute: { at: now, reason: parsed.data.reason },
        },
      },
      { new: true },
    );
    if (!data)
      return next(
        new AppError("مهلت اعتراض به این نوبت تمام شده یا قبلاً اعتراض کرده‌اید", 400),
      );
    notifyUserAlertSubscribers(
      "newVisitDispute",
      {
        title: "اعتراض به ویزیت",
        message: "بیماری می‌گوید ویزیت حضوری‌اش انجام نشده است؛ نوبت در صف «نیاز به اقدام» است.",
        link: `/notadmin/reservation/${data._id}`,
      },
      { reservationId: String(data._id), userPhone: req.user.phone },
    ).catch(() => {});
    res.status(200).json({ message: "disputeMyReservation", data });
  },
);

// Verified visit reviews (2026-09): only the account that booked a visit,
// only once it's completed, one review per visit - like Zocdoc /
// Docplanner / Paziresh24 "verified patient" reviews.
const REVIEW_WINDOW_DAYS = 60;
const scoreSchema = z.coerce.number().int().min(1).max(5);
const submitVisitFeedbackSchema = z.strictObject({
  overalScore: scoreSchema,
  behavior: scoreSchema.optional(),
  commiunication: scoreSchema.optional(),
  booking: scoreSchema.optional(),
  environment: scoreSchema.optional(),
  waitTime: z.coerce.number().int().min(0).max(600).optional(),
  suggest: z.preprocess(
    (v) => (v === "true" ? true : v === "false" ? false : v),
    z.boolean(),
  ),
  publicMessage: z.string().trim().max(1000).optional(),
  privateMessage: z.string().trim().max(1000).optional(),
});

export const getMyVisitFeedback: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const reservation = await Reservation.findOne({
      _id: nodeId,
      user: req.user._id,
    }).select({ _id: 1 });
    if (!reservation) return next(new NotFoundError());
    const data = await DoctorFeedBack.findOne({
      reservation: reservation._id,
    }).select({ privateMessage: 0 });
    res.status(200).json({ message: "getMyVisitFeedback", data });
  },
);

export const submitMyVisitFeedback: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data: input, success, error } =
      await submitVisitFeedbackSchema.safeParseAsync(req.body ?? {});
    if (!success) return next(new BadInputError(error.message));
    const reservation = await Reservation.findOne({
      _id: nodeId,
      user: req.user._id,
    });
    if (!reservation) return next(new NotFoundError());
    if (reservation.status !== "completed")
      return next(
        new AppError("فقط پس از انجام ویزیت می‌توانید نظر ثبت کنید", 400),
      );
    const doneAt = reservation.finalizedAt ?? reservation.date;
    if (
      Date.now() - new Date(doneAt).getTime() >
      REVIEW_WINDOW_DAYS * 24 * 3600 * 1000
    )
      return next(new AppError("مهلت ثبت نظر برای این ویزیت تمام شده است", 400));
    if (await DoctorFeedBack.exists({ reservation: reservation._id }))
      return next(new AppError("برای این ویزیت قبلا نظر ثبت کرده‌اید", 400));
    const score = input.overalScore;
    const data = await DoctorFeedBack.create({
      ...input,
      // sub-scores default to the overall score when skipped
      behavior: input.behavior ?? score,
      commiunication: input.commiunication ?? score,
      skill: score,
      booking: input.booking ?? score,
      environment: input.environment ?? score,
      waitTime: input.waitTime ?? 0,
      doctor: reservation.doctor,
      user: req.user._id,
      reservation: reservation._id,
    });
    res.status(200).json({ message: "submitMyVisitFeedback", data });
  },
);

export const getMyOrders: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    // item names only (the list shows what was ordered; the full order is
    // on /order/:id)
    const data = await Order.find({ user: req.user._id })
      .sort({ submittedAt: -1 })
      .populate([
        { path: "products.item", select: "product", populate: { path: "product", select: "name" } },
        { path: "productPackages.item", select: "name" },
        { path: "services.item", select: "name" },
        { path: "servicePackages.item", select: "name" },
        { path: "tests.item", select: "test", populate: { path: "test", select: "name" } },
      ]);
    res.status(200).json({ message: "getMyOrders", data });
  },
);

export const getMyOrder: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Order.findOne({
      _id: nodeId,
      user: req.user._id,
    }).populate([
      {
        path: "products",
        populate: {
          path: "item",
          populate: [{ path: "seller" }, { path: "product" }],
        },
      },
      { path: "productPackages", populate: { path: "item" } },
      { path: "services", populate: { path: "item" } },
      { path: "servicePackages", populate: { path: "item" } },
      {
        path: "tests",
        populate: {
          path: "item",
          populate: [{ path: "test" }, { path: "paraClinic" }],
        },
      },
      { path: "transaction" },
      { path: "address" },
      { path: "shipments.pharmacy", select: "name" },
    ]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyOrder", data });
  },
);

export const getMyAddresses: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await UserAddress.find({
      user: req.user._id,
      archived: { $ne: true },
    }).populate([
      { path: "city", select: "name province" },
      { path: "province", select: "name" },
      { path: "district", select: "name" },
    ]);
    res.status(200).json({ message: "getMyAddresses", data });
  },
);

export const getMyAddress: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await UserAddress.findOne({
      _id: nodeId,
      user: req.user._id,
      archived: { $ne: true },
    }).populate([
      { path: "city", select: "name province" },
      { path: "province", select: "name" },
      { path: "district", select: "name" },
    ]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyAddress", data });
  },
);

// Buyer cancels an order before it is prepared (2026-09, the Digikala /
// Halodoc rule): every line still "pending" is cancelled and refunded to the
// wallet through the same per-line settlement a seller's cancel uses. Lines a
// seller already fulfilled or cancelled are left as they are.
const orderLineModels = [
  "products",
  "productPackages",
  "services",
  "servicePackages",
  "tests",
] as const;

export const cancelMyOrder: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const order = await Order.findOne({
      _id: nodeId,
      user: req.user._id,
      status: "paid",
    });
    if (!order) return next(new NotFoundError());
    let cancelled = 0;
    for (const model of orderLineModels) {
      const lines = ((order as unknown as Record<string, { _id: unknown; item: unknown; status: string }[]>)[model] || []);
      for (const line of lines) {
        if (line.status !== "pending") continue;
        // conditional on "pending": a seller acting at the same moment wins
        const updated = await Order.findOneAndUpdate(
          {
            _id: order._id,
            [model]: { $elemMatch: { _id: line._id, status: "pending" } },
          },
          { $set: { [`${model}.$.status`]: "cancelled" } },
          { new: true },
        );
        if (!updated) continue;
        await settleOrderLine({ order: updated, model, itemId: String(line.item) });
        await notifySellerOfBuyerCancel(order._id, model, String(line.item));
        cancelled++;
      }
    }
    if (!cancelled) return next(new NotFoundError());
    res.status(200).json({ message: "cancelMyOrder", data: { cancelled } });
  },
);

// Persian / Arabic digits -> ASCII, then keep digits only
const onlyDigits = (value: string) =>
  value
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/\D/g, "");
// an Iranian mobile in any common spelling (0912..., 912..., +98912...) -> 98912...
const receiverPhoneField = z
  .string()
  .transform(onlyDigits)
  .transform((v) => v.replace(/^(0098|98|0)?(9\d{9})$/, "98$2"))
  .refine((v) => /^989\d{9}$/.test(v));
const postalCodeField = z
  .string()
  .transform(onlyDigits)
  .refine((v) => v === "" || /^\d{10}$/.test(v));

const objectIdField = z.string().regex(/^[0-9a-fA-F]{24}$/);

const createMyAddressSchema = z.strictObject({
  displayName: z.string().trim().max(60).optional(),
  address: z.string().trim().max(500).optional(),
  receiverPhone: receiverPhoneField.optional(),
  postalCode: postalCodeField.optional(),
  plaque: z.string().trim().max(20).optional(),
  unit: z.string().trim().max(20).optional(),
  // only a fallback: the pin decides (Lib/locatePoint.ts)
  province: objectIdField.optional(),
  city: objectIdField.optional(),
  district: objectIdField.optional(),
  location: isPoint,
});

// Province / city / district and the written address from the pin
// (NexaMap, else our own boundaries); what the form sent only fills a gap.
// Province and city are required: the courier and the delivery fee depend
// on the city (Lib/delivery.ts).
const addressFromPin = async (
  location: [number, number],
  sent: { province?: string; city?: string; district?: string; address?: string },
) => {
  const { locatePoint } = await import("../Lib/locatePoint");
  const found = await locatePoint({ lng: location[0], lat: location[1] });
  const city = found.city?._id || sent.city;
  const cityDoc = city ? await City.findById(city).select("_id province").lean<{ _id: unknown; province?: unknown }>() : null;
  const province = found.province?._id || (cityDoc?.province ? String(cityDoc.province) : undefined) || sent.province;
  if (!cityDoc || !province)
    throw new AppError("استان و شهر این نقطه پیدا نشد؛ نقطه را دقیق‌تر روی نقشه بگذارید یا شهر را انتخاب کنید", 400);
  return {
    province,
    city: String(cityDoc._id),
    district: found.district?._id || sent.district,
    address: sent.address || found.address || undefined,
    names: found,
  };
};

export const createMyAddress: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await createMyAddressSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const { location, ...rest } = data;
    const geo = await addressFromPin(location, rest);
    if (!geo.address) return next(new AppError("آدرس را بنویسید", 400));
    const created = await UserAddress.create({
      ...rest,
      displayName:
        rest.displayName || geo.names.district?.name || geo.names.city?.name || geo.address.slice(0, 40),
      address: geo.address,
      province: geo.province,
      city: geo.city,
      district: geo.district,
      receiverPhone: rest.receiverPhone || req.user.phone,
      postalCode: rest.postalCode || undefined,
      user: req.user._id,
      location: { type: "Point", coordinates: location },
    });
    res.status(200).json({ message: "createMyAddress", data: { data: { _id: created._id } } });
  },
);

const editMyAddressSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(60).optional(),
  address: z.string().trim().min(1).max(500).optional(),
  receiverPhone: receiverPhoneField.optional(),
  postalCode: postalCodeField.optional(),
  plaque: z.string().trim().max(20).optional(),
  unit: z.string().trim().max(20).optional(),
  province: objectIdField.optional(),
  city: objectIdField.optional(),
  district: objectIdField.optional(),
  location: isPoint.optional(),
});

export const editMyAddress: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await editMyAddressSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const node = await UserAddress.findOne({
      _id: nodeId,
      user: req.user._id,
      archived: { $ne: true },
    });
    if (!node) return next(new NotFoundError());
    const { location, ...rest } = data;
    const update: Record<string, unknown> = { ...rest };
    if (location) {
      // a moved pin moves province / city / district with it
      const geo = await addressFromPin(location, rest);
      Object.assign(update, {
        province: geo.province,
        city: geo.city,
        district: geo.district,
        location: { type: "Point", coordinates: location },
      });
    } else if (rest.city && !(await City.exists({ _id: rest.city }))) {
      return next(new BadInputError());
    }
    if (rest.postalCode === "") update.postalCode = undefined;
    await UserAddress.findByIdAndUpdate(node._id, update);
    res.status(200).json({ message: "editMyAddress" });
  },
);

export const deleteMyAddress: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await UserAddress.findOneAndUpdate(
      { _id: nodeId, user: req.user._id, archived: { $ne: true } },
      { archived: true },
    );
    if (!node) return next(new NotFoundError());
    res.status(200).json({ message: "deleteMyAddress" });
  },
);
