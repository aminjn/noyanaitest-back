import AppError from "../Lib/AppError";

import { NextFunction, Request, Response } from "express";

import * as env from "../Lib/Env";

const castErrorHandlerDB = (err: any) => {
  const message = `نامعتبر ${err.path}: ${err.value}.`;
  return new AppError(message, 400);
};

const duplicateFieldErrorHandlerDB = (err: any) => {
  const value = Object.keys(err.keyValue).join(",");
  const message = `دیگر وارد کنید ${value} تکراری است،لطفا ${value} این`;
  return new AppError(message, 400);
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

const sendErrorDev = (err: any, res: Response) => {
  res.status(err.statusCode).json({
    status: err.status,
    error: err,
    message: err.message,
    // stack: err.stack,
  });
};

const sendErrorprod = (err: any, res: Response) => {
  if (err.isOperational) {
    res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
    });
  } else {
    // console.log('ERROR💥💥💥:', err);
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
    if (err.code === 11000) {
      error = duplicateFieldErrorHandlerDB(error);
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
    sendErrorprod(error, res);
  } else {
    //snd dev error
    console.log(err.message);
    // console.log(err);
    sendErrorDev(err, res);
  }
};
