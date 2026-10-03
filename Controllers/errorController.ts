import { Locale, requestLocale } from "../Lib/locales";
import { translateMessage } from "../Lib/i18n/translateMessage";
import AppError from "../Lib/AppError";

import { NextFunction, Request, Response } from "express";

import * as env from "../Lib/Env";

const castErrorHandlerDB = (err: any) => {
  const message = `نامعتبر ${err.path}: ${err.value}.`;
  return new AppError(message, 400);
};

// a unique index refused the write: say which value, in words, never the
// raw driver dump (E11000 ... dup key)
const DUPLICATE_MESSAGES: Record<string, string> = {
  user: "این حساب از قبل به رکورد دیگری از همین نوع وصل است؛ اول آن را جدا کنید",
  slug: "این نامک (slug) قبلاً استفاده شده است؛ نامک دیگری بنویسید",
  phone: "این شماره قبلاً ثبت شده است",
  mobile: "این شماره قبلاً ثبت شده است",
};
const duplicateFieldErrorHandlerDB = (err: any) => {
  const keys = Object.keys(err.keyValue || err.keyPattern || {});
  const known = keys.map((k) => DUPLICATE_MESSAGES[k]).find(Boolean);
  return new AppError(known || "این مقدار قبلاً ثبت شده و تکراری است", 400);
};

// database errors a person can act on, as readable operational errors
const knownDbError = (err: any) => {
  if (err?.name === "CastError") return castErrorHandlerDB(err);
  if (err?.code === 11000 || err?.errorResponse?.code === 11000) return duplicateFieldErrorHandlerDB(err.keyValue ? err : err.errorResponse || err);
  return null;
};

const validationErrorHandlerDB = (err: any) => {
  const errors = Object.values(err.errors).map((el: any) => el.message);
  const message = `داده ورودی نامعتبر است:${errors.join(". ")}`;
  return new AppError(message, 400);
};

const jwtExpiredErrorHandler = () =>
  new AppError("ورود شما منقضی شده لطفا دوباره وارد شوید", 401);

const jwtTokenErrorHandler = () =>
  new AppError("اطلاعات ورود شما نامعتبر است لطفا دوباره وارد شوید", 401);

const sendErrorDev = (err: any, res: Response, locale: Locale) => {
  res.status(err.statusCode).json({
    status: err.status,
    error: err,
    message: translateMessage(err.message, locale),
    // stack: err.stack,
  });
};

const sendErrorprod = (err: any, res: Response, locale: Locale) => {
  if (err.isOperational) {
    res.status(err.statusCode).json({
      status: err.status,
      message: translateMessage(err.message, locale),
    });
  } else {
    // console.log("ERROR💥💥💥:", err);
    res.status(500).json({
      status: "error",
      message: "Something went very wrong!",
    });
  }
};

export default (err: any, req: Request, res: Response, next: NextFunction) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";
  if (env.NODE_ENV === "production") {
    // send prod error
    let error = err;
    // console.log(err);

    //cast error
    if (err.name === "CastError") {
      error = castErrorHandlerDB(error);
    }
    //duplicate error
    if (err.code === 11000 || err?.errorResponse?.code === 11000) {
      error = knownDbError(error) || error;
    }
    if (
      err.name === "ValidationError" ||
      err._message === "Purchase validation failed"
    ) {
      error = validationErrorHandlerDB(error);
    }
    if (err.name === "TokenExpiredError") {
      error = jwtExpiredErrorHandler();
    }
    if (err.name === "JsonWebTokenError") {
      error = jwtTokenErrorHandler();
    }
    if (!error.isOperational) console.log(error);
    sendErrorprod(error, res, requestLocale(req.headers));
  } else {
    //snd dev error
    console.log(err.message);
    // the same readable message as production for known database errors
    const known = knownDbError(err);
    sendErrorDev(known || err, res, requestLocale(req.headers));
  }
};
