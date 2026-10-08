import { notifyWithSms } from "./notificationSmsService";
import { NotificationSmsEvent, NotificationSmsVariables } from "../Models/NotificationSms";
import { OrderLineAutoCancel } from "../Models/Order";
import { tehranJalaliFormat } from "../Lib/tehranTime";
import {
  getOrderResponseSettings,
  RESPONSE_LINE_MODELS,
} from "../Lib/orderResponse";
import { creditEarning } from "../Lib/payoutHold";
import { CommissionKind, getCommissionPercent, splitCommission } from "../Lib/commission";
import mongoose from "mongoose";
import { IOrder } from "../Models/Order";
import Transaction from "../Models/Transaction";
import Wallet from "../Models/Wallet";
import Notification from "../Models/Notification";

// Money side of a seller finishing one line of a cart order (2026-09).
// Called right after the line's status moved out of "pending" (the caller's
// update is conditional on "pending", so this runs once per line):
//
//   fulfilled -> the seller's owner account is credited the line's pre-tax
//                price (price * qty), the same rule as a doctor's visit
//                payout (Services/reservationProgressService.ts): tax is the
//                buyer's added charge, never the seller's revenue
//   cancelled -> the buyer gets the line back in full, its share of the
//                order's tax included, on their wallet
//
// Both are idempotent per line (Transaction.orderItem), so a retry never pays
// or refunds twice.

export type OrderLineModel =
  | "products"
  | "productPackages"
  | "services"
  | "servicePackages"
  | "tests";

type OrgRef = {
  pharmacy?: mongoose.Types.ObjectId;
  doctor?: mongoose.Types.ObjectId;
  paraClinic?: mongoose.Types.ObjectId;
};

type OrderLine = {
  _id: mongoose.Types.ObjectId;
  item: unknown;
  qty: number;
  price: number;
  tax?: number;
  status: string;
};

const idOf = (value: unknown) =>
  String((value as { _id?: unknown })?._id ?? value);

const credit = async (
  userId: mongoose.Types.ObjectId | string,
  amount: number,
) => {
  const wallet = await Wallet.findOneAndUpdate(
    { user: userId },
    { user: userId },
    { upsert: true, new: true },
  );
  await Wallet.findByIdAndUpdate(wallet._id, { $inc: { balance: amount } });
};

// A shipment's Tapsi fee (Lib/delivery.ts) follows its pharmacy's lines:
// once one of them is fulfilled the pharmacy - which calls the courier - is
// credited the fee (no commission: it's courier money); if every line from
// that pharmacy ends cancelled the buyer gets it back. Idempotent per
// shipment (Transaction.orderItem = the shipment's id).
const settleShipment = async (
  orderId: mongoose.Types.ObjectId,
  model: OrderLineModel,
  itemId: string,
) => {
  if (model !== "products" && model !== "productPackages") return;
  const Order = mongoose.model("Order");
  const order = (await Order.findById(orderId).lean()) as unknown as IOrder | null;
  if (!order?.shipments?.length) return;
  const catalog = await mongoose
    .model(lineOwner[model].model)
    .findById(itemId)
    .select(lineOwner[model].field)
    .lean<Record<string, unknown>>();
  const pharmacyId = idOf(catalog?.[lineOwner[model].field]);
  const shipment = order.shipments.find((el) => idOf(el.pharmacy) === pharmacyId);
  if (!shipment || !(shipment.fee > 0)) return;
  if (await Transaction.exists({ order: order._id, orderItem: shipment._id }))
    return;
  // every physical line of this order that belongs to the same pharmacy
  const [sellerItems, packageItems] = await Promise.all([
    mongoose
      .model("ProductSeller")
      .find({ _id: { $in: (order.products || []).map((l) => l.item) }, seller: pharmacyId })
      .distinct("_id"),
    mongoose
      .model("ProductPackage")
      .find({ _id: { $in: (order.productPackages || []).map((l) => l.item) }, owner: pharmacyId })
      .distinct("_id"),
  ]);
  const owned = new Set([...sellerItems, ...packageItems].map(String));
  const lines = [...(order.products || []), ...(order.productPackages || [])].filter(
    (l) => owned.has(idOf(l.item)),
  );
  if (lines.some((l) => l.status === "fulfilled")) {
    const pharmacy = await mongoose
      .model("Pharmacy")
      .findById(pharmacyId)
      .select("user")
      .lean<{ _id: mongoose.Types.ObjectId; user?: unknown }>();
    if (!pharmacy?.user) return;
    // the whole fee, also the part a «پرو» member did not pay (the
    // platform's, Transaction.platformSubsidy)
    const subsidy = Math.min(shipment.fee, Math.max(0, Number(shipment.proDiscount) || 0));
    await credit(idOf(pharmacy.user), shipment.fee);
    await Transaction.create({
      user: idOf(pharmacy.user),
      amount: shipment.fee,
      order: order._id,
      orderItem: shipment._id,
      pharmacy: pharmacy._id,
      ...(subsidy > 0 ? { platformSubsidy: subsidy } : {}),
    });
    return;
  }
  if (lines.length && lines.every((l) => l.status === "cancelled")) {
    const buyerId = idOf(order.user);
    // back what the buyer paid for it (less a «پرو» discount)
    const paid = Math.max(0, shipment.fee - Math.max(0, Number(shipment.proDiscount) || 0));
    if (paid <= 0) return;
    await credit(buyerId, paid);
    await Transaction.create({
      user: buyerId,
      amount: paid,
      order: order._id,
      orderItem: shipment._id,
    });
  }
};

