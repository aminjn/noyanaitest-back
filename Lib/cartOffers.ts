import mongoose, { isValidObjectId } from "mongoose";
import LicensePromotion, {
  ILicensePromotion,
  LicensePromotionRedemption,
  OrderPromotionKind,
} from "../Models/LicensePromotion";
import BizClubRedemption, { IBizClubRedemption } from "../Models/BizClubRedemption";
import BizClubReward from "../Models/BizClubReward";
import BizClubSettings from "../Models/BizClubSettings";
import BizContact, { IBizContact } from "../Models/BizContact";
import Order, { IOrder } from "../Models/Order";
import { clearPromotionCache, normalizeCode, promotionDiscountOf } from "./licenseQuote";
import { findClubCode } from "./bookingFlow";
import { clubSettings, earnedOf, memberRows, reconcileRedemptions, rewardAmount, splitDiscount } from "./business/crmService/club";
import { partOn } from "./business/crmService/profiles";
import { syncContacts } from "./business/crm";
import { orgInfo } from "./business/campaign";
import { BizOwner } from "./business/coa";
import { calcTax } from "./taxSettings";
import { CartInsuranceQuote, quoteCartInsurance } from "./cartInsurance";

// Discounts and insurance in the cart checkout (2026-10). The doctor
// booking already had them (Lib/bookingFlow.ts: the doctor's club code,
// the «پرو» discount, the insurers' shares); a pharmacy / lab order now
// gets the same, from the same engines:
//
//   a discount code   - a promotion of the super admin's «تخفیف و پیشنهاد
//                       ویژه» (Models/LicensePromotion.ts, priced by
//                       Lib/licenseQuote.ts promotionDiscountOf) made for
//                       cart orders: pharmacy and / or lab lines, optionally
//                       only some sellers or categories, a minimum, a cap,
//                       uses in total and per buyer, its dates, and who
//                       funds it. A promotion without a code applies by
//                       itself; the best single one wins, they never stack
//                       (Digikala, Snapp Pharmacy: one code per order).
//   a club code       - a code of the seller's own patient club
//                       (Lib/business/crmService/club.ts; the booking's
//                       findClubCode): the seller's discount on its lines,
//                       one per seller. The buyer may also spend points on a
//                       reward right in the checkout (the club's own
//                       redeemReward) and use its code at once.
//   insurance         - the supplementary insurer's share
//                       (Lib/cartInsurance.ts).
//
// The order of a line's money, the same as a visit's:
//   sale       = price*qty - club code - a seller-funded discount code
//   tax        = the seller's VAT on the sale
//   insurer    = the insurer's share of the sale
//   discount   = a platform-funded discount code, on what the buyer pays
//   buyer pays = sale - insurer - platform discount + tax
//
// Codes and the insurer share are quoted here for the checkout view and
// again at order creation (the page's figures are never trusted); the
// order then holds the promotion use and the club codes (holdOrderOffers),
// which the payment callback checks once more (offerHoldsValid), and which
// go back when the order is never paid or is cancelled in full
// (releaseOrderOffers / releaseEndedOffers).

type Id = mongoose.Types.ObjectId | string;
const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

export type OfferOwnerKind = "pharmacy" | "paraClinic" | "doctor";

// one cart line, as the checkout prices it
export type OfferLine = {
  lineTotal: number;
  taxPercent: number;
  ownerKind: OfferOwnerKind;
  ownerId: string;
  ownerName?: string;
  // the item's product / test category
  category?: string | null;
  rx: boolean;
};

export type CodeResult = {
  code: string;
  kind: "promo" | "club" | null;
  applied: boolean;
  name?: string;
  // Persian, translated by the caller
  error?: string;
};

export type LineOffer = {
  clubDiscount: number;
  promoDiscount: number;
  insurerShare: number;
  insuranceStatus: "pending" | "reimburse" | null;
  tax: number;
  // what the buyer pays for the line
  pay: number;
};

export type AppliedPromo = {
  promotion: string;
  code?: string;
  title: string;
  fundedBy: "platform" | "seller";
  amount: number;
  // the covered items' list price (the redemption's listPrice)
  eligible: number;
  // (2026-10) the terms and the covered lines (their indexes), snapshotted
  // on the order for a partial cancel's re-check (Lib/orderPromoRecheck.ts)
  terms: { discountType: "percent" | "amount"; value: number; maxDiscount: number; minOrder: number };
  lines: number[];
};

