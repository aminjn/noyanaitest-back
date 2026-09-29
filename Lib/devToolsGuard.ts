import { NextFunction, Request, Response } from "express";
import AppError from "./AppError";

// Admin developer tools that touch real money, real rides or whole
// collections (Snapp test rides/payments, migration drop/purge). They stay
// available on a dev machine; in production they need
// ALLOW_DEVTOOLS=true in .env, set on purpose and removed afterwards.
export const devToolsAllowed = () =>
  process.env.NODE_ENV !== "production" || process.env.ALLOW_DEVTOOLS === "true";

export const devToolsGuard =
  (isDangerous: (req: Request) => boolean = () => true) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (isDangerous(req) && !devToolsAllowed())
      return next(
        new AppError("این ابزار آزمایشی روی سرور اصلی غیرفعال است", 403),
      );
    next();
  };
