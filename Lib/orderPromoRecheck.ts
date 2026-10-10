import mongoose from "mongoose";
import Order, { IOrder, OrderPromoRecheckReason } from "../Models/Order";
import LicensePromotion, { LicensePromotionRedemption } from "../Models/LicensePromotion";
import { calcTax } from "./taxSettings";
import { lineMoney, lineTaxShare, money, OrderMoneyLine } from "./orderLineMoney";
import { releaseOrderPromo } from "./cartOffers";

// A partial cancel re-checks the order's discount code (2026-10, the
// Digikala / Snapp Pharmacy / Halodoc rule). When a line of a paid order
// is cancelled and what is left is under the code's minimum order, the
// discount on the remaining lines no longer applies and is kept back from the
// cancelled line's refund: the buyer gets what they paid for the line (its
// VAT included) less that discount - never negative; what the refund cannot
// cover stays a discount. A cancelled line that was the only one the code
// covered leaves no discount on the rest: nothing is kept back and the code
// use goes back. An order cancelled in full keeps nothing back (its code use is
// given back, Lib/cartOffers.ts releaseEndedOffers), and a rest left with no
// discount at all gives the code use back too.
//
// Only lines still pending are re-priced: a fulfilled line was already
// settled with its discount (the seller paid, the platform's subsidy
// booked), so its price is final.
//
// The ledger stays balanced to the toman, for both kinds of code:
//   platform-funded  the remaining line's promoDiscount drops by r: the
//                    buyer has paid r more for it, the platform's subsidy
//                    on it (Transaction.platformSubsidy, marketing) is r
//                    smaller, the seller's earning is unchanged; the refund
//                    is r smaller.
//   seller-funded    the remaining line's sale rises by r and its VAT with
//                    it (its rate snapshotted on order.promo.lines): the
//                    seller earns on the higher sale; the refund is r + the
//                    extra VAT smaller.
// Either way the buyer's prepayment (unearned) covers exactly the refunds
// plus what the remaining lines settle.
//
// Exactly once per cancelled line: its promoClawback is set (0 when nothing
// is kept back) by one update conditional on it being unset and on every
// remaining covered line still having the status and discount the plan was
// made from - a seller acting on another line at the same moment makes the
// update miss, and the plan is made again from the fresh order.

export const ORDER_LINE_MODELS = ["products", "productPackages", "services", "servicePackages", "tests"] as const;
export type OrderLineModelName = (typeof ORDER_LINE_MODELS)[number];

type Terms = { discountType: "percent" | "amount"; value: number; maxDiscount: number; minOrder: number };

type Line = OrderMoneyLine & { _id: unknown; status: string; promoReduced?: number };

type RecheckOrder = Pick<IOrder, "promo" | "tax" | "subtotal"> & { _id?: unknown } & Partial<Record<OrderLineModelName, Line[]>>;

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

export type PromoRecheckChange = {
  model: OrderLineModelName;
  lineId: string;
  promoDiscount: number;
  tax: number;
  promoReduced: number;
  // the discount taken off this line now
  reducedBy: number;
};

export type PromoRecheckPlan = {
  // kept back from the cancelled line's refund
  clawback: number;
  // the discount taken off the remaining lines (clawback - extraTax)
  reduced: number;
  // a seller-funded code's extra VAT on the remaining lines' higher sale
  extraTax: number;
  reason: OrderPromoRecheckReason | null;
  changes: PromoRecheckChange[];
  // the discount left on the lines not cancelled
  remainingPromo: number;
  // lines not cancelled
  remainingLines: number;
};

const EMPTY: PromoRecheckPlan = {
  clawback: 0,
  reduced: 0,
  extraTax: 0,
  reason: null,
  changes: [],
  remainingPromo: 0,
  remainingLines: 0,
};

