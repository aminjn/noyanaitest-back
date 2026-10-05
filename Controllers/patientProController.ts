import { NextFunction, Request, RequestHandler, Response } from "express";
import { sanitizePlanAi } from "../Lib/ai/planAi";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import PatientProPlan, { IPatientProPlan } from "../Models/PatientProPlan";
import PatientSubscription, { IPatientSubscription } from "../Models/PatientSubscription";
import { ticketPriorities } from "../Models/Ticket";
import { MAX_LICENSE_DAYS } from "../Models/BaseLicensePricing";
import DoctorProfile from "../Models/DoctorProfile";
import UserIdentity from "../Models/UserIdentity";
import User from "../Models/User";
import { pricingOfKind } from "../Lib/licenseQuote";
import {
  aiBenefitOf,
  aiUsageOf,
  bookingDiscountFor,
  clearProPlanCache,
  getProPlan,
  grantPro,
  proStatusOf,
  purchasePro,
} from "../Lib/patientPro";
import { getPatientFreeCancelHours } from "../Services/reservationCancelService";
import { notifyProPurchased } from "../Services/patientProService";
import { doctorSessionKindSettingsModelDict } from "./bookingController";
import { pagingQuery, pageWindow, searchUserIds, sendCsv, userCsvLabel } from "../Lib/adminListing";

// «پرو» (2026-10): the patients' membership - public prices, the member's
// own page, the purchase, the booking-page discount line, and the super
// admin's plan settings, subscribers and support actions. The rules
// themselves live in Lib/patientPro.ts.

const DAY = 24 * 60 * 60 * 1000;
const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

// what the pages show of the benefits (and the free tier they compare with)
// The AI figures come from the AI policy (2026-10, Lib/ai/aiPolicy.ts,
// feature "assistant.health"), see aiBenefitOf.
const benefitsOf = (
  plan: IPatientProPlan,
  baseFreeCancelHours: number,
  ai: { aiEnabled: boolean; freeAiDailyLimit: number; proAiDailyLimit: number },
) => ({
  ...ai,
  bookingDiscountEnabled: !!plan.bookingDiscountEnabled,
  bookingDiscountPercent: plan.bookingDiscountPercent || 0,
  bookingDiscountMax: plan.bookingDiscountMax || 0,
  familyEnabled: !!plan.familyEnabled,
  deliveryEnabled: !!plan.deliveryEnabled,
  deliveryFreeAbove: plan.deliveryFreeAbove || 0,
  deliveryPercentOff: plan.deliveryPercentOff || 0,
  cancelEnabled: !!plan.cancelEnabled && plan.proFreeCancelHours < baseFreeCancelHours,
  proFreeCancelHours: Math.min(baseFreeCancelHours, plan.proFreeCancelHours ?? baseFreeCancelHours),
  baseFreeCancelHours,
  supportEnabled: !!plan.supportEnabled,
});

const subscriptionView = (s: IPatientSubscription, now = Date.now()) => {
  const start = new Date(s.startedAt).getTime();
  const end = new Date(s.expiresAt).getTime();
  const state =
    s.status === "cancelled"
      ? "cancelled"
      : end <= now
        ? "expired"
        : start > now
          ? "scheduled"
          : "active";
  return {
    _id: idOf(s._id),
    days: s.days,
    startedAt: s.startedAt,
    expiresAt: s.expiresAt,
    state,
    daysLeft: state === "active" ? Math.max(0, Math.ceil((end - now) / DAY)) : null,
    listPrice: s.listPrice || 0,
    paid: s.paid || 0,
    granted: !!s.grantedBy,
    createdAt: s.createdAt,
  };
};

// GET /pro/pricing?code= (public): the plan, its priced options with the
// running promotions, and the benefits
export const getProPricing: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  // the plan first: the first call ever creates it
  const plan = await getProPlan();
  const [pricing, baseHours, ai] = await Promise.all([
    pricingOfKind("patient", code),
    getPatientFreeCancelHours(),
    aiBenefitOf(plan),
  ]);
  res.status(200).json({
    message: "getProPricing",
    data: { ...pricing, onSale: !!plan.isActive, benefits: benefitsOf(plan, baseHours, ai) },
  });
});

