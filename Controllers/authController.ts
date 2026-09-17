import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  AccessError,
  AlreadyLoggedInError,
  AnothereClientError,
  BadInputError,
  LoginError,
  LoginExpiredError,
  MaleformedJWT,
  MiddlewareError,
  NotFoundError,
  OtpServiceNotAvailableError,
  ServerError,
  WrongOTPError,
} from "../Lib/AppError";
import jwt, { JwtPayload } from "jsonwebtoken";
import User, { IUser } from "../Models/User";
import { UserRole } from "../Lib/enums";
import { isOTP, isPhone, isSSID } from "../Lib/validators";
import PendingUser, { IPendingUser } from "../Models/PendingUser";
import Token from "../Models/Token";
import { randomCode } from "../Lib/helpers";
import { sendSMS } from "../Lib/sendSms";
import UserSecurity from "../Models/UserSecurity";
import * as env from "../Lib/Env";
import { getAppConfig } from "../Lib/appConfig";
import { AccessLevelModel, AccessOperation } from "../Models/AccessLevel";
import UserAccessLevel from "../Models/UserAccessLevel";
import * as z from "zod";
import moment from "moment-jalaali";
import BadEvent from "../Models/BadEvent";
import UserIdentity from "../Models/UserIdentity";

export const cookieOptions = {
  maxAge: env.JWT_EXPIRES_IN * 24 * 60 * 60 * 1000,
  httpOnly: true,
  path: "/api",
  secure: false,
};
if (env.NODE_ENV === "production") cookieOptions.secure = true;

export const cookieBuilder = ({
  id,
  name,
  res,
}: {
  name: string;
  id: string;
  res: Response;
}) => {
  const token = jwt.sign({ id }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN * 24 * 60 * 60,
  });
  res.cookie(name, token, cookieOptions);
};

const buildCookie = (id: string, res: Response) => {
  cookieBuilder({ id, res, name: "token" });
};

const clearCookie = (res: Response) => {
  res.clearCookie("token", cookieOptions);
};

export const extractDataFromCookie = async ({
  cookie,
  name,
  res,
}: {
  cookie: string;
  name: string;
  res?: Response;
}) => {
  const jwtVerifyPromisified = (
    token: string,
    secret: string,
  ): Promise<JwtPayload | string | undefined> => {
    return new Promise((resolve, reject) => {
      jwt.verify(token, secret, {}, (err, payload) => {
        if (err) {
          reject(err);
        } else {
          resolve(payload);
        }
      });
    });
  };
  const decoded = (await jwtVerifyPromisified(
    cookie,
    env.JWT_SECRET,
  )) as JwtPayload;
  if (!decoded.exp || !decoded.iat) {
    console.log("Under Attack");
    return;
  }
  if (new Date(decoded.exp * 1000).getTime() < new Date(Date.now()).getTime()) {
    res?.clearCookie(name, cookieOptions);
    return;
  }
  return decoded;
};

export const protect: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.cookies.token) return next(new LoginError());
    const decoded = await extractDataFromCookie({
      cookie: req.cookies.token,
      name: "token",
      res: res,
    });
    if (!decoded) return next(new LoginExpiredError());
    const user = await User.findById(decoded.id);
    if (!user) {
      clearCookie(res);
      return next(new LoginExpiredError());
    }
    const security = await UserSecurity.findOneAndUpdate(
      {
        user: user._id,
      },
      { user: user._id },
      {
        upsert: true,
        new: true,
      },
    );
    if (new Date(security.lastLogin) > new Date((decoded.iat || 0) * 1000)) {
      clearCookie(res);
      return next(new AnothereClientError());
    }
    req.user = user;
    next();
  },
);

// Best-effort auth: if a valid, non-expired login cookie is present it
// attaches `req.user`, same as `protect`. Unlike `protect`, it never
// blocks the request - missing, malformed or expired cookies just leave
// `req.user` undefined so anonymous visitors can still proceed. Meant for
// public endpoints (e.g. analytics) that want to know who the user is
// when possible without requiring login.
export const optionalAuth: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.cookies.token) return next();
    let decoded: JwtPayload | undefined;
    try {
      decoded = await extractDataFromCookie({
        cookie: req.cookies.token,
        name: "token",
        res,
      });
    } catch {
      return next();
    }
    if (!decoded) return next();
    const user = await User.findById(decoded.id);
    if (!user) return next();
    const security = await UserSecurity.findOne({ user: user._id });
    if (
      security &&
      new Date(security.lastLogin) > new Date((decoded.iat || 0) * 1000)
    )
      return next();
    req.user = user;
    next();
  },
);

