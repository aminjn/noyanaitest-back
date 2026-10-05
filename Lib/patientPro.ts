import mongoose from "mongoose";
import AppError from "./AppError";
import PatientProPlan, { IPatientProPlan } from "../Models/PatientProPlan";
import PatientSubscription, { IPatientSubscription } from "../Models/PatientSubscription";
import Transaction from "../Models/Transaction";
import Wallet from "../Models/Wallet";
import { IBaseLicensePricing } from "../Models/BaseLicensePricing";
import { findActivePricing } from "./licensePricing";
import { chargeLicensePurchase, LicensePurchaseQuote, quoteLicensePurchase } from "./licenseQuote";
import { getCommissionPercent, splitCommission } from "./commission";
import { TicketPriority } from "../Models/Ticket";

// «پرو» (2026-10, owner request): the patients' paid membership - see
// Models/PatientProPlan.ts. This file is the one place that answers "is
// this user Pro, and what does that give them here": every benefit is
// decided on the server, in the flow it changes:
//   - AI assistant daily messages ........ the AI policy (Lib/ai/aiGate.ts)
//   - visit discount ..................... bookingDiscountFor (bookingController)
//   - delivery discount .................. deliveryDiscountFor (cartController)
//   - free-cancel window ................. freeCancelHoursFor (userController)
//   - support priority ................... ticketPriorityFor (supportController)
// Bought from the wallet with the provider-plan price rule
// (Lib/licenseQuote.ts, kind "patient": option discount + launch
// promotions), posted to the books and the Moadian invoices like a plan
// (Transaction.proPlan).

const DAY = 24 * 60 * 60 * 1000;

// assumed launch prices (toman), to be confirmed by the owner in the admin
// tab: about one online visit's commission a month; 3 months -16%,
// 12 months -34% (One Medical / Practo Plus sell the year the cheapest)
export const DEFAULT_PRO_PRICING: IBaseLicensePricing[] = [
  { days: 30, isActive: true, price: 99_000, discount: 0 },
  { days: 90, isActive: true, price: 297_000, discount: 48_000 },
  { days: 365, isActive: true, price: 1_188_000, discount: 399_000 },
];

let planCache: { at: number; plan: IPatientProPlan } | null = null;
export const clearProPlanCache = () => {
  planCache = null;
};

// The one «پرو» plan; created with the defaults the first time it is asked
// for (on sale, so the owner sees it live and can switch it off).
export const getProPlan = async (fresh = false): Promise<IPatientProPlan> => {
  if (!fresh && planCache && Date.now() - planCache.at < 15_000) return planCache.plan;
  let plan = await PatientProPlan.findOne({}).sort({ order: 1, _id: 1 }).lean<IPatientProPlan>();
  if (!plan) {
    try {
      await PatientProPlan.create({ displayName: "پرو", isActive: true, pricing: DEFAULT_PRO_PRICING });
    } catch {
      // created meanwhile by another request
    }
    plan = await PatientProPlan.findOne({}).sort({ order: 1, _id: 1 }).lean<IPatientProPlan>();
  }
  if (!plan) throw new AppError("اشتراک پرو تعریف نشده است", 500);
  planCache = { at: Date.now(), plan };
  return plan;
};

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

export type ProStatus = {
  active: boolean;
  // the period that holds now
  current: IPatientSubscription | null;
  // the end of the last paid period (a renewal bought ahead extends it)
  until: Date | null;
};

export const proStatusOf = async (userId: unknown, now = new Date()): Promise<ProStatus> => {
  const id = idOf(userId);
  if (!id || !mongoose.isValidObjectId(id)) return { active: false, current: null, until: null };
  const [current, last] = await Promise.all([
    PatientSubscription.findOne({ user: id, status: "active", startedAt: { $lte: now }, expiresAt: { $gt: now } })
      .sort({ expiresAt: -1 })
      .lean<IPatientSubscription>(),
    PatientSubscription.findOne({ user: id, status: "active", expiresAt: { $gt: now } })
      .sort({ expiresAt: -1 })
      .select("expiresAt")
      .lean<IPatientSubscription>(),
  ]);
  return { active: !!current, current: current || null, until: last?.expiresAt || null };
};

export const isPro = async (userId: unknown) => (await proStatusOf(userId)).active;

// ------------------------------------------------------------ AI assistant

// The AI health assistant's allowance moved to the AI policy (2026-10,
// Lib/ai/aiPolicy.ts, feature "assistant.health"): free users get the free
// tier's daily messages, a Pro member the paid tier's (or the Pro plan's
// own quota). Counted per feature by Lib/ai/aiGate.ts.
const ASSISTANT = "assistant.health";

