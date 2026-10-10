import { IOrder } from "../Models/Order";
import Transaction from "../Models/Transaction";
import BizClaim from "../Models/BizClaim";
import { CommissionKind, getCommissionPercent, splitCommission } from "./commission";
import { lineMoney, lineRefund, money, OrderMoneyLine } from "./orderLineMoney";

// A seller's own view of the money on its order lines (2026-10): per line
// and as totals, the sale price, its club discount, the discount code it
// funds (a NoyanAI-funded one shown apart: it never lowers the seller's
// income), the supplementary insurer's share and where its claim stands,
// what the buyer paid, the platform's commission and the seller's payout.
// Read from what the order and the settlement stored: a settled line from
// its earning row (Transaction), an open one estimated with today's
// commission rate. Only the lines handed in (the caller's own, already
// scoped) are read - never another seller's.

export type SellerKind = "pharmacy" | "paraClinic";

export type SellerClaimStatus = "candidate" | "inClaim" | "paid" | "rejected" | "reimburse";

export type SellerLineMoney = {
  line: string;
  status: string;
  // price * qty
  listPrice: number;
  clubDiscount: number;
  // the discount code's share on this line, by who funds it
  sellerPromo: number;
  platformPromo: number;
  // taken off this line's code discount by a partial cancel's re-check
  // (Lib/orderPromoRecheck.ts)
  promoReduced: number;
  // listPrice - club - seller-funded code
  sale: number;
  tax: number;
  insurerShare: number;
  claim: SellerClaimStatus | null;
  // what the buyer paid for the line, VAT included
  buyerPaid: number;
  // a cancelled line: what went back to the buyer
  refunded: number;
  commission: number;
  commissionPercent: number;
  // what reaches the seller's Noyan wallet for it (net of commission, its
  // VAT included - the seller is the seller of record); 0 for a cancelled
  // line. The insurer's share comes separately, through its claim.
  payout: number;
  // the payout is still waiting for its settlement hold
  held: boolean;
  // not settled yet: commission and payout are today's estimate
  estimated: boolean;
};

export type SellerOrderMoney = {
  lines: SellerLineMoney[];
  totals: Omit<SellerLineMoney, "line" | "status" | "claim" | "commissionPercent" | "held" | "estimated"> & {
    // what the insurer owes the seller on these lines (its claims)
    insurerReceivable: number;
  };
  promo: { title: string; code?: string; fundedBy: "platform" | "seller" } | null;
  insurer: string | null;
};

type Line = OrderMoneyLine & {
  _id: unknown;
  status: string;
  insuranceStatus?: string;
  insuranceClaim?: unknown;
  promoReduced?: number;
};

type ScopedOrder = Pick<IOrder, "promo" | "tax" | "subtotal" | "insurance"> & { _id: unknown };

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

const SUM_KEYS = [
  "listPrice",
  "clubDiscount",
  "sellerPromo",
  "platformPromo",
  "promoReduced",
  "sale",
  "tax",
  "insurerShare",
  "buyerPaid",
  "refunded",
  "commission",
  "payout",
] as const;