export const settleOrderLine = async (args: {
  order: IOrder;
  model: OrderLineModel;
  itemId: string;
  sellerUserId?: unknown;
  org?: OrgRef;
  // the platform cancelled the line (a sweep), not a person: the buyer is
  // told why, with its own SMS event
  autoCancel?: OrderLineAutoCancel;
}): Promise<void> => {
  await settleOrderLineMoney(args);
  await settleShipment(
    args.order._id as unknown as mongoose.Types.ObjectId,
    args.model,
    args.itemId,
  ).catch((err) => console.log("[orders] shipment settle failed:", err));
};

const settleOrderLineMoney = async ({
  order,
  model,
  itemId,
  sellerUserId,
  org,
  autoCancel,
}: {
  order: IOrder;
  model: OrderLineModel;
  itemId: string;
  // the org's owner account (a populated User or its id)
  sellerUserId?: unknown;
  org?: OrgRef;
  autoCancel?: OrderLineAutoCancel;
}): Promise<void> => {
  const sellerId = sellerUserId ? idOf(sellerUserId) : undefined;
  const lines = ((order as unknown as Record<string, OrderLine[]>)[model] ||
    []) as OrderLine[];
  const line = lines.find((l) => idOf(l.item) === itemId);
  if (!line) return;
  const lineTotal = Math.max(0, (line.price || 0) * (line.qty || 0));
  const buyerId = idOf(order.user);
  const link = `/order/${order._id}`;

  if (line.status === "fulfilled") {
    if (!sellerId || lineTotal <= 0) return;
    const already = await Transaction.exists({
      order: order._id,
      orderItem: line._id,
      user: sellerId,
    });
    if (already) return;
    // the seller receives the line minus the platform commission for its
    // kind (Lib/commission.ts); the buyer's price never changes
    const kind: CommissionKind =
      model === "tests"
        ? "paraClinic"
        : model === "services" || model === "servicePackages"
          ? "doctorOnline"
          : "pharmacy";
    const orgId = org?.paraClinic || org?.doctor || org?.pharmacy;
    const percent = await getCommissionPercent(kind, orgId);
    const { commission, net } = splitCommission(lineTotal, percent);
    // the seller is the seller of record (2026-10): the line's VAT is paid
    // out with the earning and declared on the seller's Moadian invoice
    const tax = typeof line.tax === "number" ? Math.max(0, line.tax) : 0;
    // into the settlement hold (Lib/payoutHold.ts), withdrawable after it
    await creditEarning(sellerId, net + tax, {
      order: order._id,
      orderItem: line._id,
      grossAmount: lineTotal,
      commission,
      commissionPercent: percent,
      tax,
      ...(org || {}),
    } as any);
    await Notification.create({
      user: buyerId,
      source: "System",
      title: "بخشی از سفارش شما آماده شد",
      message: "فروشنده یک قلم از سفارش شما را آماده و تحویل کرد.",
      link,
    }).catch(() => {});
    // one SMS per order for items fulfilled together
    notifyWithSms("orderItemFulfilledUser", buyerId, { orderId: String(order._id) }, {
      once: String(order._id),
    });
    return;
  }

  if (line.status === "cancelled") {
    // the line's own tax goes back with it (snapshotted per line since
    // 2026-09 - each seller has its own rate); older orders fall back to a
    // proportional share of the order's tax. Never more than the order's tax.
    const taxShare = Math.min(
      Math.max(0, order.tax || 0),
      typeof line.tax === "number"
        ? line.tax
        : order.subtotal > 0 && order.tax > 0
          ? Math.round((order.tax * lineTotal) / order.subtotal)
          : 0,
    );
    const refund = lineTotal + taxShare;
    if (refund <= 0) return;
    const already = await Transaction.exists({
      order: order._id,
      orderItem: line._id,
      user: buyerId,
    });
    if (already) return;
    await credit(buyerId, refund);
    await Transaction.create({
      user: buyerId,
      amount: refund,
      order: order._id,
      orderItem: line._id,
    });
    await Notification.create({
      user: buyerId,
      source: "System",
      ...(autoCancel
        ? {
            title: "یک قلم از سفارش شما خودکار لغو شد",
            message:
              autoCancel === "noResponse"
                ? "فروشنده در مهلت مقرر پاسخ نداد؛ مبلغ این قلم به کیف پول شما برگشت."
                : "فروشنده این قلم را به‌موقع آماده نکرد؛ مبلغ آن به کیف پول شما برگشت.",
          }
        : {
            title: "یک قلم از سفارش شما لغو شد",
            message: "مبلغ این قلم به کیف پول شما برگشت.",
          }),
      link,
    }).catch(() => {});
    // one SMS per order when several items are cancelled together (support
    // cancelling the whole order, the sweeps)
    notifyWithSms(
      autoCancel ? "orderAutoCancelledUser" : "orderItemCancelledUser",
      buyerId,
      { orderId: String(order._id) },
      { once: String(order._id) },
    );
  }
};