// "YYYY-MM-DD" of the Tehran calendar day
export const tehranDay = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

// today's allowance of the health assistant for this user
export const aiUsageOf = async (userId: unknown) => {
  const { aiFeatureStates } = await import("./ai/aiGate");
  const [pro, states] = await Promise.all([isPro(userId), aiFeatureStates({ audience: "patient", user: idOf(userId) }, [ASSISTANT])]);
  const st = states[ASSISTANT];
  const limit = st?.limit || 0;
  const used = st?.used || 0;
  return { pro, limit, used, remaining: limit ? Math.max(0, limit - used) : null, state: st?.state || "off" };
};

// what the Pro pages show of the AI benefit: the free tier's and a
// member's daily messages (0 = unlimited) and whether Pro raises it
export const aiBenefitOf = async (plan: IPatientProPlan) => {
  const { getAiPolicy } = await import("./ai/aiPolicy");
  const policy = await getAiPolicy();
  const fp = policy.features[ASSISTANT];
  const on = !!fp && policy.enabled && policy.mode !== "off" && fp.access !== "off";
  const quota = (plan as unknown as { aiQuotas?: Record<string, { day?: number }> }).aiQuotas?.[ASSISTANT]?.day;
  const proDay = typeof quota === "number" && quota >= 0 ? quota : fp?.limits.paid.day || 0;
  const included = !!fp?.pro || !!(plan as unknown as { aiFeatures?: string[] }).aiFeatures?.includes(ASSISTANT);
  return {
    aiEnabled: on && included,
    freeAiDailyLimit: fp?.access === "plan" ? 0 : fp?.limits.free.day || 0,
    proAiDailyLimit: proDay,
  };
};

// ------------------------------------------------------------ visits

// The member's discount on one visit: a percent of the pre-tax price,
// capped per visit and (by default) by the platform's commission on it,
// so the platform funds it and the doctor's payout never changes.
export const bookingDiscountFor = async (args: {
  userId: unknown;
  price: number;
  sessionType: string;
  doctorId: unknown;
  forRelative: boolean;
}): Promise<{ discount: number; pro: boolean; potential: number }> => {
  const plan = await getProPlan();
  const pro = await isPro(args.userId);
  const price = Math.max(0, Math.round(Number(args.price) || 0));
  if (!plan.bookingDiscountEnabled || price <= 0) return { discount: 0, pro, potential: 0 };
  let off = Math.round((price * Math.min(100, Math.max(0, Number(plan.bookingDiscountPercent) || 0))) / 100);
  const max = Math.max(0, Math.round(Number(plan.bookingDiscountMax) || 0));
  if (max > 0) off = Math.min(off, max);
  if (plan.bookingDiscountCapAtCommission) {
    const percent = await getCommissionPercent(
      args.sessionType === "inPerson" ? "doctorInPerson" : "doctorOnline",
      args.doctorId,
    );
    off = Math.min(off, splitCommission(price, percent).commission);
  }
  off = Math.max(0, Math.min(price, off));
  // what Pro would save here (the upsell line), whatever the user is
  const potential = plan.isActive || pro ? off : 0;
  if (!pro || (args.forRelative && !plan.familyEnabled)) return { discount: 0, pro, potential };
  return { discount: off, pro, potential };
};

// ------------------------------------------------------------ delivery

type ShipmentLike = { fee: number; proDiscount?: number };

// The platform's share of each courier fee for a member's order whose
// subtotal reaches the threshold. Returns the shipments with proDiscount
// set and the total; `potential` is what a non-member would save.
export const deliveryDiscountFor = async <S extends ShipmentLike>(
  userId: unknown,
  subtotal: number,
  shipments: S[],
): Promise<{ shipments: S[]; discount: number; pro: boolean; potential: number; threshold: number }> => {
  const plan = await getProPlan();
  const pro = await isPro(userId);
  const threshold = Math.max(0, Math.round(Number(plan.deliveryFreeAbove) || 0));
  const percent = Math.min(100, Math.max(0, Number(plan.deliveryPercentOff) || 0));
  const list = Array.isArray(shipments) ? shipments : [];
  const offOf = (fee: number) => Math.min(fee, Math.round((Math.max(0, Number(fee) || 0) * percent) / 100));
  const qualifies = plan.deliveryEnabled && percent > 0 && subtotal >= threshold;
  const potential = qualifies && (plan.isActive || pro) ? list.reduce((s, el) => s + offOf(el.fee), 0) : 0;
  if (!pro || !qualifies)
    return { shipments: list.map((el) => ({ ...el, proDiscount: 0 })), discount: 0, pro, potential, threshold };
  const out = list.map((el) => ({ ...el, proDiscount: offOf(el.fee) }));
  return { shipments: out, discount: out.reduce((s, el) => s + (el.proDiscount || 0), 0), pro, potential, threshold };
};

