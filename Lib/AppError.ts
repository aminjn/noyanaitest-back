export default class AppError extends Error {
  statusCode: number;
  status: "fail" | "error";
  isOperational: boolean;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith("4") ? "fail" : "error";
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class MiddlewareError extends AppError {
  constructor() {
    super("مشکل پیش بینی نشده ای رخ داده لطفا با پشتیبانی تماس بگیرید", 500);
  }
}

export class BadInputError extends AppError {
  constructor() {
    super("اطلاعات وارد شده صحیح نمیباشد", 400);
  }
}

export class LoginError extends AppError {
  constructor() {
    super("لطفا برای دسترسی ابتدا وارد حساب خود شوید", 401);
  }
}

export class LoginExpiredError extends AppError {
  constructor() {
    super("ورود شما منقضی شده لطفا دوباره وارد شوید", 400);
  }
}

export class AnothereClientError extends AppError {
  constructor() {
    super("با یک دستگاه دیگر به این حساب ورود وجود دارد دوباره وارد شوید", 400);
  }
}

export class NoAccountError extends AppError {
  constructor() {
    super("حساب کاربری ای با این شماره یافت نشد", 404);
  }
}

export class NotFoundError extends AppError {
  constructor(name?: string) {
    super(`هیچ ${name || "آیتمی"} با این آی دی یافت نشد`, 404);
  }
}

export class ServerError extends AppError {
  constructor() {
    super("مشکل خیلی بدی رخ داده لطفا با پشتیبانی تماس بگیرید", 500);
  }
}

export class OtpServiceNotAvailableError extends AppError {
  constructor() {
    super(
      "سرویس ارسال پیامک از دسترس خارج است به محض وصل شدن بهتون اطلاع میدیم",
      500
    );
  }
}

export class MaleformedJWT extends AppError {
  constructor() {
    super(
      "سرور فعلا از دسترس خارج است به محض آنلاین شدن به شما پیام میدهیم",
      411
    );
  }
}

export class AccessError extends AppError {
  constructor() {
    super("شما مجاز به انجام این عملیات نیستید", 403);
  }
}

export class AlreadyLoggedInError extends AppError {
  constructor() {
    super("شما وارد سیستم شده اید و نیاز به انجام این مرحله نیست", 400);
  }
}

export class TooManyTrysError extends AppError {
  constructor() {
    super("حساب شما موقتا مسدود شده لطفا بعدا تلاش کنید", 400);
  }
}

export class AskLoginFirstError extends AppError {
  constructor() {
    super("لطفا اول شماره خود را وارد کنید", 425);
  }
}

export class WrongOTPError extends AppError {
  constructor() {
    super("کد وارد شده یا منقضی یا اشتباه می باشد", 400);
  }
}

export class HasTreeError extends AppError {
  constructor() {
    super("درخت حساب قبلا برای این کسب و کار ساخته شده", 400);
  }
}

export class SystemAccountError extends AppError {
  constructor() {
    super(
      "این حساب سیستمی است لطفا از منو مربوطه عملیات مد نظر را انجام دهید",
      400
    );
  }
}

export class NoSubTafzilAccountError extends AppError {
  constructor() {
    super("امکان ثبت حساب زیر شاخه برای حساب تفضیلی وجود ندارد", 400);
  }
}

export class DuplicateAccountCodeError extends AppError {
  constructor() {
    super("از این کد قبلا استفاده شده لطفا کد را عوض کنید", 400);
  }
}

export class FullAccountError extends AppError {
  constructor() {
    super("این حساب دیگر قادر به تعریف زیرشاخه نیست", 400);
  }
}

export class NotImplementedError extends AppError {
  constructor() {
    super(
      "این قسمت از اپلیکیشن هنوز ساخته نشده و به زودی به اپلیکیشن اضافه خواهد گشت",
      400
    );
  }
}

export class DoctorsOnlyError extends AppError {
  constructor() {
    super("هنوز پروفایل پزشک به شما اختصاص داده نشده", 400);
  }
}

export class BadTimingError extends AppError {
  constructor() {
    super("این آیتم در شرایط مناسبی قرار ندارد", 400);
  }
}
