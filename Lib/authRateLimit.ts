import { NextFunction, Request, Response } from "express";
import AppError from "./AppError";
import { isPhone } from "./validators";

// A small in-memory limit on the sign-in routes (authRouter): per client
// address and, where the body names one, per phone. The per-phone counts
// are the strict ones - an address can be shared (Arvan's edge, an office
// NAT), a phone is one person. The code's own limits (Lib/otpIssue.ts send
// waits, Token tries) still apply on top of this.
type Hits = { count: number; resetAt: number };
const buckets = new Map<string, Hits>();

const hit = (key: string, windowMs: number) => {
  const now = Date.now();
  const cur = buckets.get(key);
  if (!cur || cur.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowMs };
    buckets.set(key, fresh);
    return fresh;
  }
  cur.count += 1;
  return cur;
};

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of buckets) if (val.resetAt <= now) buckets.delete(key);
}, 60_000).unref();

export const authRateLimit =
  (name: string, { perIp, perPhone, windowMs = 60_000 }: { perIp: number; perPhone?: number; windowMs?: number }) =>
  (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket?.remoteAddress || "?";
    const byIp = hit(`${name}:ip:${ip}`, windowMs);
    const phone = perPhone ? isPhone(req.body?.phone) : null;
    const byPhone = phone ? hit(`${name}:phone:${phone}`, windowMs) : null;
    if (byIp.count > perIp || (byPhone && perPhone && byPhone.count > perPhone)) {
      const resetAt = Math.max(byIp.resetAt, byPhone?.resetAt || 0);
      res.setHeader("Retry-After", String(Math.ceil((resetAt - Date.now()) / 1000)));
      return next(new AppError("درخواست‌ها بیش از حد است؛ یک دقیقه صبر کنید", 429));
    }
    next();
  };