// the code's terms at checkout; an order from before the snapshot reads
// the promotion itself (null: it is gone - nothing is re-checked)
export const promoTermsOf = async (order: Pick<IOrder, "promo">): Promise<Terms | null> => {
  const p = order.promo;
  if (!p?.promotion) return null;
  if (p.terms?.discountType) return p.terms as Terms;
  const doc = await LicensePromotion.findById(p.promotion)
    .select("discountType value maxDiscount minOrder")
    .lean<{ discountType?: string; value?: number; maxDiscount?: number; minOrder?: number }>();
  if (!doc) return null;
  return {
    discountType: doc.discountType === "amount" ? "amount" : "percent",
    value: Math.max(0, Number(doc.value) || 0),
    maxDiscount: Math.max(0, Number(doc.maxDiscount) || 0),
    minOrder: Math.max(0, Number(doc.minOrder) || 0),
  };
};

const allLines = (order: RecheckOrder) =>
  ORDER_LINE_MODELS.flatMap((model) =>
    (Array.isArray(order[model]) ? (order[model] as Line[]) : []).filter((l) => !!l?._id).map((line) => ({ model, line })),
  );

// The lines the code covers and their VAT rate. An order from before the
// snapshot: the lines that carry a share of the discount, their rate read
// back from their own VAT.
const coveredOf = (order: RecheckOrder) => {
  const out = new Map<string, number>();
  const snap = order.promo?.lines;
  if (Array.isArray(snap) && snap.length) {
    for (const l of snap) if (l?.line) out.set(idOf(l.line), Math.max(0, Number(l.taxPercent) || 0));
    return out;
  }
  for (const { line } of allLines(order))
    if (money(line.promoDiscount) > 0) {
      const sale = lineMoney(order, line).sale;
      out.set(idOf(line._id), sale > 0 && typeof line.tax === "number" ? Math.round((line.tax / sale) * 10000) / 100 : 0);
    }
  return out;
};

// The re-check of one cancelled line, on a plain order (also the cancel
// confirmation's preview, on a copy with the lines it would cancel set
// "cancelled"). Pure: it changes nothing.
export const planPromoRecheck = (order: RecheckOrder, cancelledLineId: string, terms: Terms | null): PromoRecheckPlan => {
  if (!order.promo || !terms) return EMPTY;
  const lines = allLines(order);
  const cancelled = lines.find((x) => idOf(x.line._id) === cancelledLineId);
  if (!cancelled || cancelled.line.status !== "cancelled") return EMPTY;
  const sellerFunded = order.promo.fundedBy === "seller";
  const covered = coveredOf(order);
  const remaining = lines.filter((x) => x.line.status !== "cancelled");
  const rest = remaining.filter((x) => covered.has(idOf(x.line._id)));
  const base: PromoRecheckPlan = {
    ...EMPTY,
    remainingLines: remaining.length,
    remainingPromo: remaining.reduce((s, x) => s + money(x.line.promoDiscount), 0),
  };
  const restPromo = rest.reduce((s, x) => s + money(x.line.promoDiscount), 0);
  if (restPromo <= 0) return base;

  // The rest under the code's minimum (on the covered items' list price, as
  // at checkout - Lib/cartOffers.ts) earns nothing (the Digikala / Snapp
  // rule). Over it, the rest keeps its discount as it is: a percent code
  // gives it the same share it already has (re-pricing would only move a
  // toman of rounding), a capped one at least as much, a fixed amount more.
  // (No covered line left: no discount is left on the rest to take back -
  // the code use itself goes back, recheckPromoOnCancel.)
  const eligible = rest.reduce((s, x) => s + lineMoney(order, x.line).lineTotal, 0);
  if (!(terms.minOrder > 0 && eligible < terms.minOrder)) return base;
  const reason: OrderPromoRecheckReason = "minOrder";
  const lost = restPromo;
  const pending = rest.filter((x) => x.line.status === "pending" && money(x.line.promoDiscount) > 0);
  const pendingPromo = pending.reduce((s, x) => s + money(x.line.promoDiscount), 0);
  // what the cancelled line gives back at most
  const refundable = Math.max(
    0,
    lineMoney(order, cancelled.line).paid + lineTaxShare(order, cancelled.line) - money(cancelled.line.promoClawback),
  );

  // the remaining lines with r of their discount taken off, in proportion
  // to what each has (none gains)
  const priced = (r: number) => {
    const cuts = splitByWeight(pending.map((x) => money(x.line.promoDiscount)), r);
    let claw = 0;
    let extraTax = 0;
    const changes: PromoRecheckChange[] = [];
    pending.forEach((x, i) => {
      const cut = cuts[i];
      if (cut <= 0) return;
      const before = lineMoney(order, x.line);
      const promoDiscount = money(x.line.promoDiscount) - cut;
      const after = lineMoney(order, { ...x.line, promoDiscount });
      const oldTax = Math.max(0, Number(x.line.tax) || 0);
      let tax = oldTax;
      if (sellerFunded) {
        const pct = covered.get(idOf(x.line._id)) || 0;
        tax = Math.max(0, oldTax + calcTax(after.sale, pct) - calcTax(before.sale, pct));
      }
      extraTax += tax - oldTax;
      claw += after.paid + tax - (before.paid + oldTax);
      changes.push({
        model: x.model,
        lineId: idOf(x.line._id),
        promoDiscount,
        tax,
        promoReduced: money(x.line.promoReduced) + cut,
        reducedBy: cut,
      });
    });
    return { claw, extraTax, changes };
  };
  let r = Math.min(lost, pendingPromo);
  let p = priced(r);
  for (let i = 0; i < 40 && r > 0 && p.claw > refundable; i++) {
    r = Math.max(0, r - Math.max(1, p.claw - refundable));
    p = priced(r);
  }
  if (r <= 0 || p.claw <= 0 || p.claw > refundable) return base;
  return {
    clawback: p.claw,
    reduced: r,
    extraTax: p.extraTax,
    reason,
    changes: p.changes,
    remainingPromo: base.remainingPromo - r,
    remainingLines: remaining.length,
  };
};