export type AppliedClub = {
  ownerKind: OfferOwnerKind;
  ownerId: string;
  redemption: string;
  code: string;
  name?: string;
  amount: number;
  // indexes of the lines it is on
  lines: number[];
};

export type CartOffersQuote = {
  lines: LineOffer[];
  promo: AppliedPromo | null;
  clubs: AppliedClub[];
  codes: CodeResult[];
  insurance: CartInsuranceQuote;
  clubDiscount: number;
  promoDiscount: number;
  insurerShare: number;
  tax: number;
};

// ------------------------------------------------------------ promotions

type OrderPromotion = Pick<
  ILicensePromotion,
  | "title"
  | "discountType"
  | "value"
  | "maxDiscount"
  | "startsAt"
  | "endsAt"
  | "kinds"
  | "firstPurchaseOnly"
  | "code"
  | "maxRedemptions"
  | "redemptions"
  | "pharmacies"
  | "paraClinics"
  | "productCategories"
  | "testCategories"
  | "minOrder"
  | "maxPerUser"
  | "fundedBy"
  | "isActive"
> & { _id: unknown };

const kindOfLine = (l: OfferLine): OrderPromotionKind | null =>
  l.ownerKind === "pharmacy" ? "pharmacyOrder" : l.ownerKind === "paraClinic" ? "labOrder" : null;

// is this line one the promotion is for
export const promotionCoversLine = (p: OrderPromotion, l: OfferLine) => {
  const kind = kindOfLine(l);
  if (!kind || !(p.kinds || []).includes(kind)) return false;
  const sellers = (kind === "pharmacyOrder" ? p.pharmacies : p.paraClinics) || [];
  if (sellers.length && !sellers.map(String).includes(l.ownerId)) return false;
  const cats = (kind === "pharmacyOrder" ? p.productCategories : p.testCategories) || [];
  if (cats.length && (!l.category || !cats.map(String).includes(l.category))) return false;
  return true;
};

const PROMO_ERRORS = {
  notFound: "این کد تخفیف پیدا نشد",
  notStarted: "این کد تخفیف هنوز فعال نشده است",
  expired: "مهلت این کد تخفیف تمام شده است",
  full: "ظرفیت استفاده از این کد تخفیف تمام شده است",
  perUser: "سهم شما از استفاده‌ی این کد تخفیف تمام شده است",
  firstOnly: "این کد تخفیف فقط برای اولین سفارش است",
  notCovered: "این کد تخفیف شامل اقلام سبد خرید شما نمی‌شود",
  minOrder: "این کد تخفیف برای سفارش‌های از ${1} تومان به بالا است",
  better: "تخفیف بهتری روی این سفارش اعمال شده است",
  oneCode: "در هر سفارش فقط یک کد تخفیف پذیرفته می‌شود",
  oneClub: "برای هر مرکز فقط یک کد باشگاه پذیرفته می‌شود",
  clubElsewhere: "این کد باشگاه مال مرکزی است که در سبد خرید شما نیست",
};

const usesOf = (promotion: unknown, user: Id) =>
  LicensePromotionRedemption.countDocuments({ promotion, user });

// why a promotion can't be used on this cart now (null: it can)
const promotionProblem = async (
  p: OrderPromotion,
  lines: OfferLine[],
  user: Id,
  now: Date,
  firstOrder: () => Promise<boolean>,
): Promise<string | null> => {
  if (!p.isActive) return PROMO_ERRORS.notFound;
  if (new Date(p.startsAt) > now) return PROMO_ERRORS.notStarted;
  if (new Date(p.endsAt) <= now) return PROMO_ERRORS.expired;
  if (p.maxRedemptions && (p.redemptions || 0) >= p.maxRedemptions) return PROMO_ERRORS.full;
  const covered = lines.filter((l) => promotionCoversLine(p, l));
  if (!covered.length) return PROMO_ERRORS.notCovered;
  const eligible = covered.reduce((s, l) => s + l.lineTotal, 0);
  if (p.minOrder && eligible < p.minOrder)
    return PROMO_ERRORS.minOrder.replace("${1}", Math.round(p.minOrder).toLocaleString("fa-IR"));
  if (p.maxPerUser && (await usesOf(p._id, user)) >= p.maxPerUser) return PROMO_ERRORS.perUser;
  if (p.firstPurchaseOnly && !(await firstOrder())) return PROMO_ERRORS.firstOnly;
  return null;
};