export const restrictTo: (...roles: UserRole[]) => RequestHandler =
  (...roles) =>
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    if (!roles.includes(req.user.role)) {
      return next(new AccessError());
    }
    next();
  };

export const hasPermission: (args: {
  model: AccessLevelModel;
  op: AccessOperation;
}) => RequestHandler = ({ model, op }) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    if (req.user.role === "admin") return next();
    if (req.user.role !== "notadmin") return next(new AccessError());
    const access = await UserAccessLevel.findOne({
      user: req.user._id,
    }).populate("accessLevel");
    if (!access?.accessLevel?.[model]?.[op]) return next(new AccessError());
    next();
  });

export const noUser: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.cookies.token) return next();
    const jwtVerifyPromisified = (
      token: string,
      secret: string,
    ): Promise<JwtPayload | string | undefined> => {
      return new Promise((resolve, reject) => {
        jwt.verify(token, secret, {}, (err, payload) => {
          if (err) {
            reject(err);
          } else {
            resolve(payload);
          }
        });
      });
    };
    const decoded = (await jwtVerifyPromisified(
      req.cookies.token,
      env.JWT_SECRET,
    )) as JwtPayload;
    if (!decoded.exp || !decoded.iat) {
      console.log("Under Attack");
      return next(new MaleformedJWT());
    }
    if (new Date(decoded.exp * 1000).getTime() < new Date(Date.now()).getTime())
      return next();
    const user = await User.findById(decoded.id);
    if (!user) return next();
    next(new AlreadyLoggedInError());
  },
);

export const enter: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const phone = isPhone(req.body.phone);
    if (!phone) return next(new BadInputError());
    let user = await User.findOne({ phone });
    if (!user) {
      return next(new AppError("شما قبلا ثبت نام نکردید", 400));
      // user = await PendingUser.findOneAndUpdate(
      //   {
      //     phone,
      //   },
      //   { phone },
      //   { new: true, upsert: true },
      // );
    }
    if (!user) return next(new ServerError());
    let code: string | undefined;
    const token = await Token.findOneAndUpdate(
      { owner: user._id },
      { owner: user._id },
      { new: true, upsert: true },
    );
    if (token.initiatedAt) {
      if (token.isExpired() || !token.code) {
        if (await token.canSendAgain()) {
          code = randomCode();
          token.code = code;
          await token.save();
        } else {
          return res.status(200).json({
            message: "کد به تازگی ارسال شده لطفا بعدا دوباره تلاش کنید",
            data: { tryAgain: token.canSendAgainAt() },
          });
        }
      } else {
        if (await token.canSendAgain()) {
          code = token.code;
        } else {
          return res.status(200).json({
            message: "کد به تازگی ارسال شده لطفا بعدا دوباره تلاش کنید",
            data: { tryAgain: token.canSendAgainAt() },
          });
        }
      }
    } else {
      code = randomCode();
    }
    const didSendCode = await sendSMS(user.phone, { OTP: code }, "OTP_PATTERN");
    if (didSendCode) {
      token.code = code;
      await token.save();
      return res.status(200).json({ message: `enter`, data: {} });
    } else {
      token.initiatedAt = undefined;
      await token.save();
      return next(new OtpServiceNotAvailableError());
    }
  },
);

export const login: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const phone = isPhone(req.body.phone);
    if (!phone || !isOTP(req.body.code)) return next(new BadInputError());
    let user: null | IUser | IPendingUser = await User.findOne({
      phone: phone,
    });
    let isNew = false;
    if (!user) {
      user = await PendingUser.findOne({ phone: phone });
      isNew = true;
    }
    if (!user) return next(new NotFoundError());
    const token = await Token.findOne({ owner: user._id });
    if (!token) return next(new ServerError());
    if (token.isExpired()) return next(new WrongOTPError());
    try {
      if (!(await token.isCorrectCode(req.body.code)))
        return next(new WrongOTPError());
    } catch (err: unknown) {
      if (err instanceof AppError) return next(err);
      return next(new ServerError());
    }
    if (isNew) {
      const pending = user as IPendingUser;
      if (!pending.nationalCode) return next(new ServerError());
      const dup = await UserIdentity.exists({
        nationalId: pending.nationalCode,
        user: { $exists: true },
      });
      if (dup) return next(new AppError("قبلا ثبت نام شما تکمیل شده", 400));
      user = await User.create({ phone: phone });
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
      } = pending;
      await UserIdentity.findOneAndUpdate(
        {
          nationalId: nationalCode,
        },
        {
          user: user._id,
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
        },
        { upsert: true },
      );
    }
    await UserSecurity.findOneAndUpdate(
      { user: user._id },
      { user: user._id, lastLogin: new Date(new Date().getTime() - 5000) },
      {
        upsert: true,
      },
    );
    buildCookie(user._id.toString(), res);
    res.status(200).json({ message: `login`, data: { data: isNew } });
  },
);