// amount split over the weights, never more than a weight (largest
// remainders get the leftover tomans)
const splitByWeight = (weights: number[], amount: number) => {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  const want = Math.min(Math.max(0, Math.round(amount)), total);
  if (!total || !want) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((Math.max(0, w) * want) / total));
  let left = want - parts.reduce((s, x) => s + x, 0);
  const order = weights.map((w, i) => [w, i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    const extra = Math.min(left, Math.max(0, weights[i]) - parts[i]);
    parts[i] += extra;
    left -= extra;
  }
  return parts;
};

const oid = (id: string) => new mongoose.Types.ObjectId(id);

// The re-check of a line just cancelled, written to the order (the caller
// is the settlement, right before the refund). Idempotent; best effort -
// a failure leaves the line unchecked and its refund in full.
export const recheckPromoOnCancel = async (orderId: unknown, model: OrderLineModelName, lineId: string): Promise<PromoRecheckPlan | null> => {
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const order = await Order.findById(orderId).lean<RecheckOrder & { _id: unknown }>();
      if (!order?.promo) return null;
      const line = ((order[model] || []) as Line[]).find((l) => idOf(l._id) === lineId);
      if (!line || line.status !== "cancelled" || typeof line.promoClawback === "number") return null;
      const plan = planPromoRecheck(order, lineId, await promoTermsOf(order));

      // the plan holds while every remaining covered line is as it was read
      const covered = coveredOf(order);
      const guards = new Map<string, Record<string, unknown>[]>();
      for (const x of allLines(order)) {
        if (x.line.status === "cancelled" || !covered.has(idOf(x.line._id))) continue;
        const promo = money(x.line.promoDiscount);
        const g = { _id: x.line._id, status: x.line.status, promoDiscount: promo > 0 ? promo : { $in: [null, 0] } };
        guards.set(x.model, [...(guards.get(x.model) || []), { $elemMatch: g }]);
      }
      const filter: Record<string, unknown> = { _id: order._id };
      const self = { $elemMatch: { _id: oid(lineId), status: "cancelled", promoClawback: { $exists: false } } };
      for (const m of ORDER_LINE_MODELS) {
        const all = guards.get(m) || [];
        if (m === model) filter[m] = all.length ? { ...self, $all: all } : self;
        else if (all.length) filter[m] = { $all: all };
      }
      const set: Record<string, unknown> = { [`${model}.$[x].promoClawback`]: plan.clawback };
      if (plan.clawback > 0 && plan.reason) set[`${model}.$[x].promoClawbackReason`] = plan.reason;
      const arrayFilters: Record<string, unknown>[] = [{ "x._id": oid(lineId) }];
      plan.changes.forEach((c, i) => {
        set[`${c.model}.$[c${i}].promoDiscount`] = c.promoDiscount;
        set[`${c.model}.$[c${i}].tax`] = c.tax;
        set[`${c.model}.$[c${i}].promoReduced`] = c.promoReduced;
        arrayFilters.push({ [`c${i}._id`]: oid(c.lineId) });
      });
      const done = await Order.updateOne(
        filter,
        { $set: set, ...(plan.reduced > 0 ? { $inc: { promoDiscount: -plan.reduced, "promo.amount": -plan.reduced } } : {}) },
        { arrayFilters },
      );
      if (!done.modifiedCount) continue;
      // the code use's own record follows what the order got
      if (plan.reduced > 0)
        await LicensePromotionRedemption.updateOne(
          { order: order._id },
          [
            {
              $set: {
                discount: { $max: [0, { $subtract: [{ $ifNull: ["$discount", 0] }, plan.reduced] }] },
                paid: { $add: [{ $ifNull: ["$paid", 0] }, plan.reduced] },
              },
            },
          ],
        ).catch(() => undefined);
      // nothing of the discount is left on what the buyer keeps: the code
      // use goes back (an order cancelled in full: releaseEndedOffers)
      if (plan.remainingLines > 0 && plan.remainingPromo <= 0) await releaseOrderPromo(order._id as never);
      return plan;
    }
    console.log(`[orders] discount re-check of ${String(orderId)}/${lineId}: the order kept changing, left unchecked`);
    return null;
  } catch (err) {
    console.log(`[orders] discount re-check of ${String(orderId)}/${lineId} failed:`, err);
    return null;
  }
};

