import mongoose from "mongoose";
import Order from "../Models/Order";
import Transaction, { ITransaction } from "../Models/Transaction";
import { splitCommission } from "./commission";
import { creditEarning } from "./payoutHold";
import { lineMoney, money, OrderMoneyLine } from "./orderLineMoney";

// The settlement of a line already paid out, adjusted after a partial
// cancel took the order's discount code back from it (2026-10 owner
// decision, Digikala's returns; Lib/orderPromoRecheck.ts re-prices every
// line the buyer keeps, a fulfilled one too). What the line's earning row
// (Transaction, Services/orderSettlementService.ts) was settled with is
// compared with what the line says now, and the difference is posted as
// one adjustment row (Models/Transaction.ts promoAdjust):
//
//   seller-funded code    the line's sale rose by the discount taken back
//                         and its VAT with it: the seller earns the extra
//                         sale less the commission (at the earning's own
//                         rate) plus the extra VAT. It is credited like any
//                         earning (Lib/payoutHold.ts): with the line's own
//                         earning when that is still in its hold, else on a
//                         hold of its own - so a seller already paid out
//                         gets it with its next settlement.
//   platform-funded code  the seller's earning does not change; the
//                         platform's marketing subsidy on the line is that
//                         much smaller (a zero-amount row on the buyer).
//
// Booked by Lib/business/ledgerPoster.ts. The buyer's prepayment covers it
// to the toman: the cancelled line's refund was smaller by exactly what
// the kept lines now cost more.
//
// Idempotent and convergent: the difference is read again each time, so a
// retry, the settlement retry sweep or two settlements at once post it once
// (promoAdjustKey "<line>:<n>" is unique; the loser reads again and finds
// nothing left to post). A line whose earning was written after the
// re-price already carries the new figures and gets no adjustment.

type Line = OrderMoneyLine & { _id: mongoose.Types.ObjectId; status: string; promoReduced?: number };

const LINE_MODELS = ["products", "productPackages", "services", "servicePackages", "tests"] as const;
const ORG_FIELDS = ["pharmacy", "paraClinic", "doctor", "clinic", "hospital"] as const;

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

export type PromoAdjustRow = Pick<
  ITransaction,
  "_id" | "amount" | "grossAmount" | "commission" | "tax" | "subsidyBack" | "held" | "availableAt" | "promoAdjust" | "pharmacy" | "paraClinic"
>;

// the line's own earning row (the seller's, not a refund to the buyer)
const earningOf = (orderId: unknown, lineId: unknown, buyer: unknown) =>
  Transaction.findOne({
    order: orderId,
    orderItem: lineId,
    amount: { $gt: 0 },
    grossAmount: { $exists: true },
    user: { $ne: buyer },
  }).lean<ITransaction>();

export const promoAdjustmentsOf = (lineIds: unknown[]) =>
  lineIds.length
    ? Transaction.find({ "promoAdjust.orderItem": { $in: lineIds } })
        .select("amount grossAmount commission tax subsidyBack held availableAt promoAdjust pharmacy paraClinic doctor clinic hospital")
        .lean<PromoAdjustRow[]>()
    : Promise.resolve([] as PromoAdjustRow[]);

const sum = (rows: PromoAdjustRow[], k: "amount" | "grossAmount" | "commission" | "tax" | "subsidyBack") =>
  rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);

// Posts what each settled line of the order still lacks (only: one line).
// Throws on a failed write - the caller's settlement is then retried.
export const settlePromoAdjustments = async (
  orderId: unknown,
  opts: { line?: string; cause?: string } = {},
): Promise<number> => {
  let posted = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const order = await Order.findById(orderId).select(`user promo ${LINE_MODELS.join(" ")}`).lean<Record<string, any>>();
    if (!order?.promo) return posted;
    const lines = LINE_MODELS.flatMap((m) => ((Array.isArray(order[m]) ? order[m] : []) as Line[]).filter((l) => !!l?._id))
      .filter((l) => l.status === "fulfilled" && money(l.promoReduced) > 0)
      .filter((l) => !opts.line || idOf(l._id) === opts.line);
    let retry = false;
    for (const line of lines) {
      const earning = await earningOf(order._id, line._id, order.user);
      // not settled yet (its earning will carry the new figures), or from
      // before the seller was the seller of record
      if (!earning || typeof earning.tax !== "number") continue;
      const adjs = await promoAdjustmentsOf([line._id]);
      const pct = Number(earning.commissionPercent) || 0;
      const m = lineMoney(order as never, line);
      const commission = splitCommission(m.gross, pct).commission;
      const tax = typeof line.tax === "number" ? Math.max(0, line.tax) : 0;
      const dGross = m.gross - (money(earning.grossAmount) + sum(adjs, "grossAmount"));
      const dComm = commission - (money(earning.commission) + sum(adjs, "commission"));
      const dTax = tax - (Math.max(0, earning.tax) + sum(adjs, "tax"));
      const dSub = money(earning.platformSubsidy) - sum(adjs, "subsidyBack") - m.platformPromo;
      if (!dGross && !dComm && !dTax && !dSub) continue;
      // the re-check only ever takes a discount back: anything else is not
      // ours to settle here
      if (dGross < 0 || dComm < 0 || dTax < 0 || dSub < 0) {
        console.log(`[orders] discount adjustment of ${idOf(order._id)}/${idOf(line._id)} skipped: unexpected difference`, {
          dGross,
          dComm,
          dTax,
          dSub,
        });
        continue;
      }
      const amount = dGross - dComm + dTax;
      const fields: Record<string, unknown> = {
        order: order._id,
        promoAdjust: { orderItem: line._id, ...(opts.cause && mongoose.isValidObjectId(opts.cause) ? { cancelledItem: opts.cause } : {}) },
        promoAdjustKey: `${idOf(line._id)}:${adjs.length}`,
        grossAmount: dGross,
        commission: dComm,
        commissionPercent: pct,
        tax: dTax,
        ...(dSub > 0 ? { subsidyBack: dSub } : {}),
      };
      try {
        if (amount > 0) {
          for (const f of ORG_FIELDS) if (earning[f]) fields[f] = idOf(earning[f]);
          await creditEarning(idOf(earning.user), amount, fields as never, {
            releaseWith: earning.held ? earning.availableAt : null,
          });
        } else await Transaction.create({ ...fields, user: idOf(order.user), amount: 0 });
        posted++;
      } catch (err) {
        // another settlement posted it at the same moment: read again
        if ((err as { code?: number })?.code === 11000) {
          retry = true;
          break;
        }
        throw err;
      }
    }
    if (!retry) return posted;
  }
  return posted;
};