// ------------------------------------------------------------ the quote

export const quoteCartOffers = async ({
  user,
  lines,
  codes: rawCodes = [],
  insurance,
  now = new Date(),
}: {
  user: { _id: Id; phone?: string };
  lines: OfferLine[];
  codes?: string[];
  insurance?: { insurance: string; plan?: string | null } | null;
  now?: Date;
}): Promise<CartOffersQuote> => {
  const codes = [...new Set(rawCodes.map(normalizeCode).filter(Boolean))].slice(0, 6);
  const results: CodeResult[] = [];
  const club = lines.map(() => 0);
  const clubs: AppliedClub[] = [];

  // the codes typed: a promotion's code, else a club code
  const promos = codes.length
    ? await LicensePromotion.find({ code: { $in: codes }, kinds: { $in: ["pharmacyOrder", "labOrder"] } }).lean<OrderPromotion[]>()
    : [];
  const promoByCode = new Map(promos.map((p) => [String(p.code), p]));
  let firstOrderCache: boolean | null = null;
  const firstOrder = async () => {
    if (firstOrderCache === null) firstOrderCache = !(await Order.exists({ user: user._id, status: "paid" }));
    return firstOrderCache;
  };
  let typedPromo: { code: string; p: OrderPromotion } | null = null;
  for (const code of codes) {
    const p = promoByCode.get(code);
    if (p) {
      if (typedPromo) {
        results.push({ code, kind: "promo", applied: false, error: PROMO_ERRORS.oneCode });
        continue;
      }
      const problem = await promotionProblem(p, lines, user._id, now, firstOrder);
      if (problem) results.push({ code, kind: "promo", applied: false, name: p.title, error: problem });
      else {
        typedPromo = { code, p };
        // decided below, against the automatic ones
        results.push({ code, kind: "promo", applied: true, name: p.title });
      }
      continue;
    }
    const r = await BizClubRedemption.findOne({ code, ownerKind: { $in: ["pharmacy", "paraClinic", "doctor"] } })
      .select("ownerKind ownerId")
      .lean<Pick<IBizClubRedemption, "ownerKind" | "ownerId">>();
    if (!r) {
      results.push({ code, kind: null, applied: false, error: PROMO_ERRORS.notFound });
      continue;
    }
    const ownerId = idOf(r.ownerId);
    const kind = r.ownerKind as OfferOwnerKind;
    const at = lines.map((l, i) => (l.ownerKind === kind && l.ownerId === ownerId ? i : -1)).filter((i) => i >= 0);
    if (!at.length) {
      results.push({ code, kind: "club", applied: false, error: PROMO_ERRORS.clubElsewhere });
      continue;
    }
    if (clubs.some((c) => c.ownerKind === kind && c.ownerId === ownerId)) {
      results.push({ code, kind: "club", applied: false, error: PROMO_ERRORS.oneClub });
      continue;
    }
    const found = await findClubCode(code, ownerId, user, kind);
    if (!found.redemption) {
      results.push({ code, kind: "club", applied: false, error: found.error || PROMO_ERRORS.notFound });
      continue;
    }
    const base = at.reduce((s, i) => s + lines[i].lineTotal, 0);
    const amount = rewardAmount(found.redemption as never, base);
    const parts = splitDiscount(at.map((i) => lines[i].lineTotal), amount);
    at.forEach((i, j) => (club[i] += parts[j]));
    const name = (found.redemption as { name?: string }).name;
    clubs.push({ ownerKind: kind, ownerId, redemption: idOf(found.redemption._id), code, name, amount, lines: at });
    results.push({ code, kind: "club", applied: true, name: name || lines[at[0]].ownerName });
  }

  // the promotion: the best of the automatic ones and the typed one
  const autos = await LicensePromotion.find({
    isActive: true,
    code: { $in: ["", null] },
    kinds: { $in: ["pharmacyOrder", "labOrder"] },
    startsAt: { $lte: now },
    endsAt: { $gt: now },
  }).lean<OrderPromotion[]>();
  const candidates: { p: OrderPromotion; code?: string }[] = [];
  for (const p of autos) if (!(await promotionProblem(p, lines, user._id, now, firstOrder))) candidates.push({ p });
  if (typedPromo) candidates.push({ p: typedPromo.p, code: typedPromo.code });
  // each candidate's discount on the covered lines after the club codes
  const worth = (p: OrderPromotion) =>
    promotionDiscountOf(
      p as never,
      lines.reduce((s, l, i) => s + (promotionCoversLine(p, l) ? Math.max(0, l.lineTotal - club[i]) : 0), 0),
    );
  let best: { p: OrderPromotion; code?: string; off: number } | null = null;
  for (const c of candidates) {
    const off = worth(c.p);
    if (off > 0 && (!best || off > best.off || (off === best.off && c.code))) best = { ...c, off };
  }
  if (typedPromo && best?.code !== typedPromo.code) {
    const r = results.find((x) => x.code === typedPromo!.code);
    if (r) Object.assign(r, { applied: false, error: worth(typedPromo.p) > 0 ? PROMO_ERRORS.better : PROMO_ERRORS.notCovered });
  }
  const covered = best ? lines.map((l) => promotionCoversLine(best!.p, l)) : lines.map(() => false);
  const fundedBy = best?.p.fundedBy === "seller" ? "seller" : "platform";

  // a seller-funded discount lowers the sale, like a club code
  const promo = lines.map(() => 0);
  if (best && fundedBy === "seller") {
    const idx = lines.map((_, i) => i).filter((i) => covered[i]);
    const room = idx.map((i) => Math.max(0, lines[i].lineTotal - club[i]));
    const off = promotionDiscountOf(best.p as never, room.reduce((s, x) => s + x, 0));
    splitDiscount(room, off).forEach((x, j) => (promo[idx[j]] = x));
  }
  const sale = lines.map((l, i) => Math.max(0, l.lineTotal - club[i] - promo[i]));
  const tax = lines.map((l, i) => calcTax(sale[i], l.taxPercent));

  // the insurer's share of the sale
  const ins = await quoteCartInsurance({
    userId: user._id,
    lines: lines.map((l, i) => ({
      target: l.ownerKind === "pharmacy" ? "drug" : l.ownerKind === "paraClinic" ? "lab" : null,
      ownerKind: l.ownerKind,
      ownerId: l.ownerId,
      category: l.category,
      rx: l.rx,
      base: sale[i],
    })),
    pick: insurance,
    at: now,
  });

  // a platform-funded discount is on what the buyer still pays
  if (best && fundedBy === "platform") {
    const idx = lines.map((_, i) => i).filter((i) => covered[i]);
    const room = idx.map((i) => Math.max(0, sale[i] - ins.shares[i]));
    const off = promotionDiscountOf(best.p as never, room.reduce((s, x) => s + x, 0));
    splitDiscount(room, off).forEach((x, j) => (promo[idx[j]] = x));
  }
  const promoTotal = promo.reduce((s, x) => s + x, 0);
  // a promotion that ended up taking nothing is not shown as applied
  const applied: AppliedPromo | null =
    best && promoTotal > 0
      ? {
          promotion: idOf(best.p._id),
          ...(best.code ? { code: best.code } : {}),
          title: best.p.title || "",
          fundedBy,
          amount: promoTotal,
          eligible: lines.reduce((s, l, i) => s + (covered[i] ? l.lineTotal : 0), 0),
          terms: {
            discountType: best.p.discountType === "amount" ? "amount" : "percent",
            value: Math.max(0, Number(best.p.value) || 0),
            maxDiscount: Math.max(0, Number(best.p.maxDiscount) || 0),
            minOrder: Math.max(0, Number(best.p.minOrder) || 0),
          },
          lines: lines.map((_, i) => i).filter((i) => covered[i]),
        }
      : null;
  const out = lines.map((l, i) => ({
    clubDiscount: club[i],
    promoDiscount: promo[i],
    insurerShare: ins.shares[i],
    insuranceStatus: ins.statuses[i],
    tax: tax[i],
    pay: Math.max(0, sale[i] - ins.shares[i] - (fundedBy === "platform" ? promo[i] : 0)) + tax[i],
  }));
  return {
    lines: out,
    promo: applied,
    clubs,
    codes: results,
    insurance: ins,
    clubDiscount: club.reduce((s, x) => s + x, 0),
    promoDiscount: promoTotal,
    insurerShare: ins.insurerShare,
    tax: tax.reduce((s, x) => s + x, 0),
  };
};

