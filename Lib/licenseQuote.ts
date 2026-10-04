import mongoose, { Model } from "mongoose";
import AppError from "./AppError";
import BaseDoctorLicense from "../Models/BaseDoctorLicense";
import BaseClinicLicense from "../Models/BaseClinicLicense";
import BaseHospitalLicense from "../Models/BaseHospitalLicense";
import BasePharmacyLicense from "../Models/BasePharmacyLicense";
import BaseParaClinicLicense from "../Models/BaseParaClinicLicense";
import BaseInsuranceLicense from "../Models/BaseInsuranceLicense";
import Transaction from "../Models/Transaction";
import Wallet from "../Models/Wallet";
import LicensePromotion, {
  ILicensePromotion,
  LicensePromotionRedemption,
} from "../Models/LicensePromotion";
import { IBaseLicensePricing } from "../Models/BaseLicensePricing";
import LicensePurchase from "../Models/LicensePurchase";

// The one price rule for a provider plan (2026-10): the price option's own
// discount first, then the best running promotion (Models/LicensePromotion
// .ts). Used by the six purchaseLicense handlers and by the pricing
// endpoint the panel and public pages read, so what is shown is what is
// charged - and the wallet transaction (hence the ledger and the Moadian
// invoice, which read its amount) carries the discounted price.

export const licenseKindList = [
  "doctor",
  "clinic",
  "hospital",
  "pharmacy",
  "paraClinic",
  "insurance",
] as const;
export type LicenseKind = (typeof licenseKindList)[number];

export const isLicenseKind = (v: unknown): v is LicenseKind =>
  licenseKindList.includes(v as LicenseKind);

// the plan catalog of each kind and the transaction fields a purchase sets
const registry: Record<LicenseKind, { plan: Model<any>; txOrg: string; txPlan: string }> = {
  doctor: { plan: BaseDoctorLicense as Model<any>, txOrg: "doctor", txPlan: "license" },
  clinic: { plan: BaseClinicLicense as Model<any>, txOrg: "clinic", txPlan: "clinicLicense" },
  hospital: { plan: BaseHospitalLicense as Model<any>, txOrg: "hospital", txPlan: "hospitalLicense" },
  pharmacy: { plan: BasePharmacyLicense as Model<any>, txOrg: "pharmacy", txPlan: "pharmacyLicense" },
  paraClinic: { plan: BaseParaClinicLicense as Model<any>, txOrg: "paraClinic", txPlan: "paraClinicLicense" },
  insurance: { plan: BaseInsuranceLicense as Model<any>, txOrg: "insurance", txPlan: "insuranceLicense" },
};

export const planModelOf = (kind: LicenseKind) => registry[kind].plan;

type PromotionLike = Pick<
  ILicensePromotion,
  | "title"
  | "discountType"
  | "value"
  | "maxDiscount"
  | "startsAt"
  | "endsAt"
  | "kinds"
  | "plans"
  | "firstPurchaseOnly"
  | "code"
  | "maxRedemptions"
  | "redemptions"
> & { _id: unknown; translations?: unknown };

export interface LicenseQuote {
  days: number;
  // the option's list price, before any discount
  listPrice: number;
  // the option's own discount (the plan form)
  planDiscount: number;
  // after the option's own discount
  price: number;
  promotionDiscount: number;
  // the option's price with promotions, before an upgrade credit
  quoted: number;
  // the unused value of the provider's current plan (a mid-term upgrade)
  upgradeCredit: number;
  // what is charged: quoted - upgradeCredit, never below 0
  final: number;
  // false: a plan not higher than the current one (no downgrade mid-term)
  upgradable: boolean;
  // off the list price, all discounts together
  percentOff: number;
  promotion: null | {
    _id: string;
    title: string;
    endsAt: Date;
    firstPurchaseOnly: boolean;
    withCode: boolean;
  };
}

const clampMoney = (n: unknown) => Math.max(0, Math.round(Number(n) || 0));

// what a promotion takes off a price
export const promotionDiscountOf = (promo: PromotionLike, price: number) => {
  if (price <= 0) return 0;
  const value = Math.max(0, Number(promo.value) || 0);
  let off =
    promo.discountType === "amount"
      ? value
      : Math.round((price * Math.min(100, value)) / 100);
  const cap = clampMoney(promo.maxDiscount);
  if (promo.discountType !== "amount" && cap > 0) off = Math.min(off, cap);
  return Math.min(price, Math.max(0, off));
};