// Which catalog doc a line points to, and which field on it names the seller
// org (whose `user` is the account to tell).
const lineOwner: Record<OrderLineModel, { model: string; field: string; org: string }> = {
  products: { model: "ProductSeller", field: "seller", org: "Pharmacy" },
  productPackages: { model: "ProductPackage", field: "owner", org: "Pharmacy" },
  services: { model: "Service", field: "owner", org: "DoctorProfile" },
  servicePackages: { model: "ServicePackage", field: "owner", org: "DoctorProfile" },
  tests: { model: "ParaClinicTest", field: "paraClinic", org: "ParaClinic" },
};

const sellerPanelLink: Record<string, string> = {
  Pharmacy: "/pharmacypanel/order",
  DoctorProfile: "/doctorpanel/order",
  ParaClinic: "/paraClinicPanel/order",
};

// Tells the seller org that owns a line (its owner account): an in-app
// notice linking to the order in its panel, plus the event's SMS (once per
// order and seller). Best effort - a lookup miss never blocks the caller.
const notifyLineSeller = async <E extends NotificationSmsEvent>(
  orderId: unknown,
  model: OrderLineModel,
  itemId: string,
  text: { title: string; message: string },
  event: E,
  variables: NotificationSmsVariables[E],
): Promise<void> => {
  try {
    const owner = lineOwner[model];
    const doc = await mongoose.model(owner.model).findById(itemId).select(owner.field).lean<Record<string, unknown>>();
    const orgId = doc?.[owner.field];
    if (!orgId) return;
    const org = await mongoose.model(owner.org).findById(orgId).select("user").lean<{ user?: unknown }>();
    if (!org?.user) return;
    await Notification.create({
      user: idOf(org.user),
      source: "System",
      title: text.title,
      message: text.message,
      link: `${sellerPanelLink[owner.org]}/${String(orderId)}`,
    });
    notifyWithSms(event, idOf(org.user), variables, {
      once: `${String(orderId)}:${idOf(org.user)}`,
    });
  } catch {
    // ignore
  }
};