// GET /pro/me: the member's status, periods, today's AI allowance, and the
// same prices (a renewal is priced like a purchase)
export const getMyPro: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const plan = await getProPlan();
  const [status, usage, baseHours, history, pricing] = await Promise.all([
    proStatusOf(req.user._id),
    aiUsageOf(req.user._id),
    getPatientFreeCancelHours(),
    PatientSubscription.find({ user: req.user._id }).sort({ startedAt: -1 }).limit(24).lean<IPatientSubscription[]>(),
    pricingOfKind("patient", code),
  ]);
  const benefits = benefitsOf(plan, baseHours, await aiBenefitOf(plan));
  res.status(200).json({
    message: "getMyPro",
    data: {
      ...pricing,
      onSale: !!plan.isActive,
      benefits,
      active: status.active,
      until: status.until,
      current: status.current ? subscriptionView(status.current) : null,
      history: (Array.isArray(history) ? history : []).map((s) => subscriptionView(s)),
      ai: usage,
      // the window this user's cancellations get
      freeCancelHours: status.active && benefits.cancelEnabled ? benefits.proFreeCancelHours : baseHours,
    },
  });
});

const purchaseSchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(MAX_LICENSE_DAYS),
  promoCode: z.string().trim().max(40).optional(),
});

// POST /pro/purchase {days, promoCode?}: from the wallet (a shortfall is
// topped up through SEP first, Components/Payment/WalletShortfallTopUp)
export const purchaseMyPro: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  const parsed = purchaseSchema.safeParse(req.body ?? {});
  if (!parsed.success) return next(new BadInputError());
  const result = await purchasePro(req.user._id, parsed.data.days, parsed.data.promoCode || undefined);
  if (result instanceof AppError) return next(result);
  notifyProPurchased(req.user._id, result.plan.displayName || "پرو", new Date(result.subscription.expiresAt));
  res.status(200).json({
    message: "purchaseMyPro",
    data: { subscription: subscriptionView(result.subscription), paid: result.quote.final },
  });
});

const bookingQuoteSchema = z.object({
  doctor: z.string(),
  sessionType: z.string(),
  patient: z.string().optional(),
});

// POST /pro/quote/booking {doctor, sessionType, patient?}: the discount line
// of the booking checkout - the member's discount, or what Pro would save
export const quoteBooking: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  const parsed = bookingQuoteSchema.safeParse(req.body ?? {});
  if (!parsed.success || !isValidObjectId(parsed.data.doctor)) return next(new BadInputError());
  const model = (doctorSessionKindSettingsModelDict as Record<string, unknown>)[parsed.data.sessionType] as
    | { findOne: (q: unknown) => { lean: () => Promise<{ price?: number; active?: boolean } | null> } }
    | undefined;
  if (!model) return next(new BadInputError());
  const doctor = await DoctorProfile.findById(parsed.data.doctor).select("_id").lean();
  if (!doctor) return next(new NotFoundError("پزشک"));
  const settings = await model.findOne({ doctor: doctor._id }).lean();
  const price = Math.max(0, Number(settings?.price) || 0);
  let forRelative = false;
  if (parsed.data.patient && isValidObjectId(parsed.data.patient)) {
    const identity = await UserIdentity.findById(parsed.data.patient).select("user").lean<{ user?: unknown }>();
    forRelative = !!identity && idOf(identity.user) !== idOf(req.user._id);
  }
  const quote = await bookingDiscountFor({
    userId: req.user._id,
    price,
    sessionType: parsed.data.sessionType,
    doctorId: doctor._id,
    forRelative,
  });
  res.status(200).json({ message: "quoteBooking", data: { price, ...quote } });
});

// ---------------------------------------------------------------- admin

// GET /admin/pro/plan
export const adminGetProPlan: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  const plan = await getProPlan(true);
  const full = await PatientProPlan.findById(plan._id).lean();
  res.status(200).json({ message: "adminGetProPlan", data: full });
});

const pricingEntry = z.object({
  days: z.coerce.number().int().min(1).max(MAX_LICENSE_DAYS),
  isActive: z.coerce.boolean().default(false),
  price: z.coerce.number().min(0).default(0),
  discount: z.coerce.number().min(0).default(0),
});

const num = (min: number, max?: number) =>
  max === undefined ? z.coerce.number().min(min) : z.coerce.number().min(min).max(max);

const planSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60),
    summary: z.string().max(500),
    isActive: z.coerce.boolean(),
    pricing: z.array(pricingEntry).max(20),
    freeAiDailyLimit: num(0, 10000),
    aiEnabled: z.coerce.boolean(),
    proAiDailyLimit: num(0, 100000),
    // the AI Pro sells (Lib/ai/planAi.ts), cleaned in the handler
    aiFeatures: z.unknown(),
    aiQuotas: z.unknown(),
    bookingDiscountEnabled: z.coerce.boolean(),
    bookingDiscountPercent: num(0, 100),
    bookingDiscountMax: num(0),
    bookingDiscountCapAtCommission: z.coerce.boolean(),
    familyEnabled: z.coerce.boolean(),
    deliveryEnabled: z.coerce.boolean(),
    deliveryFreeAbove: num(0),
    deliveryPercentOff: num(0, 100),
    cancelEnabled: z.coerce.boolean(),
    proFreeCancelHours: num(0, 168),
    supportEnabled: z.coerce.boolean(),
    supportPriority: z.enum(ticketPriorities),
  })
  .partial();

// POST /admin/pro/plan - the plan form (any subset of fields)
export const adminUpdateProPlan: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const parsed = planSchema.safeParse(req.body ?? {});
  if (!parsed.success) return next(new BadInputError(parsed.error.issues.map((i) => i.path.join(".")).join(", ")));
  const input = parsed.data;
  sanitizePlanAi("patient", input as Record<string, unknown>);
  if (input.pricing) {
    const days = input.pricing.map((p) => p.days);
    if (new Set(days).size !== days.length)
      return next(new AppError("هر مدت فقط یک بار در قیمت‌ها می‌آید", 400));
    if (input.pricing.some((p) => p.discount > p.price))
      return next(new AppError("تخفیف هر گزینه نمی‌تواند از قیمت آن بیشتر باشد", 400));
  }
  const plan = await getProPlan(true);
  const data = await PatientProPlan.findByIdAndUpdate(plan._id, { $set: input }, { new: true, runValidators: true }).lean();
  clearProPlanCache();
  res.status(200).json({ message: "adminUpdateProPlan", data });
});

const subscribersQuery = pagingQuery.extend({
  status: z.enum(["active", "scheduled", "expiring", "expired", "cancelled", "granted"]).optional(),
});

const userSelect = "_id phone username";

// GET /admin/pro/subscribers?status=&q=&page=&limit=&format=csv - every
// period, latest first; counts per state
export const adminListSubscribers: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const parsed = subscribersQuery.safeParse(req.query);
  if (!parsed.success) return next(new BadInputError());
  const data = parsed.data;
  const now = new Date();
  const soon = new Date(now.getTime() + 7 * DAY);
  const filters: Record<string, Record<string, unknown>> = {
    active: { status: "active", startedAt: { $lte: now }, expiresAt: { $gt: now } },
    scheduled: { status: "active", startedAt: { $gt: now } },
    expiring: { status: "active", startedAt: { $lte: now }, expiresAt: { $gt: now, $lte: soon } },
    expired: { status: { $in: ["active", "expired"] }, expiresAt: { $lte: now } },
    cancelled: { status: "cancelled" },
    granted: { grantedBy: { $exists: true } },
  };
  const filter: Record<string, unknown> = data.status ? { ...filters[data.status] } : {};
  if (data.q) filter.user = { $in: await searchUserIds(data.q) };
  const { skip, limit } = pageWindow(data);
  const since = new Date(now.getTime() - 30 * DAY);
  const [rows, total, counts, members, revenue] = await Promise.all([
    PatientSubscription.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({ path: "user", select: userSelect })
      .lean<(IPatientSubscription & { user: unknown })[]>(),
    PatientSubscription.countDocuments(filter),
    Promise.all(
      Object.entries(filters).map(async ([key, f]) => [key, await PatientSubscription.countDocuments(f)] as const),
    ),
    PatientSubscription.distinct("user", filters.active),
    PatientSubscription.aggregate<{ sum: number }>([
      { $match: { createdAt: { $gte: since }, paid: { $gt: 0 } } },
      { $group: { _id: null, sum: { $sum: "$paid" } } },
    ]),
  ]);
  const users = (Array.isArray(rows) ? rows : []).map((r) => r.user).filter(Boolean) as { _id: unknown }[];
  const identities = await UserIdentity.find({ user: { $in: users.map((u) => u._id) } })
    .select("user givenName lastName")
    .lean<{ user: unknown; givenName?: string; lastName?: string }[]>();
  const nameOf = new Map(identities.map((i) => [idOf(i.user), i]));
  const items = (Array.isArray(rows) ? rows : []).map((r) => {
    const u = (r.user || null) as { _id?: unknown; phone?: string; username?: string } | null;
    const idn = u ? nameOf.get(idOf(u._id)) : undefined;
    return {
      ...subscriptionView(r),
      user: u
        ? { _id: idOf(u._id), phone: u.phone, username: u.username, firstName: idn?.givenName, lastName: idn?.lastName }
        : null,
    };
  });
  if (data.format === "csv")
    return sendCsv(
      res,
      "pro-subscribers",
      ["کاربر", "مدت (روز)", "شروع", "پایان", "وضعیت", "قیمت", "پرداخت‌شده", "اعطایی"],
      items.map((r) => [userCsvLabel(r.user), r.days, r.startedAt, r.expiresAt, r.state, r.listPrice, r.paid, r.granted ? "بله" : "خیر"]),
    );
  res.status(200).json({
    message: "adminListSubscribers",
    data: items,
    total,
    page: data.page,
    limit,
    counts: Object.fromEntries(counts),
    stats: { members: members.length, revenue30d: revenue[0]?.sum || 0 },
  });
});