// ------------------------------------------------------------ the clubs

export type CheckoutClub = {
  ownerKind: OfferOwnerKind;
  ownerId: string;
  name: string;
  // the buyer's standing (null: not a member yet - they become one with
  // this order)
  member: { balance: number; tier: string; discount: number } | null;
  // the points this order would add (the club's own earning rule)
  earn: number;
  rewards: { _id: string; name: string; points: number; kind: string; value: number; maxDiscount: number; affordable: boolean }[];
  // the buyer's unused codes at this centre
  codes: { code: string; name: string; expiresAt?: Date }[];
};

// The clubs of the centres in the cart that run one, as the checkout shows
// them: the buyer's balance, tier, rewards they can take and the points
// this order earns (Digikala / Snapp Club show "you'll earn N points").
export const checkoutClubs = async (
  userId: Id,
  owners: { ownerKind: OfferOwnerKind; ownerId: string; pay: number }[],
): Promise<CheckoutClub[]> => {
  const out: CheckoutClub[] = [];
  for (const o of owners) {
    if (!partOn(o.ownerKind, "club") || !isValidObjectId(o.ownerId)) continue;
    const owner = { kind: o.ownerKind, id: o.ownerId } as BizOwner;
    if (!(await BizClubSettings.exists({ ownerKind: o.ownerKind, ownerId: o.ownerId, enabled: true }))) continue;
    const settings = await clubSettings(owner);
    // the buyer's purchases there become their membership (throttled)
    await syncContacts(owner).catch(() => undefined);
    await reconcileRedemptions(owner).catch(() => undefined);
    const contact = await BizContact.findOne({ ownerKind: o.ownerKind, ownerId: o.ownerId, user: userId, isActive: { $ne: false } })
      .select("phone spent visits orders name user")
      .lean<IBizContact>();
    const [row] = contact ? await memberRows(owner, [contact], settings) : [];
    const [rewards, codes, info] = await Promise.all([
      BizClubReward.find({ ownerKind: o.ownerKind, ownerId: o.ownerId, active: true })
        .sort({ points: 1 })
        .select("name points kind value maxDiscount")
        .limit(20)
        .lean<{ _id: unknown; name: string; points: number; kind: string; value: number; maxDiscount?: number }[]>(),
      contact
        ? BizClubRedemption.find({ ownerKind: o.ownerKind, ownerId: o.ownerId, contact: contact._id, status: "issued", expiresAt: { $gt: new Date() } })
            .sort({ createdAt: -1 })
            .limit(10)
            .select("code name expiresAt")
            .lean<{ code: string; name: string; expiresAt?: Date }[]>()
        : Promise.resolve([]),
      orgInfo(owner).catch(() => ({ name: "" })),
    ]);
    const balance = row?.balance || 0;
    out.push({
      ownerKind: o.ownerKind,
      ownerId: o.ownerId,
      name: info.name || "",
      member: row ? { balance, tier: row.tier, discount: row.discount } : null,
      earn: earnedOf(o.pay, o.pay > 0 ? 1 : 0, settings),
      rewards: rewards.map((r) => ({
        _id: idOf(r._id),
        name: r.name,
        points: r.points,
        kind: r.kind,
        value: r.value,
        maxDiscount: r.maxDiscount || 0,
        affordable: !!row && balance >= r.points,
      })),
      codes: codes.map((c) => ({ code: c.code, name: c.name, expiresAt: c.expiresAt })),
    });
  }
  return out;
};