// The buyer cancelled a line before it was prepared: tell the seller not to
// ship it.
export const notifySellerOfBuyerCancel = async (
  orderId: unknown,
  model: OrderLineModel,
  itemId: string,
  text: { title: string; message: string } = {
    title: "خریدار سفارش را لغو کرد",
    message: "یکی از اقلام سفارش پیش از آماده‌سازی توسط خریدار لغو شد؛ آن را ارسال نکنید.",
  },
): Promise<void> =>
  notifyLineSeller(orderId, model, itemId, text, "orderCancelledByBuyerSeller", {
    orderId: String(orderId),
  });

// Lines a seller never acted on (2026-09): a paid order must not wait
// forever. After STALE_LINE_DAYS the line is cancelled for the seller - the
// buyer gets the line (and its tax) back in the wallet, the seller is told.
// Same path as a seller's own cancel (settleOrderLine), so it is idempotent.
const STALE_LINE_DAYS = 7;
const LINE_MODELS: OrderLineModel[] = [
  "products",
  "productPackages",
  "services",
  "servicePackages",
  "tests",
];

export const runStaleOrderLineSweep = async (): Promise<void> => {
  const cutoff = new Date(Date.now() - STALE_LINE_DAYS * 24 * 60 * 60 * 1000);
  const Order = mongoose.model("Order");
  for (const model of LINE_MODELS) {
    const orders = await Order.find({
      status: "paid",
      paidAt: { $lt: cutoff },
      [`${model}.status`]: "pending",
    }).limit(200);
    for (const order of orders) {
      const lines = (order.get(model) || []) as OrderLine[];
      for (const line of lines.filter((l) => l.status === "pending")) {
        // answered (accepted) but never finished, or - a line with no
        // response deadline (doctor services, legacy) - never answered
        const autoCancel: OrderLineAutoCancel = (line as { acceptedAt?: Date }).acceptedAt
          ? "notFulfilled"
          : "noResponse";
        const updated = await Order.findOneAndUpdate(
          {
            _id: order._id,
            [model]: { $elemMatch: { _id: line._id, status: "pending" } },
          },
          {
            $set: {
              [`${model}.$.status`]: "cancelled",
              [`${model}.$.autoCancel`]: autoCancel,
              [`${model}.$.autoCancelledAt`]: new Date(),
            },
          },
          { new: true },
        );
        if (!updated) continue;
        const itemId = idOf(line.item);
        await settleOrderLine({ order: updated, model, itemId, autoCancel });
        await notifyLineSeller(
          updated._id,
          model,
          itemId,
          {
            title: "یک قلم سفارش به‌خاطر بی‌پاسخ ماندن لغو شد",
            message: `این قلم ${STALE_LINE_DAYS} روز آماده نشد؛ مبلغش به خریدار برگشت. آن را ارسال نکنید.`,
          },
          "orderAutoCancelledSeller",
          { orderId: String(updated._id) },
        );
      }
    }
  }
};

export const startStaleOrderLineJob = (intervalMs = 60 * 60 * 1000): void => {
  setInterval(() => {
    runStaleOrderLineSweep().catch((err) =>
      console.log("[orders] stale line sweep failed:", err),
    );
  }, intervalMs).unref?.();
};

// ------------------------------------------------- seller response deadline
// Lib/orderResponse.ts (2026-10 owner decision): a pharmacy line nobody
// answered within 24 hours of payment, or a lab line within 72 hours (both
// admin settings), is cancelled and refunded through the same settlement as
// a seller's own cancel. The seller is warned `warnHours` before.
//
// Exactly-once, also against a seller acting at the same moment: the warning
// claims `responseWarnedAt` atomically, and the cancel is a single update
// conditional on the line being pending, unanswered (no `acceptedAt`, no
// approved prescription, no lab result) and past its deadline. The seller's
// accept / fulfil / cancel / review / upload are conditional on the line
// still being pending, so whichever lands first wins and the other matches
// nothing. settleOrderLine is itself idempotent per line.

const unansweredMatch = (now: Date) => ({
  status: "pending",
  acceptedAt: { $exists: false },
  "prescription.status": { $ne: "approved" },
  "result.uploadedAt": { $exists: false },
  respondBy: { $lte: now },
});

const SWEEP_BATCH = 200;