// GET /admin/pro/user/:userId - a user's membership (the user detail page)
export const adminGetUserPro: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { userId } = req.params;
  if (!isValidObjectId(userId)) return next(new BadInputError());
  const [status, history, usage] = await Promise.all([
    proStatusOf(userId),
    PatientSubscription.find({ user: userId }).sort({ startedAt: -1 }).limit(50).lean<IPatientSubscription[]>(),
    aiUsageOf(userId),
  ]);
  res.status(200).json({
    message: "adminGetUserPro",
    data: {
      active: status.active,
      until: status.until,
      current: status.current ? subscriptionView(status.current) : null,
      history: (Array.isArray(history) ? history : []).map((s) => subscriptionView(s)),
      ai: usage,
    },
  });
});

const grantSchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(366),
  note: z.string().trim().min(3).max(500),
});

// POST /admin/pro/user/:userId/grant {days, note} - a free period (support)
export const adminGrantPro: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  const { userId } = req.params;
  if (!isValidObjectId(userId)) return next(new BadInputError());
  const parsed = grantSchema.safeParse(req.body ?? {});
  if (!parsed.success) return next(new AppError("مدت و دلیل اعطای اشتراک را بنویسید", 400));
  if (!(await User.exists({ _id: userId }))) return next(new NotFoundError("کاربر"));
  const sub = await grantPro(userId, parsed.data.days, req.user._id, parsed.data.note);
  const plan = await getProPlan();
  notifyProPurchased(userId, plan.displayName || "پرو", new Date(sub.expiresAt));
  res.status(200).json({ message: "adminGrantPro", data: subscriptionView(sub.toObject() as IPatientSubscription) });
});

const cancelSchema = z.strictObject({ reason: z.string().trim().min(3).max(500) });

// POST /admin/pro/subscription/:nodeId/cancel {reason} - ends a period now
// (benefits stop at once). No money moves: a refund, when due, is a wallet
// adjustment with its own reason (Controllers/adminWalletController.ts).
export const adminCancelProSubscription: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  const { nodeId } = req.params;
  if (!isValidObjectId(nodeId)) return next(new BadInputError());
  const parsed = cancelSchema.safeParse(req.body ?? {});
  if (!parsed.success) return next(new AppError("دلیل لغو اشتراک را بنویسید", 400));
  const data = await PatientSubscription.findOneAndUpdate(
    { _id: nodeId, status: "active" },
    { $set: { status: "cancelled", cancelledAt: new Date(), cancelledBy: req.user._id, note: parsed.data.reason } },
    { new: true },
  ).lean<IPatientSubscription>();
  if (!data) return next(new AppError("این دوره‌ی اشتراک فعال نیست", 400));
  res.status(200).json({ message: "adminCancelProSubscription", data: subscriptionView(data) });
});
