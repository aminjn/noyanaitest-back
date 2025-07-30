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
  OtpServiceNotAvailableError,
  ServerError,
  WrongOTPError,
} from "../Lib/AppError";
import jwt, { JwtPayload } from "jsonwebtoken";
import User from "../Models/User";
import { UserRole } from "../Lib/enums";
import { isOTP, isPhone } from "../Lib/validators";
import PendingUser from "../Models/PendingUser";
import Token from "../Models/Token";
import { randomCode, sendSMS } from "../Lib/helpers";
import UserSecurity from "../Models/UserSecurity";
import * as env from "../Lib/Env";
import AccessLevel, {
  AccessLevelModel,
  AccessOperation,
} from "../Models/AccessLevel";
import UserAccessLevel from "../Models/UserAccessLevel";

const cookieOptions = {
  maxAge: env.JWT_EXPIRES_IN * 24 * 60 * 60 * 1000,
  httpOnly: true,
  path: "/api",
  secure: false,
};
if (env.NODE_ENV === "production") cookieOptions.secure = true;

const buildCookie = async (id: string, res: Response) => {
  const token = jwt.sign({ id }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN * 24 * 60 * 60,
  });
  res.cookie("token", token, cookieOptions);
};

const clearCookie = (res: Response) => {
  res.clearCookie("token", cookieOptions);
};

export const protect: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.cookies.token) return next(new LoginError());
    const jwtVerifyPromisified = (
      token: string,
      secret: string
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
      env.JWT_SECRET
    )) as JwtPayload;
    if (!decoded.exp || !decoded.iat) {
      console.log("Under Attack");
      return next(new MaleformedJWT());
    }
    if (
      new Date(decoded.exp * 1000).getTime() < new Date(Date.now()).getTime()
    ) {
      clearCookie(res);
      return next(new LoginExpiredError());
    }
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
      }
    );
    if (new Date(security.lastLogin) > new Date(decoded.iat * 1000)) {
      clearCookie(res);
      return next(new AnothereClientError());
    }
    req.user = user;
    next();
  }
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
    if (req.user.role === "admin") next();
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
      secret: string
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
      env.JWT_SECRET
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
  }
);

export const enter: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const phone = isPhone(req.body.phone);
    if (!phone) return next(new BadInputError());
    let user = await User.findOne({ phone });
    if (!user) {
      user = await PendingUser.findOneAndUpdate(
        {
          phone,
        },
        { phone },
        { new: true, upsert: true }
      );
    }
    if (!user) return next(new ServerError());
    let code: string | undefined;
    const token = await Token.findOneAndUpdate(
      { owner: user._id },
      { owner: user._id },
      { new: true, upsert: true }
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
    const didSendCode = await sendSMS(user.phone, { code }, env.OTP_PATTERN);
    if (didSendCode) {
      token.code = code;
      await token.save();
      return res.status(200).json({ message: `enter`, data: {} });
    } else {
      token.initiatedAt = undefined;
      await token.save();
      return next(new OtpServiceNotAvailableError());
    }
  }
);

export const login: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const phone = isPhone(req.body.phone);
    if (!phone || !isOTP(req.body.code)) return next(new BadInputError());
    let user = await User.findOne({ phone: phone });
    let isNew = false;
    if (!user) {
      user = await PendingUser.findOne({ phone: phone });
      isNew = true;
    }
    if (!user) return next();
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
    if (isNew) user = await User.create({ phone: phone });
    await UserSecurity.findOneAndUpdate(
      { user: user._id },
      { user: user._id, lastLogin: new Date(new Date().getTime() - 5000) },
      {
        upsert: true,
      }
    );
    buildCookie(user._id.toString(), res);
    res.status(200).json({ message: `login`, data: { data: isNew } });
  }
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
      { upsert: true }
    );
    clearCookie(res);
    res.status(200).json({ message: "Signing Out", data: {} });
  }
);