// ------------------------------------------------------------ holds

// The order takes its promotion use and its club codes, before any money
// moves. All or nothing: a promotion that just ran out, or a code another
// checkout just used, undoes what was taken and refuses the order.
export const holdOrderOffers = async (
  orderId: Id,
  userId: Id,
  quote: Pick<CartOffersQuote, "promo" | "clubs">,
): Promise<{ error?: string }> => {
  const now = new Date();
  if (quote.promo) {
    const claimed = await LicensePromotion.findOneAndUpdate(
      {
        _id: quote.promo.promotion,
        isActive: true,
        startsAt: { $lte: now },
        endsAt: { $gt: now },
        $or: [{ maxRedemptions: 0 }, { $expr: { $lt: ["$redemptions", "$maxRedemptions"] } }],
      },
      { $inc: { redemptions: 1 } },
      { new: true },
    ).lean<OrderPromotion>();
    clearPromotionCache();
    if (!claimed) return { error: "مهلت یا ظرفیت این تخفیف تمام شده است؛ صفحه را دوباره باز کنید" };
    try {
      await LicensePromotionRedemption.create({
        promotion: claimed._id,
        kind: "order",
        owner: userId,
        user: userId,
        order: orderId,
        listPrice: quote.promo.eligible,
        discount: quote.promo.amount,
        paid: Math.max(0, quote.promo.eligible - quote.promo.amount),
      });
    } catch (err) {
      await LicensePromotion.updateOne({ _id: claimed._id, redemptions: { $gt: 0 } }, { $inc: { redemptions: -1 } });
      throw err;
    }
    // two checkouts at once may both have passed the per-buyer check: the
    // later one is taken back (the club's own guard)
    if (claimed.maxPerUser && (await usesOf(claimed._id, userId)) > claimed.maxPerUser) {
      await releaseOrderOffers(orderId);
      return { error: PROMO_ERRORS.perUser };
    }
  }
  for (const c of quote.clubs) {
    const done = await BizClubRedemption.updateOne(
      { _id: c.redemption, status: "issued", $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] },
      { $set: { status: "used", usedAt: now, order: orderId, discountAmount: c.amount } },
    );
    if (!done.modifiedCount) {
      await releaseOrderOffers(orderId);
      return { error: "این کد قبلاً استفاده یا لغو شده است" };
    }
  }
  return {};
};

