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
import { settleLineSampling } from "../Lib/labSampling";
import { lineAwaitsDelivery, pharmacyOfLine, startTipaxSendWindow } from "../Lib/shipmentDelivery";
import { recordPendingSettlement } from "./settlementRetryService";

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
// or refunds twice. A settlement that throws after the state change was
// saved is queued and retried with backoff (Services/settlementRetryService.ts)
// instead of being only logged.

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
    // the row first: a retry finds it and never credits the fee twice
    await Transaction.create({
      user: idOf(pharmacy.user),
      amount: shipment.fee,
      order: order._id,
      orderItem: shipment._id,
      pharmacy: pharmacy._id,
      ...(subsidy > 0 ? { platformSubsidy: subsidy } : {}),
    });
    await credit(idOf(pharmacy.user), shipment.fee);
    return;
  }
  if (lines.length && lines.every((l) => l.status === "cancelled")) {
    const buyerId = idOf(order.user);
    // back what the buyer paid for it (less a «پرو» discount)
    const paid = Math.max(0, shipment.fee - Math.max(0, Number(shipment.proDiscount) || 0));
    if (paid <= 0) return;
    await Transaction.create({
      user: buyerId,
      amount: paid,
      order: order._id,
      orderItem: shipment._id,
    });
    await credit(buyerId, paid);
  }
};

type SettleArgs = {
  order: IOrder;
  model: OrderLineModel;
  itemId: string;
  sellerUserId?: unknown;
  org?: OrgRef;
  // the platform cancelled the line (a sweep), not a person: the buyer is
  // told why, with its own SMS event
  autoCancel?: OrderLineAutoCancel;
  // settled because its Tipax parcel was confirmed delivered
  // (Services/shipmentDeliveryService.ts): the buyer gets the "delivered"
  // notice from there, not the per-line "prepared" one
  onDelivery?: boolean;
};

// What every caller uses: the settlement of a line whose status just moved.
// It never throws - a failure is recorded for the retry sweep, so the state
// change the caller already saved is never left without its money.
export const settleOrderLine = async (args: SettleArgs): Promise<void> => {
  try {
    await settleOrderLineOnce(args);
  } catch (err) {
    await recordPendingSettlement(
      {
        kind: "orderLine",
        order: args.order?._id,
        model: args.model,
        itemId: args.itemId,
        sellerUser: args.sellerUserId,
        org: args.org as Record<string, unknown> | undefined,
        autoCancel: args.autoCancel,
        onDelivery: args.onDelivery,
      },
      err,
    );
  }
};

// One attempt (the retry sweep calls it again with the order read fresh).
export const settleOrderLineOnce = async (args: SettleArgs): Promise<void> => {
  // a Tipax parcel whose last line just left "pending" starts its sending
  // window (Lib/shipmentDelivery.ts startTipaxSendWindow): best effort, the
  // migration stamps any parcel missed here
  if (args.model === "products" || args.model === "productPackages")
    await pharmacyOfLine(args.model, args.itemId)
      .then((pharmacy) => (pharmacy ? startTipaxSendWindow(args.order._id, pharmacy) : null))
      .catch((err) => console.log("[orders] Tipax sending window failed:", err));
  // a fulfilled pharmacy line in a Tipax parcel not confirmed delivered yet
  // (Lib/shipmentDelivery.ts) is prepared and on its way: the payout (and
  // its settlement hold) and the review ask wait for the delivery
  const lines = ((args.order as unknown as Record<string, OrderLine[]>)[args.model] || []) as OrderLine[];
  const fulfilled = lines.find((l) => idOf(l.item) === args.itemId)?.status === "fulfilled";
  const awaitingDelivery =
    fulfilled &&
    (await lineAwaitsDelivery(args.order._id, args.model, args.itemId).catch((err) => {
      console.log("[orders] delivery check failed:", err);
      return true;
    }));
  if (awaitingDelivery) return;
  await settleOrderLineMoney(args);
  // the shipment's Tapsi fee is money too: a failure here goes to the retry
  // (idempotent per shipment) with the rest of the settlement
  await settleShipment(
    args.order._id as unknown as mongoose.Types.ObjectId,
    args.model,
    args.itemId,
  );
  // a lab line's sampling appointment follows its lines: all cancelled ->
  // its seat and home fee go back; one fulfilled -> the lab earns the fee
  // (Lib/labSampling.ts)
  if (args.model === "tests")
    await settleLineSampling(args.order._id, args.itemId).catch((err) =>
      console.log("[orders] sampling settle failed:", err),
    );
  await inviteSellerReview(args.order, args.model, args.itemId).catch((err) =>
    console.log("[orders] review invite failed:", err),
  );
};