export const signout: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const cookieOptions = {
      maxAge: env.JWT_EXPIRES_IN * 24 * 60 * 60 * 1000,
      httpOnly: true,
      path: "/api",
      secure: false,
    };
    if (env.NODE_ENV === "production") cookieOptions.secure = true;
    await UserSecurity.findOneAndUpdate(
      { user: req.user._id },
      { user: req.user._id, lastLogin: new Date() },
      { upsert: true },
    );
    clearCookie(res);
    res.status(200).json({ message: "Signing Out", data: {} });
  },
);

export const signup: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { phone: _phone, nationalId, birthDate: _birthDate } = req.body;
    const phone = isPhone(_phone);
    if (!phone) return next(new BadInputError());
    const dup = await User.exists({ phone });
    if (dup)
      return next(
        new AppError("شما قبلا ثبت نام کرده اید لطفا وارد شوید", 400),
      );
    if (!isSSID(nationalId))
      return next(new AppError("کد ملی وارد شده در سامانه یافت نشد", 400));
    const otherNumber = await UserIdentity.findOne({ nationalId });
    if (otherNumber)
      return next(
        new AppError(
          "با این کد ملی و شماره دیگری فبلا در سایت ثبت نام شده لطفا با همان شماره وارد شوید",
          400,
        ),
      );
    const birthDate = new Date(_birthDate);
    if (isNaN(birthDate.getTime())) return next(new BadInputError());
    const now = new Date();
    if (now.getTime() - birthDate.getTime() < 18 * 365 * 24 * 60 * 60 * 1000)
      return next(
        new AppError("برای ثبت نام باید حداقل 18 سال سن داشته باشید", 400),
      );
    const jBirthDate = moment(birthDate).format("jYYYYjMMjDD");
    const {
      podiumToken,
      getIdentityInfoApiKey,
      matchNationalIdAndPhoneNumberApiKey,
    } = await getAppConfig();
    let pendingUser = await PendingUser.findOneAndUpdate(
      {
        phone,
      },
      { phone },
      { new: true, upsert: true },
    );
    if (pendingUser.nationalCode !== nationalId) {
      try {
        const response = await fetch(env.podiumUrl, {
          headers: {
            Authorization: `bearer ${podiumToken}`,
            "Content-Type": "application/json",
          },
          method: "POST",
          body: JSON.stringify({
            productEntityId: 46659320,
            apiKey: getIdentityInfoApiKey,
            providerParameters: {
              nationalCode: nationalId,
              birthDate: jBirthDate,
            },
          }),
        });
        const data = (await response.json()) as PodiumReponse;
        if (data.hasError || !data.result) {
          await BadEvent.create({
            place: "GetIdentity",
            payload: JSON.stringify({
              incoming: phone,
              error: data.message,
              result: data.result,
            }),
          });
          return next(
            new AppError(
              "سرویس مورد نظر به مشکل خورده لطفا بعدا دوباره امتحان کنید",
              400,
            ),
          );
        }
        const incomingIdentityInfo = JSON.parse(
          data.result,
        ) as IdentityResponse;
        if (!incomingIdentityInfo.identityInfo) {
          await BadEvent.create({
            place: "GetIdentity",
            payload: JSON.stringify({
              incoming: phone,
              error: incomingIdentityInfo.message,
            }),
          });
          return next(new AppError(incomingIdentityInfo.message, 400));
        }
        if (!incomingIdentityInfo.identityInfo.alive) {
          await BadEvent.create({
            place: "GetIdentity",
            payload: JSON.stringify({ incoming: phone, error: "Dead Guy" }),
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
        pendingUser = await PendingUser.findOneAndUpdate(
          { phone },
          {
            phone,
            nationalCode,
            firstName,
            lastName,
            fatherName,
            gender: gender.toLowerCase(),
            identificationNumber,
            identificationSerialCode,
            identificationSerialNumber,
            birthPlaceCode,
            birthPlace,
            birthDate,
            matched: false,
          },
          { new: true, upsert: true },
        );
      } catch (e: unknown) {
        await BadEvent.create({
          place: "GetIdentity",
          payload: JSON.stringify({
            incoming: phone,
            errro: e instanceof Error ? e.message : "UNKOWN",
          }),
        });
      }
    }
    if (!pendingUser.nationalCode) return next(new ServerError());
    if (!pendingUser.matched) {
      try {
        const response = await fetch(env.podiumUrl, {
          method: "POST",
          headers: {
            Authorization: `bearer ${podiumToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            productEntityId: "46645324",
            apiKey: matchNationalIdAndPhoneNumberApiKey,
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
            place: "MatchPhoneAndNationalId",
            payload: JSON.stringify({
              incoming: phone,
              errro: "Bad Response",
            }),
          });
          return next(new AppError("مشکلی در دریافت اطلاعات پیش آمد", 400));
        }
        try {
          const matchResult = JSON.parse(
            data.result,
          ) as MatchNationalIdAndPhoneNumberResponse;
          if (!matchResult.matched)
            return next(
              new AppError(
                "لطفا با شماره ای که متعلق به خودتان هست اقدام فرمایید",
                400,
              ),
            );
          await PendingUser.findByIdAndUpdate(pendingUser._id, {
            matched: true,
          });
        } catch {
          await BadEvent.create({
            place: "MatchPhoneAndNationalId",
            payload: JSON.stringify({
              incoming: phone,
              errro: "Response is NOt JSON",
            }),
          });
          return next(new AppError("مشکلی در دریافت اطلاعات پیش آمد", 400));
        }
      } catch (e) {
        await BadEvent.create({
          place: "MatchPhoneAndNationalId",
          payload: JSON.stringify({
            incoming: phone,
            errro: e instanceof Error ? e.message : "UNknonw",
          }),
        });
      }
    }
    let code: string | undefined;
    const token = await Token.findOneAndUpdate(
      { owner: pendingUser._id },
      { owner: pendingUser._id },
      { new: true, upsert: true },
    );
    if (token.initiatedAt) {
      if (token.isExpired() || !token.code) {
        if (await token.canSendAgain()) {
          code = randomCode();
          token.code = code;
          await token.save();
        } else {
          return res.status(200).json({
            message: "کد به تازگی ارسال شده لطفا بعدا دوباره تلاش کنید",
            data: { tryAgain: token.canSendAgainAt() },
          });
        }
      } else {
        if (await token.canSendAgain()) {
          code = token.code;
        } else {
          return res.status(200).json({
            message: "کد به تازگی ارسال شده لطفا بعدا دوباره تلاش کنید",
            data: { tryAgain: token.canSendAgainAt() },
          });
        }
      }
    } else {
      code = randomCode();
    }
    const didSendCode = await sendSMS(
      pendingUser.phone,
      { OTP: code },
      "OTP_PATTERN",
    );
    if (didSendCode) {
      token.code = code;
      await token.save();
      return res.status(200).json({ message: `enter`, data: {} });
    } else {
      token.initiatedAt = undefined;
      await token.save();
      return next(new OtpServiceNotAvailableError());
    }
  },
);

export type PodiumReponse = {
  hasError: boolean;
  message?: string;
  httpStatusCode?: number;
  result?: string;
};

export type PodiumIdentityInfo = {
  nationalCode: string;
  firstName: string;
  lastName: string;
  fatherName: string;
  gender: "MALE" | "FEMALE";
  identificationNumber: number;
  identificationSerialCode: string;
  identificationSerialNumber: number;
  birthPlaceCode: number;
  birthPlace: string;
  birthDate: string;
  alive: boolean;
};

export type IdentityResponse =
  | {
      nationalCode: string;
      birthDate: string;
      identityInfo: PodiumIdentityInfo;
    }
  | {
      code: string;
      message: string;
      identityInfo?: never;
    };

export type MatchNationalIdAndPhoneNumberResponse = { matched: boolean };
