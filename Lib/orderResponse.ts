import mongoose from "mongoose";
import { getAppConfig } from "./appConfig";

// Seller response deadlines of cart orders (2026-10 owner decision, audit
// O-1 in the frontend's docs/logic-audit/money.md).
//
// Like Digikala's marketplace and Halodoc's pharmacy partners, a seller must
// answer a paid line within a fixed window or the platform cancels it and
// refunds the buyer: 24 hours for a pharmacy, 72 hours for a lab (the sample
// is often taken later). Both windows and the advance warning are super
// admin settings (AppConfig, «تنظیمات مالی» > «سفارش‌ها»).
//
// "Answered" means the seller did something with the line:
//   - accepted it (PATCH .../order/:id { status: "accepted" })
//   - approved its prescription (an Rx line; a rejection cancels it)
//   - uploaded a lab result
//   - sent the shipment it belongs to (tracking code or courier)
//   - fulfilled or cancelled it (status leaves "pending")
// Every one of those sets `acceptedAt` (or ends "pending") in an atomic
// update, and the sweep's own cancel is conditional on neither having
// happened, so a seller action racing the sweep gives exactly one outcome.
//
// What is NOT the seller's wait: an unpaid order (status "pending", no
// `respondBy` yet - the clock starts at payment) and doctor service lines
// (no SLA; they keep the 7-day stale sweep).

export const RESPONSE_LINE_MODELS = ["products", "productPackages", "tests"] as const;
export type ResponseLineModel = (typeof RESPONSE_LINE_MODELS)[number];

export const DEFAULT_RESPONSE_HOURS = { pharmacy: 24, lab: 72, warn: 2 };

const HOUR = 60 * 60 * 1000;

const hoursOr = (value: unknown, fallback: number, min: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

export type OrderResponseSettings = {
  pharmacyHours: number;
  labHours: number;
  warnHours: number;
};

export const getOrderResponseSettings = async (): Promise<OrderResponseSettings> => {
  try {
    const config = await getAppConfig();
    return {
      pharmacyHours: hoursOr(config.orderResponseHoursPharmacy, DEFAULT_RESPONSE_HOURS.pharmacy, 1),
      labHours: hoursOr(config.orderResponseHoursLab, DEFAULT_RESPONSE_HOURS.lab, 1),
      warnHours: hoursOr(config.orderResponseWarnHours, DEFAULT_RESPONSE_HOURS.warn, 0),
    };
  } catch {
    return {
      pharmacyHours: DEFAULT_RESPONSE_HOURS.pharmacy,
      labHours: DEFAULT_RESPONSE_HOURS.lab,
      warnHours: DEFAULT_RESPONSE_HOURS.warn,
    };
  }
};

export const responseHoursFor = (model: ResponseLineModel, settings: OrderResponseSettings) =>
  model === "tests" ? settings.labHours : settings.pharmacyHours;

type StampableLine = { status?: string; respondBy?: Date; acceptedAt?: Date };

// Stamps `respondBy` on the order's pending pharmacy / lab lines, in place,
// right before the paid order is saved (Controllers/cartController.ts wallet
// checkout, Services/paymentService.ts SEP settlement). Never throws: a
// missing setting falls back to the defaults, so payment is never blocked.
export const stampOrderResponseDeadlines = async (
  order: { paidAt?: Date; get?: (path: string) => unknown } & Record<string, unknown>,
): Promise<void> => {
  try {
    const settings = await getOrderResponseSettings();
    const from = order.paidAt ? new Date(order.paidAt).getTime() : Date.now();
    for (const model of RESPONSE_LINE_MODELS) {
      const lines = (order[model] || []) as StampableLine[];
      if (!Array.isArray(lines)) continue;
      const deadline = new Date(from + responseHoursFor(model, settings) * HOUR);
      for (const line of lines) {
        if (!line || line.status !== "pending" || line.respondBy || line.acceptedAt) continue;
        line.respondBy = deadline;
      }
    }
  } catch (err) {
    console.log("[orders] stamping response deadlines failed:", err);
  }
};

// A seller answered without accepting explicitly (sent the shipment,
// dispatched a courier): every pending line of `itemIds` in the order counts
// as answered. `$min` keeps an earlier acceptance time and fills a missing
// one. Best effort.
export const markLinesAnswered = async (
  orderId: unknown,
  model: "products" | "productPackages" | "tests",
  itemIds: unknown[],
): Promise<void> => {
  if (!itemIds.length) return;
  try {
    await mongoose.model("Order").updateOne(
      { _id: orderId, status: "paid" },
      { $min: { [`${model}.$[l].acceptedAt`]: new Date() } },
      // an Rx line is answered only by reviewing its prescription
      {
        arrayFilters: [
          { "l.item": { $in: itemIds }, "l.status": "pending", "l.requiresPrescription": { $ne: true } },
        ],
      },
    );
  } catch (err) {
    console.log("[orders] marking lines answered failed:", err);
  }
};

// One-off backfill (2026-10) for orders paid before deadlines existed: a
// line a seller already answered gets `acceptedAt` from that answer; an
// unanswered one gets a full fresh window from now (not from its old payment
// date, which would cancel it the moment this ships). Only lines with no
// `respondBy` are touched, so a re-run changes nothing.
export const migrateOrderResponseDeadlines = async (): Promise<number> => {
  const Order = mongoose.model("Order");
  const settings = await getOrderResponseSettings();
  const now = Date.now();
  const orders = await Order.find({
    status: "paid",
    $or: RESPONSE_LINE_MODELS.map((model) => ({
      [model]: {
        $elemMatch: { status: "pending", respondBy: { $exists: false }, acceptedAt: { $exists: false } },
      },
    })),
  })
    .select("products productPackages tests shipments")
    .lean<Record<string, any>[]>();
  let touched = 0;
  for (const order of orders) {
    const set: Record<string, Date> = {};
    // a sent shipment answers its pharmacy's lines; with one pharmacy in the
    // order that is every product line (several pharmacies: not guessed)
    const shipments = Array.isArray(order.shipments) ? order.shipments : [];
    const shippedAt = shipments.length === 1 ? shipments[0]?.shippedAt : undefined;
    const shipped = !!shippedAt;
    for (const model of RESPONSE_LINE_MODELS) {
      (order[model] || []).forEach((line: any, i: number) => {
        if (!line || line.status !== "pending" || line.respondBy || line.acceptedAt) return;
        const answeredAt =
          model === "tests"
            ? line.result?.uploadedAt
            : line.prescription?.status === "approved"
              ? line.prescription.reviewedAt || new Date(now)
              : shipped && !line.requiresPrescription
                ? shippedAt
                : undefined;
        if (answeredAt) set[`${model}.${i}.acceptedAt`] = new Date(answeredAt);
        else set[`${model}.${i}.respondBy`] = new Date(now + responseHoursFor(model, settings) * HOUR);
      });
    }
    if (!Object.keys(set).length) continue;
    // only while those lines are still pending (a seller may act meanwhile)
    await Order.updateOne({ _id: order._id, status: "paid" }, { $set: set });
    touched += 1;
  }
  return touched;
};