// ------------------------------------------------------------ cancel, support

// a member's free-cancel window: the shorter of the site's and Pro's
export const freeCancelHoursFor = async (userId: unknown, base: number): Promise<number> => {
  const plan = await getProPlan();
  if (!plan.cancelEnabled) return base;
  if (!(await isPro(userId))) return base;
  const hours = Number(plan.proFreeCancelHours);
  return Number.isFinite(hours) && hours >= 0 ? Math.min(base, hours) : base;
};

export const ticketPriorityFor = async (userId: unknown): Promise<TicketPriority | null> => {
  const plan = await getProPlan();
  if (!plan.supportEnabled) return null;
  return (await isPro(userId)) ? plan.supportPriority || "high" : null;
};

// ------------------------------------------------------------ purchase

// A new period starts when the member's last one ends (renewing early
// loses no day), or now.
const nextStartOf = async (userId: unknown, now: Date) => {
  const last = await PatientSubscription.findOne({ user: idOf(userId), status: "active", expiresAt: { $gt: now } })
    .sort({ expiresAt: -1 })
    .select("expiresAt")
    .lean<IPatientSubscription>();
  return last?.expiresAt ? new Date(last.expiresAt) : now;
};

export const quoteProPurchase = async (userId: unknown, days: number, code?: string) => {
  const plan = await getProPlan(true);
  if (!plan.isActive) return new AppError("اشتراک پرو در حال حاضر فروخته نمی‌شود", 400);
  const option = findActivePricing(plan.pricing, Number(days));
  if (!option) return new AppError("این مدت برای اشتراک پرو فروخته نمی‌شود", 400);
  const quote = await quoteLicensePurchase({
    kind: "patient",
    plan: plan as never,
    option,
    ownerId: idOf(userId),
    code,
  });
  if (quote instanceof AppError) return quote;
  return { plan, quote };
};

export const purchasePro = async (
  userId: unknown,
  days: number,
  code?: string,
): Promise<AppError | { subscription: IPatientSubscription; quote: LicensePurchaseQuote; plan: IPatientProPlan }> => {
  const priced = await quoteProPurchase(userId, days, code);
  if (priced instanceof AppError) return priced;
  const { plan, quote } = priced;
  const charged = await chargeLicensePurchase(idOf(userId), quote);
  if (charged) return charged;
  const now = new Date();
  try {
    const startedAt = await nextStartOf(userId, now);
    const expiresAt = new Date(startedAt.getTime() + quote.days * DAY);
    const subscription = await PatientSubscription.create({
      user: idOf(userId),
      plan: plan._id,
      days: quote.days,
      startedAt,
      expiresAt,
      listPrice: quote.listPrice,
      value: quote.quoted,
      paid: quote.final,
      promotion: quote.promotion?._id,
    });
    if (quote.final > 0) {
      const tx = await Transaction.create({
        user: idOf(userId),
        amount: -quote.final,
        proPlan: plan._id,
        proSubscription: subscription._id,
      });
      await PatientSubscription.updateOne({ _id: subscription._id }, { $set: { transaction: tx._id } });
      subscription.transaction = tx._id as mongoose.Types.ObjectId;
    }
    return { subscription: subscription.toObject() as IPatientSubscription, quote, plan };
  } catch (err) {
    // the wallet was debited but nothing shows for it: give it back
    if (quote.final > 0)
      await Wallet.updateOne({ user: idOf(userId) }, { $inc: { balance: quote.final } }).catch(() => {});
    throw err;
  }
};

// A support grant: a period with no payment (a complaint, a partner
// campaign). Stacks like a purchase.
export const grantPro = async (userId: unknown, days: number, by: unknown, note?: string) => {
  const plan = await getProPlan(true);
  const now = new Date();
  const startedAt = await nextStartOf(userId, now);
  return PatientSubscription.create({
    user: idOf(userId),
    plan: plan._id,
    days,
    startedAt,
    expiresAt: new Date(startedAt.getTime() + days * DAY),
    grantedBy: idOf(by),
    note,
  });
};
