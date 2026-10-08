import mongoose from "mongoose";
import PendingSettlement, { IPendingSettlement, PendingSettlementKind } from "../Models/PendingSettlement";
import { notifyUserAlertSubscribers } from "./userAlertService";

// Durable settlement retry (2026-10). A settlement runs right after the
// state change it follows - a seller fulfils or cancels a line, support
// does, a sweep cancels one, a Tipax parcel is confirmed delivered - and the
// state change is already saved when it runs. If the money step then fails
// it used to be only logged, leaving a fulfilled line unpaid or a cancelled
// one unrefunded for good. Now the failure is recorded (Models/
// PendingSettlement.ts) and a sweep retries it with backoff:
//
//   attempt n failed -> next try after BASE_DELAY * 2^(n-1), at most MAX_DELAY
//   ALERT_AFTER failures -> the admins subscribed to «تسویه‌ی ناموفق سفارش»
//                           (Models/UserAlert.ts settlementFailed) are told,
//                           once; the retries go on
//
// The settlement itself is idempotent (one Transaction per line / shipment,
// Services/orderSettlementService.ts), so a retry that races a late first
// attempt, or the seller acting again, never moves money twice. Stripe and
// Adyen run their payouts the same way: a ledger entry per payout and an
// outbox retried until it lands, with an operator alert when it does not.

const BASE_DELAY_MS = 5 * 60 * 1000;
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;
// a claimed record is leased for this long, so two sweeps never retry it
// at the same moment and a crashed run frees it again
const LEASE_MS = 10 * 60 * 1000;
export const ALERT_AFTER = 5;
const BATCH = 50;

const idOf = (value: unknown) =>
  value ? String((value as { _id?: unknown })?._id ?? value) : "";

const errText = (err: unknown) =>
  String((err as Error)?.stack || (err as Error)?.message || err || "").slice(0, 1000);

export const backoffMs = (attempts: number) =>
  Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));

export type PendingSettlementInput = {
  kind: PendingSettlementKind;
  order: unknown;
  model?: string;
  itemId?: string;
  shipment?: unknown;
  sellerUser?: unknown;
  org?: Record<string, unknown>;
  autoCancel?: string;
  onDelivery?: boolean;
  deliveredBy?: string;
};

const keyOf = (input: PendingSettlementInput) => ({
  kind: input.kind,
  order: idOf(input.order),
  model: input.model ?? null,
  itemId: input.itemId ?? null,
  shipment: input.shipment ? idOf(input.shipment) : null,
});

// Records (or bumps) a failed settlement. Never throws: it is called from
// a catch, after the state change was saved.
export const recordPendingSettlement = async (input: PendingSettlementInput, err: unknown): Promise<void> => {
  console.log(`[settlement] ${input.kind} of order ${idOf(input.order)} failed, queued for retry:`, err);
  try {
    if (!mongoose.isValidObjectId(idOf(input.order))) return;
    const now = new Date();
    const org = input.org
      ? Object.fromEntries(Object.entries(input.org).filter(([, v]) => !!v).map(([k, v]) => [k, idOf(v)]))
      : undefined;
    await PendingSettlement.findOneAndUpdate(
      { ...keyOf(input), open: true },
      {
        $setOnInsert: {
          ...(input.sellerUser ? { sellerUser: idOf(input.sellerUser) } : {}),
          ...(org && Object.keys(org).length ? { org } : {}),
          ...(input.autoCancel ? { autoCancel: input.autoCancel } : {}),
          ...(input.onDelivery ? { onDelivery: true } : {}),
          ...(input.deliveredBy ? { deliveredBy: input.deliveredBy } : {}),
          nextAttemptAt: new Date(now.getTime() + BASE_DELAY_MS),
        },
        $set: { lastError: errText(err) },
      },
      { upsert: true },
    );
  } catch (recordErr: any) {
    // two failures of the same settlement at once: the other one recorded it
    if (recordErr?.code !== 11000) console.log("[settlement] could not record the failed settlement:", recordErr);
  }
};

// One retry of one record: the order is read fresh, the same settlement runs.
const retryOne = async (row: IPendingSettlement): Promise<void> => {
  const Order = mongoose.model("Order");
  const order = await Order.findById(row.order).lean();
  // nothing left to settle (the order is gone): close it
  if (!order) return;
  if (row.kind === "orderLine") {
    const { settleOrderLineOnce } = await import("./orderSettlementService");
    await settleOrderLineOnce({
      order: order as never,
      model: row.model as never,
      itemId: String(row.itemId || ""),
      sellerUserId: row.sellerUser,
      org: row.org as never,
      autoCancel: row.autoCancel as never,
      onDelivery: row.onDelivery,
    });
    return;
  }
  const { retryDeliveredShipmentSettlement } = await import("./shipmentDeliveryService");
  await retryDeliveredShipmentSettlement(order as never, idOf(row.shipment), row.deliveredBy);
};

export const runSettlementRetrySweep = async (now: Date = new Date()): Promise<{ settled: number; failed: number }> => {
  const due = await PendingSettlement.find({ open: true, nextAttemptAt: { $lte: now } })
    .sort({ nextAttemptAt: 1 })
    .limit(BATCH)
    .select("_id nextAttemptAt")
    .lean();
  let settled = 0;
  let failed = 0;
  for (const candidate of due) {
    // claim it: lease it and count the attempt
    const row = await PendingSettlement.findOneAndUpdate(
      { _id: candidate._id, open: true, nextAttemptAt: candidate.nextAttemptAt },
      { $set: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
      { new: true },
    ).lean<IPendingSettlement>();
    if (!row) continue;
    try {
      await retryOne(row);
      await PendingSettlement.updateOne({ _id: row._id }, { $set: { doneAt: new Date() }, $unset: { open: 1 } });
      settled++;
    } catch (err) {
      failed++;
      await PendingSettlement.updateOne(
        { _id: row._id, open: true },
        { $set: { lastError: errText(err), nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts)) } },
      );
      if (row.attempts >= ALERT_AFTER) {
        const claimed = await PendingSettlement.updateOne(
          { _id: row._id, alertedAt: { $exists: false } },
          { $set: { alertedAt: new Date() } },
        );
        if (claimed.modifiedCount)
          notifyUserAlertSubscribers(
            "settlementFailed",
            {
              title: "تسویه‌ی سفارش انجام نشد",
              message: `تسویه‌ی سفارش ${idOf(row.order).slice(-8)} پس از ${row.attempts} بار تلاش انجام نشد؛ سفارش را بررسی کنید.`,
              link: `/notadmin/finance/orders/${idOf(row.order)}`,
            },
            { orderId: idOf(row.order), attempts: String(row.attempts) },
          ).catch(() => undefined);
      }
    }
  }
  if (settled || failed) console.log(`[settlement] retry sweep: ${settled} settled, ${failed} still failing`);
  return { settled, failed };
};

// every 5 minutes, one run at a time
export const startSettlementRetryJob = (intervalMs = 5 * 60 * 1000): void => {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    runSettlementRetrySweep()
      .catch((err) => console.log("[settlement] retry sweep failed:", err))
      .finally(() => {
        running = false;
      });
  }, intervalMs).unref?.();
};