export const promotionCovers = (
  promo: PromotionLike,
  kind: LicenseKind,
  planId: unknown,
) =>
  (Array.isArray(promo.kinds) && promo.kinds.includes(kind)) ||
  (Array.isArray(promo.plans) && promo.plans.map(String).includes(String(planId)));

// running promotions, newest end first (cached briefly: the pricing pages
// read it on every view)
let cache: { at: number; list: PromotionLike[] } | null = null;
export const clearPromotionCache = () => {
  cache = null;
};
export const runningPromotions = async (now = new Date()): Promise<PromotionLike[]> => {
  if (cache && Date.now() - cache.at < 15_000)
    return cache.list.filter((p) => new Date(p.startsAt) <= now && new Date(p.endsAt) > now);
  const list = await LicensePromotion.find({
    isActive: true,
    endsAt: { $gt: now },
  })
    .sort({ endsAt: 1 })
    .lean<PromotionLike[]>();
  const usable = list.filter((p) => !p.maxRedemptions || (p.redemptions || 0) < p.maxRedemptions);
  cache = { at: Date.now(), list: usable };
  return usable.filter((p) => new Date(p.startsAt) <= now);
};

export const normalizeCode = (code: unknown) =>
  typeof code === "string" ? code.trim().toUpperCase().slice(0, 40) : "";

// Prices one option. `firstPurchase` undefined = unknown (a pricing page):
// a first-purchase-only promotion is still shown, flagged as such.
export const quoteOption = (args: {
  kind: LicenseKind;
  planId: unknown;
  option: Pick<IBaseLicensePricing, "days" | "price" | "discount">;
  promotions: PromotionLike[];
  code?: string;
  firstPurchase?: boolean;
  // the unused value of the current plan, taken off an upgrade
  credit?: number;
  upgradable?: boolean;
}): LicenseQuote => {
  const listPrice = clampMoney(args.option.price);
  const planDiscount = Math.min(listPrice, clampMoney(args.option.discount));
  const price = listPrice - planDiscount;
  const code = normalizeCode(args.code);
  let best: { promo: PromotionLike; off: number } | null = null;
  for (const promo of args.promotions) {
    if (!promotionCovers(promo, args.kind, args.planId)) continue;
    if (promo.code && promo.code !== code) continue;
    if (promo.firstPurchaseOnly && args.firstPurchase === false) continue;
    const off = promotionDiscountOf(promo, price);
    if (off > 0 && (!best || off > best.off)) best = { promo, off };
  }
  const promotionDiscount = best?.off || 0;
  const quoted = price - promotionDiscount;
  const upgradeCredit = Math.min(quoted, clampMoney(args.credit));
  const final = Math.max(0, quoted - upgradeCredit);
  return {
    days: Number(args.option.days) || 0,
    listPrice,
    planDiscount,
    price,
    promotionDiscount,
    quoted,
    upgradeCredit,
    final,
    upgradable: args.upgradable !== false,
    percentOff: listPrice > 0 ? Math.round(((listPrice - quoted) / listPrice) * 100) : 0,
    promotion: best
      ? {
          _id: String(best.promo._id),
          title: best.promo.title || "",
          endsAt: best.promo.endsAt,
          firstPurchaseOnly: !!best.promo.firstPurchaseOnly,
          withCode: !!best.promo.code,
        }
      : null,
  };
};

// Whether this provider has never bought a plan: no plan transaction and no
// promotion use (a 100% promotion leaves no transaction behind).
export const isFirstPurchase = async (kind: LicenseKind, ownerId: unknown) => {
  const { txOrg, txPlan } = registry[kind];
  const [tx, used] = await Promise.all([
    Transaction.exists({ [txOrg]: ownerId, [txPlan]: { $exists: true } }),
    LicensePromotionRedemption.exists({ kind, owner: ownerId }),
  ]);
  return !tx && !used;
};

export const codeMatchesAny = (promotions: PromotionLike[], code: string) =>
  !!code && promotions.some((p) => p.code === code);

