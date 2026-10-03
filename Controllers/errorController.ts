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
  if (err?.name === "ValidationError") return validationErrorHandlerDB(err);
  if (err?.code === 11000 || err?.errorResponse?.code === 11000) return duplicateFieldErrorHandlerDB(err.keyValue ? err : err.errorResponse || err);
  return null;
};

// mongoose's own validators answer in English ("Path `x` is required.");
// each kind gets one Persian sentence, translated like every other message
const BUILTIN_VALIDATION: Record<string, string> = {
  required: "یکی از فیلدهای الزامی خالی است",
  min: "یکی از مقدارها کمتر از حد مجاز است",
  max: "یکی از مقدارها بیشتر از حد مجاز است",
  enum: "مقدار انتخاب‌شده معتبر نیست",
  minlength: "یکی از متن‌ها کوتاه‌تر از حد مجاز است",
  maxlength: "یکی از متن‌ها بلندتر از حد مجاز است",
  regexp: "قالب یکی از مقدارها درست نیست",
};
const CAST_MESSAGE = "قالب یکی از مقدارها درست نیست";

const validationErrorHandlerDB = (err: any) => {
  const items = Object.values(err.errors || {}) as any[];
  const errors = items.map((el) => String(el?.message || ""));
  // one rule of ours (a Persian sentence): that sentence alone, so it is
  // translated like every other message
  const own = errors.filter((m) => /[\u0600-\u06FF]/.test(m));
  if (own.length) return new AppError(own[0], 400);
  const first = items[0];
  if (first?.name === "CastError") return new AppError(CAST_MESSAGE, 400);
  if (first?.kind && BUILTIN_VALIDATION[first.kind])
    return new AppError(BUILTIN_VALIDATION[first.kind], 400);
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