// The money of several orders at once (a list), each on its own lines.
export const sellerOrdersMoney = async (
  seller: { kind: SellerKind; id: unknown },
  orders: { order: ScopedOrder; lines: Line[] }[],
): Promise<SellerOrderMoney[]> => {
  const lineIds = orders.flatMap((o) => o.lines.map((l) => l._id)).filter(Boolean);
  const field = seller.kind === "pharmacy" ? "pharmacy" : "paraClinic";
  const [earnings, claims, percent] = await Promise.all([
    lineIds.length
      ? Transaction.find({
          orderItem: { $in: lineIds },
          amount: { $gt: 0 },
          grossAmount: { $exists: true },
          [field]: seller.id,
        })
          .select("order orderItem amount commission commissionPercent held availableAt releasedAt")
          .lean<{ order?: unknown; orderItem?: unknown; amount: number; commission?: number; commissionPercent?: number; held?: boolean }[]>()
      : Promise.resolve([]),
    (() => {
      const ids = orders.flatMap((o) => o.lines.map((l) => l.insuranceClaim).filter(Boolean));
      return ids.length
        ? BizClaim.find({ _id: { $in: ids } })
            .select("status review.status")
            .lean<{ _id: unknown; status?: string; review?: { status?: string } }[]>()
        : Promise.resolve([]);
    })(),
    getCommissionPercent((seller.kind === "pharmacy" ? "pharmacy" : "paraClinic") as CommissionKind, seller.id),
  ]);
  const earningOf = new Map(earnings.map((t) => [`${idOf(t.order)}:${idOf(t.orderItem)}`, t]));
  const claimOf = new Map(claims.map((c) => [idOf(c._id), c]));

  return orders.map(({ order, lines }) => {
    const rows: SellerLineMoney[] = lines.map((line) => {
      const m = lineMoney(order, line);
      const tax = Math.max(0, Number(line.tax) || 0);
      const cancelled = line.status === "cancelled";
      const earning = earningOf.get(`${idOf(order._id)}:${idOf(line._id)}`);
      let commission = 0;
      let commissionPercent = percent;
      let payout = 0;
      let estimated = false;
      if (earning) {
        commission = money(earning.commission);
        commissionPercent = Number(earning.commissionPercent) || 0;
        payout = money(earning.amount);
      } else if (!cancelled) {
        const split = splitCommission(m.gross, percent);
        commission = split.commission;
        payout = split.net + tax;
        estimated = true;
      }
      let claim: SellerClaimStatus | null = null;
      if (line.insuranceStatus === "reimburse") claim = "reimburse";
      else if (m.insurer > 0 && !cancelled && (line.insuranceStatus === "pending" || line.insuranceStatus === "booked")) {
        const c = line.insuranceClaim ? claimOf.get(idOf(line.insuranceClaim)) : null;
        claim = !c
          ? "candidate"
          : c.status === "paid" || c.review?.status === "paid"
            ? "paid"
            : c.status === "rejected"
              ? "rejected"
              : "inClaim";
      }
      return {
        line: idOf(line._id),
        status: line.status,
        listPrice: m.lineTotal,
        clubDiscount: m.club,
        sellerPromo: m.sellerPromo,
        platformPromo: m.platformPromo,
        promoReduced: money(line.promoReduced),
        sale: m.sale,
        tax,
        insurerShare: m.insurer,
        claim,
        buyerPaid: m.paid + tax,
        refunded: cancelled ? lineRefund(order, line) : 0,
        commission: cancelled ? 0 : commission,
        commissionPercent,
        payout: cancelled ? 0 : payout,
        held: !!earning?.held,
        estimated,
      };
    });
    const totals = Object.fromEntries(SUM_KEYS.map((k) => [k, 0])) as Record<(typeof SUM_KEYS)[number], number>;
    for (const r of rows) {
      // a cancelled line counts only for what went back to the buyer
      if (r.status === "cancelled") {
        totals.refunded += r.refunded;
        continue;
      }
      for (const k of SUM_KEYS) totals[k] += r[k];
    }
    const insurerReceivable = rows.reduce(
      (s, r) => s + (r.status !== "cancelled" && r.claim && r.claim !== "reimburse" && r.claim !== "paid" ? r.insurerShare : 0),
      0,
    );
    const p = order.promo;
    return {
      lines: rows,
      totals: { ...totals, insurerReceivable },
      promo:
        p && rows.some((r) => r.sellerPromo > 0 || r.platformPromo > 0 || r.promoReduced > 0)
          ? { title: p.title || "", ...(p.code ? { code: p.code } : {}), fundedBy: p.fundedBy === "seller" ? "seller" : "platform" }
          : null,
      insurer: rows.some((r) => r.insurerShare > 0 || r.claim === "reimburse") ? order.insurance?.name || null : null,
    };
  });
};

export const sellerOrderMoney = async (seller: { kind: SellerKind; id: unknown }, order: ScopedOrder, lines: Line[]) =>
  (await sellerOrdersMoney(seller, [{ order, lines }]))[0];