export interface LicensePurchaseQuote extends LicenseQuote {
  kind: LicenseKind;
  ownerId: unknown;
  planId: unknown;
  // the purchase record of the plan this upgrade replaces
  upgradeFrom: unknown;
  isUpgrade: boolean;
}

// ---------------------------------------------------------------- upgrade
//
// Mid-term upgrade (2026-10): a provider on a running plan may buy a higher
// plan at any time - more expensive per month, or the same price with more
// modules. It pays the new option's quoted price minus the unused value of
// the current plan (remaining whole days x what that period cost per day),
// never below zero; the new period starts now. A lower or equal plan waits
// until the current one ends. Like Doctolib Pro / Docplanner moving a
// practice to a bigger package mid-contract, credited pro rata.

const DAY_MS = 24 * 60 * 60 * 1000;

type PlanLike = { _id: unknown; pricing?: IBaseLicensePricing[]; modules?: string[] };
type ProfileLicenseLike = {
  baseLicense?: unknown;
  modules?: string[];
  startedAt?: Date | string | null;
  expiresAt?: Date | string | null;
} | null | undefined;

// a plan's cheapest monthly price (its own options, no promotion)
export const monthlyOf = (plan: PlanLike | null | undefined) => {
  const rates = (Array.isArray(plan?.pricing) ? plan!.pricing : [])
    .filter((p) => p && p.isActive && Number(p.days) > 0)
    .map((p) => ((clampMoney(p.price) - Math.min(clampMoney(p.price), clampMoney(p.discount))) / Number(p.days)) * 30);
  return rates.length ? Math.min(...rates) : 0;
};

export interface UpgradeContext {
  // the provider has a running plan
  active: boolean;
  planId: string | null;
  monthly: number;
  modules: string[];
  expiresAt: Date | null;
  remainingDays: number;
  // what the current period cost, and the part of it still unused
  value: number;
  credit: number;
  purchaseId: unknown;
}

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

export const upgradeContextOf = async (
  kind: LicenseKind,
  ownerId: unknown,
  current: ProfileLicenseLike,
): Promise<UpgradeContext> => {
  const none: UpgradeContext = {
    active: false, planId: null, monthly: 0, modules: [], expiresAt: null,
    remainingDays: 0, value: 0, credit: 0, purchaseId: null,
  };
  if (!current) return none;
  const expiresAt = current.expiresAt ? new Date(current.expiresAt) : null;
  const now = Date.now();
  if (expiresAt && expiresAt.getTime() <= now) return none;
  const planId = idOf(current.baseLicense) || null;
  const plan = planId
    ? await registry[kind].plan.findById(planId).select("pricing modules").lean<PlanLike>()
    : null;
  const startedAt = current.startedAt ? new Date(current.startedAt) : null;
  let value = 0;
  let purchaseId: unknown = null;
  if (planId && startedAt) {
    const purchase = await LicensePurchase.findOne({
      kind, owner: ownerId, plan: planId, status: "active", startedAt,
    }).lean<{ _id: unknown; value?: number }>();
    if (purchase) {
      value = clampMoney(purchase.value);
      purchaseId = purchase._id;
    } else {
      // bought before purchase records existed: the wallet transaction
      // written right after the licence
      const { txOrg, txPlan } = registry[kind];
      const tx = await Transaction.findOne({
        [txOrg]: ownerId,
        [txPlan]: planId,
        amount: { $lt: 0 },
        createdAt: { $gte: startedAt, $lte: new Date(startedAt.getTime() + 10 * 60 * 1000) },
      }).lean<{ amount?: number }>();
      value = clampMoney(-(Number(tx?.amount) || 0));
    }
  }
  // a plan with no end (granted by hand) has nothing to credit
  let remainingDays = 0;
  let credit = 0;
  if (expiresAt && startedAt) {
    remainingDays = Math.max(0, Math.floor((expiresAt.getTime() - now) / DAY_MS));
    const totalDays = Math.max(1, Math.round((expiresAt.getTime() - startedAt.getTime()) / DAY_MS));
    credit = Math.min(value, Math.round((value * Math.min(remainingDays, totalDays)) / totalDays));
  }
  return {
    active: true,
    planId,
    monthly: monthlyOf(plan),
    modules: Array.isArray(plan?.modules) ? plan!.modules : Array.isArray(current.modules) ? current.modules : [],
    expiresAt,
    remainingDays,
    value,
    credit,
    purchaseId,
  };
};