// The cancel confirmation's figures (userController.cancelMyOrder's
// preview): cancelling `lineIds` together - the same order the cancel
// settles them in - what comes back and what of the discount is kept back.
export const previewCancelRefund = async (order: RecheckOrder, lineIds: string[]) => {
  const copy = JSON.parse(JSON.stringify(order)) as RecheckOrder;
  const want = new Set(lineIds);
  for (const { line } of allLines(copy)) if (want.has(idOf(line._id))) line.status = "cancelled";
  const terms = order.promo ? await promoTermsOf(order) : null;
  let refund = 0;
  let clawback = 0;
  let reason: OrderPromoRecheckReason | null = null;
  for (const id of lineIds) {
    const x = allLines(copy).find((l) => idOf(l.line._id) === id);
    if (!x) continue;
    const plan = planPromoRecheck(copy, id, terms);
    for (const c of plan.changes) {
      const l = allLines(copy).find((y) => idOf(y.line._id) === c.lineId)?.line;
      if (l) Object.assign(l, { promoDiscount: c.promoDiscount, tax: c.tax, promoReduced: c.promoReduced });
    }
    x.line.promoClawback = plan.clawback;
    if (plan.clawback > 0) {
      clawback += plan.clawback;
      reason = reason || plan.reason;
    }
    refund += Math.max(0, lineMoney(copy, x.line).paid + lineTaxShare(copy, x.line) - plan.clawback);
  }
  return { refund, clawback, reason, lines: lineIds.length };
};