// "Rate your order" (2026-10, Digikala / Snappfood / Halodoc): once a line
// from a pharmacy or a lab is fulfilled, its buyer is asked - once per
// order and seller - to rate that seller, in-app (linking to the order
// page's review box) and by SMS. The review itself is verified against the
// order (Lib/reviewVerification.ts), so the ask never opens anything.
const inviteSellerReview = async (
  order: IOrder,
  model: OrderLineModel,
  itemId: string,
): Promise<void> => {
  if (model !== "products" && model !== "productPackages" && model !== "tests") return;
  const lines = ((order as unknown as Record<string, OrderLine[]>)[model] || []) as OrderLine[];
  const line = lines.find((l) => idOf(l.item) === itemId);
  if (line?.status !== "fulfilled") return;
  const owner = lineOwner[model];
  const doc = await mongoose
    .model(owner.model)
    .findById(itemId)
    .select(owner.field)
    .lean<Record<string, unknown>>();
  const orgId = doc?.[owner.field];
  if (!orgId) return;
  const org = await mongoose
    .model(owner.org)
    .findById(idOf(orgId))
    .select("name")
    .lean<{ _id: mongoose.Types.ObjectId; name?: string }>();
  if (!org) return;
  // claim the ask atomically: a second fulfilled line sends nothing
  const claimed = await mongoose.model("Order").updateOne(
    { _id: order._id, reviewInvites: { $ne: org._id } },
    { $addToSet: { reviewInvites: org._id } },
  );
  if (!claimed.modifiedCount) return;
  const buyerId = idOf(order.user);
  const sellerName = org.name || "";
  notifyWithSms(
    "orderReviewRequestUser",
    buyerId,
    { orderId: String(order._id), sellerName },
    {
      notification: {
        title: owner.org === "ParaClinic" ? "به این آزمایشگاه امتیاز دهید" : "به این داروخانه امتیاز دهید",
        message: sellerName
          ? `تجربه‌ی سفارشتان از «${sellerName}» چطور بود؟ امتیاز و نظر شما به دیگران کمک می‌کند.`
          : "تجربه‌ی سفارشتان چطور بود؟ امتیاز و نظر شما به دیگران کمک می‌کند.",
        link: `/order/${String(order._id)}#review`,
      },
      once: `review:${String(order._id)}:${String(org._id)}`,
    },
  );
};

const settleOrderLineMoney = async ({
  order,
  model,
  itemId,
  sellerUserId,
  org,
  autoCancel,
  onDelivery,
}: {
  order: IOrder;
  model: OrderLineModel;
  itemId: string;
  // the org's owner account (a populated User or its id)
  sellerUserId?: unknown;
  org?: OrgRef;
  autoCancel?: OrderLineAutoCancel;
  onDelivery?: boolean;
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
    if (onDelivery) return;
    // a lab line is done by its result (Lib/labResultCompletion.ts), whose
    // own "your result is ready" notice and SMS already told the buyer
    if (model === "tests" && (line as { result?: { uploadedAt?: unknown } }).result?.uploadedAt) return;
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
    // the row first, like creditEarning: it is what makes a retry skip
    // this refund, so a retry after a failure can never credit it twice
    await Transaction.create({
      user: buyerId,
      amount: refund,
      order: order._id,
      orderItem: line._id,
    });
    await credit(buyerId, refund);
    await Notification.create({
      user: buyerId,
      source: "System",
      ...(autoCancel
        ? {
            title: "یک قلم از سفارش شما خودکار لغو شد",
            message:
              autoCancel === "noResponse"
                ? "فروشنده در مهلت مقرر پاسخ نداد؛ مبلغ این قلم به کیف پول شما برگشت."
                : autoCancel === "notSent"
                  ? "داروخانه مرسوله‌ی تیپاکس را در مهلت ارسال نفرستاد؛ مبلغ این قلم به کیف پول شما برگشت."
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
    // a parcel never sent has its own SMS, sent once per parcel by the
    // sending-deadline sweep (Services/shipmentDeliveryService.ts)
    if (autoCancel !== "notSent")
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
        // a lab line waits from its sampling appointment, not from payment:
        // a sample taken next week has its 7 days from then
        const samplingAt = (line as { samplingAt?: Date }).samplingAt;
        if (samplingAt && new Date(samplingAt) > cutoff) continue;
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