// higher = more per month, or the same per month with more modules
export const isHigherPlan = (ctx: UpgradeContext, plan: PlanLike) => {
  if (!ctx.active) return true;
  if (ctx.planId && idOf(plan._id) === ctx.planId) return false;
  const monthly = monthlyOf(plan);
  const modules = Array.isArray(plan.modules) ? plan.modules : [];
  const superset = ctx.modules.every((m) => modules.includes(m)) && modules.length > ctx.modules.length;
  if (monthly > ctx.monthly + 0.5) return true;
  return Math.abs(monthly - ctx.monthly) <= 0.5 && superset;
};

// The price of a purchase. A code that matches no running promotion for
// this plan is refused, so nobody pays the full price thinking it applied.
export const quoteLicensePurchase = async (args: {
  kind: LicenseKind;
  plan: PlanLike;
  option: Pick<IBaseLicensePricing, "days" | "price" | "discount">;
  ownerId: unknown;
  code?: string;
  // the provider's current licence: a running one makes this an upgrade
  current?: ProfileLicenseLike;
}): Promise<LicensePurchaseQuote | AppError> => {
  const ctx = await upgradeContextOf(args.kind, args.ownerId, args.current);
  if (ctx.active && !isHigherPlan(ctx, args.plan))
    return new AppError("تا پایان پلن فعلی فقط می‌توانید به پلن بالاتر ارتقا دهید", 400);
  const promotions = await runningPromotions();
  const code = normalizeCode(args.code);
  const firstPurchase = ctx.active ? false : await isFirstPurchase(args.kind, args.ownerId);
  const quote = quoteOption({
    kind: args.kind,
    planId: args.plan._id,
    option: args.option,
    promotions,
    code,
    firstPurchase,
    credit: ctx.credit,
  });
  if (code && !(quote.promotion && quote.promotion.withCode))
    return new AppError("کد تخفیف برای این پلن معتبر نیست", 400);
  return {
    ...quote,
    kind: args.kind,
    ownerId: args.ownerId,
    planId: args.plan._id,
    upgradeFrom: ctx.purchaseId,
    isUpgrade: ctx.active,
  };
};

// The history of a bought period, written once the licence is saved: an
// upgrade ends the period it replaces ("upgraded", kept), a new purchase
// closes whatever period ran out before it.
export const recordLicensePurchase = async (
  quote: LicensePurchaseQuote,
  userId: unknown,
  period: { startedAt: Date; expiresAt: Date },
) => {
  const record = await LicensePurchase.create({
    kind: quote.kind,
    owner: quote.ownerId,
    user: userId,
    plan: quote.planId,
    days: quote.days,
    listPrice: quote.listPrice,
    value: quote.quoted,
    upgradeCredit: quote.upgradeCredit,
    paid: quote.final,
    promotion: quote.promotion?._id,
    upgradedFrom: quote.isUpgrade ? quote.upgradeFrom || undefined : undefined,
    startedAt: period.startedAt,
    expiresAt: period.expiresAt,
  });
  await LicensePurchase.updateMany(
    { kind: quote.kind, owner: quote.ownerId, status: "active", _id: { $ne: record._id } },
    quote.isUpgrade
      ? { $set: { status: "ended", endedAt: period.startedAt, endReason: "upgraded", upgradedTo: record._id } }
      : { $set: { status: "ended", endedAt: period.startedAt } },
  );
  return record;
};

