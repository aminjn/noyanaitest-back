import { NextFunction, Request, RequestHandler, Response } from "express";
import mongoose, { isValidObjectId } from "mongoose";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { AccessError, BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import {
  clientIp,
  deviceOf,
  ipHashOf,
  isPhoneRevealKind,
  looksLikeBot,
  overBudget,
  phonesOf,
  verifyPhoneRevealToken,
} from "../Lib/phoneReveal";
import PhoneReveal, { PhoneRevealKind, phoneRevealKinds } from "../Models/PhoneReveal";
import DoctorProfile from "../Models/DoctorProfile";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import Pharmacy from "../Models/Pharmacy";
import ParaClinic from "../Models/Paraclinic";
import { getOrCreateVisitorId } from "./analyticsController";
import { addDaysYmd, fromTehranWallClock, tehranYmd } from "../Lib/tehranTime";

class TooManyRevealsError extends AppError {
  constructor() {
    super("تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره امتحان کنید", 429);
  }
}
class StaleRevealTokenError extends AppError {
  constructor() {
    super("صفحه را دوباره باز کنید و بعد شماره را ببینید", 400);
  }
}

const TEN_MINUTES = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const revealSchema = z.object({
  ticket: z.string().max(64),
  // the page path the click came from (no query: it may hold anything)
  source: z.string().max(300).optional(),
  // where on the page: the header card, the contact block, ...
  placement: z.string().max(40).regex(/^[a-z-]*$/).optional(),
});

// POST /public/phone/:kind/:id - the numbers of one public profile, for a
// visitor who pressed «نمایش شماره تماس». Each answer is logged.
export const revealPhone: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { kind, id } = req.params;
    if (!isPhoneRevealKind(kind) || !isValidObjectId(id)) return next(new BadInputError());
    const body = revealSchema.safeParse(req.body || {});
    if (!body.success) return next(new BadInputError());
    if (looksLikeBot(req)) return next(new AccessError());
    if (!verifyPhoneRevealToken(kind, id, body.data.ticket)) return next(new StaleRevealTokenError());
    const ip = clientIp(req);
    const ipHash = ipHashOf(ip);
    // a person calls a handful of practices; a scraper asks for hundreds
    if (overBudget(`ip:${ipHash}`, 30, TEN_MINUTES) || overBudget(`ip-day:${ipHash}`, 200, DAY))
      return next(new TooManyRevealsError());
    const visitor = await getOrCreateVisitorId(req, res);
    if (overBudget(`v:${visitor}`, 30, TEN_MINUTES)) return next(new TooManyRevealsError());
    const phones = await phonesOf(kind, id);
    if (!phones) return next(new NotFoundError());
    if (phones.length) {
      const source = (body.data.source || "").split(/[?#]/)[0].slice(0, 300);
      await PhoneReveal.create({
        kind,
        target: new mongoose.Types.ObjectId(id),
        visitor,
        ...(req.user?._id && { user: req.user._id }),
        ipHash,
        source: source || undefined,
        placement: body.data.placement || undefined,
        device: deviceOf(req),
      });
    }
    // the answer is for this visitor only
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex");
    res.status(200).json({ message: "revealPhone", data: { phones } });
  },
);

// ------------------------------------------------------------ counts

// the last `days` Tehran days, oldest first
const dayKeys = (days: number) => {
  const today = tehranYmd();
  return Array.from({ length: days }, (_, i) => addDaysYmd(today, i - days + 1));
};
const tehranDayOf = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Tehran" } };

const nodeOf = (req: Request, kind: PhoneRevealKind) =>
  (req as unknown as Record<string, { _id?: unknown } | undefined>)[kind];

// GET /<panel>/phone-reveals/stats - the provider's own card: today, the
// last 7 and 30 days, and the 30-day series
export const getMyPhoneRevealStats = (kind: PhoneRevealKind): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const me = nodeOf(req, kind);
    if (!me?._id) return next(new MiddlewareError());
    const keys = dayKeys(30);
    const since = fromTehranWallClock(keys[0], 0);
    const [rows, phones] = await Promise.all([
      PhoneReveal.aggregate<{ _id: string; n: number }>([
        { $match: { kind, target: new mongoose.Types.ObjectId(String(me._id)), createdAt: { $gte: since } } },
        { $group: { _id: tehranDayOf, n: { $sum: 1 } } },
      ]),
      phonesOf(kind, String(me._id)),
    ]);
    const byDay = new Map(rows.map((r) => [r._id, r.n]));
    const series = keys.map((date) => ({ date, count: byDay.get(date) || 0 }));
    const sum = (last: number) => series.slice(-last).reduce((a, p) => a + p.count, 0);
    res.status(200).json({
      message: "getMyPhoneRevealStats",
      data: {
        today: sum(1),
        week: sum(7),
        month: sum(30),
        series,
        // no public number: the card says where to add one
        hasPhone: !!phones?.length,
      },
    });
  });

