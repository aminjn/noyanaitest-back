import { IOrder } from "../Models/Order";

// The money of one cart order line after the checkout's discounts and
// insurance (2026-10, Lib/cartOffers.ts) - shared by the settlement
// (Services/orderSettlementService.ts), a partial cancel's discount
// re-check (Lib/orderPromoRecheck.ts) and the sellers' order screens
// (Lib/orderSellerMoney.ts), so the three never disagree by a toman.

export type OrderMoneyLine = {
  _id?: unknown;
  qty: number;
  price: number;
  tax?: number;
  status?: string;
  clubDiscount?: number;
  promoDiscount?: number;
  insurerShare?: number;
  promoClawback?: number;
};

export const money = (n: unknown) => Math.max(0, Math.round(Number(n) || 0));

// what the seller sold it for, what the buyer paid (before tax) and the
// platform's share of a discount code. Old lines carry none of the offer
// fields and come out as before.
export const lineMoney = (order: Pick<IOrder, "promo">, line: OrderMoneyLine) => {
  const lineTotal = Math.max(0, (line.price || 0) * (line.qty || 0));
  const club = Math.min(lineTotal, money(line.clubDiscount));
  const promo = money(line.promoDiscount);
  const sellerFunded = order.promo?.fundedBy === "seller";
  const sellerPromo = sellerFunded ? Math.min(lineTotal - club, promo) : 0;
  const sale = Math.max(0, lineTotal - club - sellerPromo);
  const insurer = Math.min(sale, money(line.insurerShare));
  const platformPromo = sellerFunded ? 0 : Math.min(sale - insurer, promo);
  return {
    lineTotal,
    club,
    sellerPromo,
    sale,
    insurer,
    platformPromo,
    // what Noyan holds for the seller from the buyer (the insurer pays the
    // rest straight to the seller)
    gross: Math.max(0, sale - insurer),
    // what the buyer paid for the line, tax left out
    paid: Math.max(0, sale - insurer - platformPromo),
  };
};

// The line's VAT the buyer paid (snapshotted per line since 2026-09 - each
// seller has its own rate); older orders fall back to a proportional share
// of the order's tax. Never more than the order's tax.
export const lineTaxShare = (order: Pick<IOrder, "tax" | "subtotal">, line: OrderMoneyLine) => {
  const lineTotal = Math.max(0, (line.price || 0) * (line.qty || 0));
  return Math.min(
    Math.max(0, order.tax || 0),
    typeof line.tax === "number"
      ? Math.max(0, line.tax)
      : order.subtotal > 0 && order.tax > 0
        ? Math.round((order.tax * lineTotal) / order.subtotal)
        : 0,
  );
};

// What a cancelled line gives back to the buyer: what they paid for it and
// its VAT, less the discount a partial cancel took back from the rest of
// the order (Lib/orderPromoRecheck.ts). Never negative.
export const lineRefund = (order: Pick<IOrder, "promo" | "tax" | "subtotal">, line: OrderMoneyLine) =>
  Math.max(0, lineMoney(order, line).paid + lineTaxShare(order, line) - money(line.promoClawback));

// (2026-10, Services/orderReturnService.ts) What is left of a delivered
// line once some of its units were returned and refunded: the units still
// with the buyer and their part of the line's discounts, insurer share and
// VAT (the line keeps its own figures; the returned units' share is summed
// on line.returned). A line with no return comes back as it is.
export type ReturnedSums = { qty?: number; lineTotal?: number; club?: number; promo?: number; insurer?: number; tax?: number; paid?: number };

export const keptLine = <T extends OrderMoneyLine & { returned?: ReturnedSums | null }>(line: T): T => {
  const r = line.returned;
  if (!r || !(Number(r.qty) > 0)) return line;
  return {
    ...line,
    qty: Math.max(0, (Number(line.qty) || 0) - money(r.qty)),
    clubDiscount: Math.max(0, money(line.clubDiscount) - money(r.club)),
    promoDiscount: Math.max(0, money(line.promoDiscount) - money(r.promo)),
    insurerShare: Math.max(0, money(line.insurerShare) - money(r.insurer)),
    ...(typeof line.tax === "number" ? { tax: Math.max(0, line.tax - money(r.tax)) } : {}),
  };
};