// Takes the money for a quoted purchase: claims a use of the promotion
// (atomically, within its limit), then debits the wallet in one step;
// a failed debit gives the use back. Returns an error, or null when paid.
export const chargeLicensePurchase = async (
  userId: unknown,
  quote: LicensePurchaseQuote,
): Promise<AppError | null> => {
  let redemption: mongoose.Types.ObjectId | null = null;
  const promoId = quote.promotion?._id;
  if (promoId) {
    const claimed = await LicensePromotion.findOneAndUpdate(
      {
        _id: promoId,
        isActive: true,
        endsAt: { $gt: new Date() },
        $or: [{ maxRedemptions: 0 }, { $expr: { $lt: ["$redemptions", "$maxRedemptions"] } }],
      },
      { $inc: { redemptions: 1 } },
      { new: true },
    );
    if (!claimed) {
      clearPromotionCache();
      return new AppError("مهلت یا ظرفیت این تخفیف تمام شده است؛ صفحه را دوباره باز کنید", 400);
    }
    clearPromotionCache();
    const r = await LicensePromotionRedemption.create({
      promotion: promoId,
      kind: quote.kind,
      owner: quote.ownerId,
      user: userId,
      plan: quote.planId,
      days: quote.days,
      listPrice: quote.listPrice,
      discount: quote.listPrice - quote.quoted,
      paid: quote.final,
    });
    redemption = r._id as mongoose.Types.ObjectId;
  }
  const release = async () => {
    if (!promoId) return;
    await LicensePromotion.updateOne({ _id: promoId, redemptions: { $gt: 0 } }, { $inc: { redemptions: -1 } });
    if (redemption) await LicensePromotionRedemption.deleteOne({ _id: redemption });
    clearPromotionCache();
  };
  const price = quote.final;
  if (price > 0) {
    // one atomic step: debit only if the balance covers it (a separate
    // read-check-then-decrement let two requests both pass the check)
    await Wallet.updateOne(
      { user: userId },
      { $setOnInsert: { user: userId } },
      { upsert: true },
    );
    const debited = await Wallet.findOneAndUpdate(
      { user: userId, balance: { $gte: price } },
      { $inc: { balance: -price } },
      { new: true },
    );
    if (!debited) {
      await release();
      return new AppError("موجودی کیف پول شما کافی نیست", 400);
    }
  }
  return null;
};

// The pricing of every active plan of a kind, for the panel licence pages
// and the public pricing page: each price option with its quote.
export const pricingOfKind = async (
  kind: LicenseKind,
  code?: string,
  // a signed-in provider's running plan: prices become upgrade prices
  ctx?: UpgradeContext,
) => {
  const now = new Date();
  const promotions = await runningPromotions(now);
  const normalized = normalizeCode(code);
  const plans = await registry[kind].plan
    .find({ isActive: true })
    .sort({ order: 1 })
    .select("-details");
  const quotes: Record<string, LicenseQuote[]> = {};
  for (const plan of plans) {
    const pricing: IBaseLicensePricing[] = Array.isArray(plan.pricing) ? plan.pricing : [];
    quotes[String(plan._id)] = pricing
      .filter((p) => p && p.isActive && Number(p.days) > 0)
      .map((option) => {
        const upgradable = !ctx?.active || isHigherPlan(ctx, plan);
        return quoteOption({
          kind,
          planId: plan._id,
          option,
          promotions,
          code: normalized,
          firstPurchase: ctx?.active ? false : undefined,
          credit: ctx?.active && upgradable ? ctx.credit : 0,
          upgradable,
        });
      });
  }
  // the promotions this kind's pages advertise (the banner and its
  // countdown); a code promotion stays hidden until its code is entered
  const advertised = promotions
    .filter(
      (p) =>
        (!p.code || p.code === normalized) &&
        plans.some((plan) => promotionCovers(p, kind, plan._id)),
    )
    .map((p) => ({
      _id: String(p._id),
      title: p.title || "",
      discountType: p.discountType,
      value: p.value,
      maxDiscount: p.maxDiscount || 0,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      firstPurchaseOnly: !!p.firstPurchaseOnly,
      withCode: !!p.code,
      translations: p.translations,
    }));
  return {
    licenses: plans,
    durations: Array.from(
      new Set(Object.values(quotes).flatMap((list) => list.map((q) => q.days))),
    ).sort((a, b) => a - b),
    quotes,
    promotions: advertised,
    code: normalized,
    codeValid: normalized ? codeMatchesAny(promotions, normalized) : null,
    now,
    current: ctx?.active
      ? {
          planId: ctx.planId,
          expiresAt: ctx.expiresAt,
          remainingDays: ctx.remainingDays,
          credit: ctx.credit,
        }
      : null,
  };
};