const reportSchema = z.object({
  days: z.coerce.number().int().min(1).max(366).optional().default(30),
  kind: z.enum(phoneRevealKinds).optional(),
});

const namesOf = async (pairs: { kind: PhoneRevealKind; target: unknown }[]) => {
  const ids = (kind: PhoneRevealKind) => pairs.filter((p) => p.kind === kind).map((p) => p.target);
  const [doctors, clinics, hospitals, pharmacies, labs] = await Promise.all([
    DoctorProfile.find({ _id: { $in: ids("doctor") } }).select("firstName lastName slug").lean(),
    Clinic.find({ _id: { $in: ids("clinic") } }).select("name slug").lean(),
    Hospital.find({ _id: { $in: ids("hospital") } }).select("name slug").lean(),
    Pharmacy.find({ _id: { $in: ids("pharmacy") } }).select("name slug").lean(),
    ParaClinic.find({ _id: { $in: ids("paraClinic") } }).select("name slug").lean(),
  ]);
  const out = new Map<string, { name: string; slug?: string }>();
  for (const d of doctors as { _id: unknown; firstName?: string; lastName?: string; slug?: string }[])
    out.set(`doctor:${d._id}`, { name: [d.firstName, d.lastName].filter(Boolean).join(" "), slug: d.slug });
  const add = (kind: PhoneRevealKind, list: unknown[]) => {
    for (const n of list as { _id: unknown; name?: string; slug?: string }[])
      out.set(`${kind}:${n._id}`, { name: n.name || "", slug: n.slug });
  };
  add("clinic", clinics);
  add("hospital", hospitals);
  add("pharmacy", pharmacies);
  add("paraClinic", labs);
  return out;
};

// GET /analytics/phone-reveals?days=30&kind=doctor - the super admin's
// report: totals, per profile, per day and the latest reveals
export const getPhoneRevealReport: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const input = reportSchema.safeParse(req.query);
    if (!input.success) return next(new BadInputError());
    const { days, kind } = input.data;
    const keys = dayKeys(days);
    const match = { createdAt: { $gte: fromTehranWallClock(keys[0], 0) }, ...(kind && { kind }) };
    const [totals, perTarget, perDay, recent] = await Promise.all([
      PhoneReveal.aggregate([
        { $match: match },
        { $group: { _id: null, reveals: { $sum: 1 }, visitors: { $addToSet: "$visitor" }, targets: { $addToSet: "$target" } } },
        { $project: { _id: 0, reveals: 1, visitors: { $size: "$visitors" }, targets: { $size: "$targets" } } },
      ]),
      PhoneReveal.aggregate<{ _id: { kind: PhoneRevealKind; target: unknown }; reveals: number; visitors: string[]; last: Date }>([
        { $match: match },
        {
          $group: {
            _id: { kind: "$kind", target: "$target" },
            reveals: { $sum: 1 },
            visitors: { $addToSet: "$visitor" },
            last: { $max: "$createdAt" },
          },
        },
        { $sort: { reveals: -1 } },
        { $limit: 200 },
      ]),
      PhoneReveal.aggregate<{ _id: string; n: number }>([
        { $match: match },
        { $group: { _id: tehranDayOf, n: { $sum: 1 } } },
      ]),
      PhoneReveal.find(match).sort({ createdAt: -1 }).limit(100).populate({ path: "user", select: "phone username" }).lean(),
    ]);
    const names = await namesOf([
      ...perTarget.map((r) => r._id),
      ...(recent as { kind: PhoneRevealKind; target: unknown }[]),
    ]);
    const byDay = new Map(perDay.map((r) => [r._id, r.n]));
    const label = (k: PhoneRevealKind, t: unknown) => names.get(`${k}:${t}`) || { name: "" };
    res.status(200).json({
      message: "getPhoneRevealReport",
      data: {
        days,
        totals: totals[0] || { reveals: 0, visitors: 0, targets: 0 },
        perTarget: perTarget.map((r) => ({
          _id: `${r._id.kind}:${r._id.target}`,
          kind: r._id.kind,
          target: r._id.target,
          ...label(r._id.kind, r._id.target),
          reveals: r.reveals,
          visitors: r.visitors.filter(Boolean).length,
          last: r.last,
        })),
        perDay: keys.map((date) => ({ _id: date, date, count: byDay.get(date) || 0 })),
        recent: (recent as Record<string, any>[]).map((r) => ({
          ...r,
          ...label(r.kind, r.target),
          visitor: r.visitor ? String(r.visitor).slice(0, 8) : undefined,
        })),
      },
    });
  },
);