// the holds are still the order's (the payment callback, before it
// settles a pending order)
export const offerHoldsValid = async (order: Pick<IOrder, "_id" | "promo" | "clubCodes">) => {
  if (order.promo?.promotion && !(await LicensePromotionRedemption.exists({ order: order._id, promotion: order.promo.promotion })))
    return false;
  for (const c of order.clubCodes || [])
    if (!(await BizClubRedemption.exists({ _id: c.redemption, order: order._id, status: "used" }))) return false;
  return true;
};

// the order's discount code use goes back (also a partial cancel that left
// no discount on the rest, Lib/orderPromoRecheck.ts); idempotent
export const releaseOrderPromo = async (orderId: Id) => {
  const r = await LicensePromotionRedemption.findOneAndDelete({ order: orderId }).lean<{ promotion?: unknown }>();
  if (r?.promotion) {
    await LicensePromotion.updateOne({ _id: r.promotion, redemptions: { $gt: 0 } }, { $inc: { redemptions: -1 } });
    clearPromotionCache();
  }
};

const releaseClub = (filter: Record<string, unknown>) =>
  BizClubRedemption.updateMany(
    { ...filter, status: "used" },
    { $set: { status: "issued", discountAmount: 0 }, $unset: { order: 1, usedAt: 1 } },
  );

// Everything the order held goes back (never paid, or cancelled in full).
// Idempotent: a use already given back is not given back twice.
export const releaseOrderOffers = async (orderId: Id) => {
  await releaseOrderPromo(orderId).catch((err) => console.log(`[cartOffers] releasing the promotion of ${orderId} failed:`, err));
  await releaseClub({ order: orderId }).catch((err) => console.log(`[cartOffers] releasing the club codes of ${orderId} failed:`, err));
};

const LINE_MODELS = ["products", "productPackages", "services", "servicePackages", "tests"] as const;

// After a line of a paid order was settled: a seller whose lines are all
// cancelled gets its club code back to the buyer, and an order cancelled
// in full gives its discount code use back.
export const releaseEndedOffers = async (orderId: Id) => {
  const order = await Order.findById(orderId).select(`${LINE_MODELS.join(" ")} promo clubCodes`).lean<IOrder>();
  if (!order) return;
  const lines = LINE_MODELS.flatMap((m) => ((order as unknown as Record<string, { _id: unknown; status: string }[]>)[m] || []));
  if (!lines.length) return;
  const statusOf = new Map(lines.map((l) => [idOf(l._id), l.status]));
  for (const c of (order.clubCodes || []) as (NonNullable<IOrder["clubCodes"]>[number] & { lines?: unknown[] })[]) {
    const own = (c.lines || []).map(idOf);
    if (own.length && own.every((id) => statusOf.get(id) === "cancelled"))
      await releaseClub({ _id: c.redemption, order: order._id });
  }
  if (order.promo && lines.every((l) => l.status === "cancelled")) await releaseOrderPromo(order._id);
};