export const runOrderResponseSweep = async (
  now: Date = new Date(),
): Promise<{ warned: number; cancelled: number }> => {
  const Order = mongoose.model("Order");
  const settings = await getOrderResponseSettings();
  let warned = 0;
  let cancelled = 0;

  for (const model of RESPONSE_LINE_MODELS) {
    // 1) the warning, once per line, while the deadline is still ahead
    if (settings.warnHours > 0) {
      const warnUntil = new Date(now.getTime() + settings.warnHours * 60 * 60 * 1000);
      const warnMatch = {
        status: "pending",
        acceptedAt: { $exists: false },
        "prescription.status": { $ne: "approved" },
        "result.uploadedAt": { $exists: false },
        responseWarnedAt: { $exists: false },
        respondBy: { $gt: now, $lte: warnUntil },
      };
      const toWarn = await Order.find({ status: "paid", [model]: { $elemMatch: warnMatch } })
        .select(`_id ${model}`)
        .limit(SWEEP_BATCH)
        .lean<Record<string, any>[]>();
      for (const order of toWarn) {
        const lines = ((order[model] || []) as any[]).filter(
          (l) =>
            l?.status === "pending" &&
            !l.acceptedAt &&
            !l.responseWarnedAt &&
            l.respondBy &&
            new Date(l.respondBy) > now &&
            new Date(l.respondBy) <= warnUntil,
        );
        for (const line of lines) {
          const claimed = await Order.updateOne(
            { _id: order._id, status: "paid", [model]: { $elemMatch: { _id: line._id, ...warnMatch } } },
            { $set: { [`${model}.$.responseWarnedAt`]: new Date() } },
          );
          if (!claimed.modifiedCount) continue;
          warned += 1;
          await notifyLineSeller(
            order._id,
            model,
            idOf(line.item),
            {
              title: "مهلت پاسخ به سفارش رو به پایان است",
              message:
                "اگر این قلم سفارش تا پایان مهلت پاسخ پذیرفته یا آماده نشود، خودکار لغو و مبلغش به خریدار برگردانده می‌شود.",
            },
            "orderResponseDueSoonSeller",
            {
              orderId: String(order._id),
              deadline: tehranJalaliFormat(line.respondBy, "jYYYY/jMM/jDD HH:mm"),
            },
          );
        }
      }
    }

    // 2) the cancel + refund, past the deadline
    const due = await Order.find({ status: "paid", [model]: { $elemMatch: unansweredMatch(now) } })
      .select(`_id ${model}`)
      .limit(SWEEP_BATCH)
      .lean<Record<string, any>[]>();
    for (const order of due) {
      const lines = ((order[model] || []) as any[]).filter(
        (l) => l?.status === "pending" && !l.acceptedAt && l.respondBy && new Date(l.respondBy) <= now,
      );
      for (const line of lines) {
        const updated = await Order.findOneAndUpdate(
          {
            _id: order._id,
            status: "paid",
            [model]: { $elemMatch: { _id: line._id, ...unansweredMatch(now) } },
          },
          {
            $set: {
              [`${model}.$.status`]: "cancelled",
              [`${model}.$.autoCancel`]: "noResponse",
              [`${model}.$.autoCancelledAt`]: new Date(),
            },
          },
          { new: true },
        );
        if (!updated) continue;
        cancelled += 1;
        const itemId = idOf(line.item);
        await settleOrderLine({ order: updated, model, itemId, autoCancel: "noResponse" });
        await notifyLineSeller(
          updated._id,
          model,
          itemId,
          {
            title: "یک قلم سفارش به‌خاطر بی‌پاسخ ماندن لغو شد",
            message: "این قلم در مهلت پاسخ پذیرفته نشد؛ مبلغش به خریدار برگشت. آن را ارسال نکنید.",
          },
          "orderAutoCancelledSeller",
          { orderId: String(updated._id) },
        );
      }
    }
  }
  if (warned || cancelled)
    console.log(`[orders] response sweep: ${warned} warned, ${cancelled} auto-cancelled`);
  return { warned, cancelled };
};

// every 5 minutes, so a line is cancelled within minutes of its deadline;
// one run at a time
export const startOrderResponseJob = (intervalMs = 5 * 60 * 1000): void => {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    runOrderResponseSweep()
      .catch((err) => console.log("[orders] response sweep failed:", err))
      .finally(() => {
        running = false;
      });
  }, intervalMs).unref?.();
};
