import mongoose from "mongoose";
import Order, { IOrder, ShipmentDeliveredBy } from "../Models/Order";
import Ticket from "../Models/Ticket";
import TicketMessage from "../Models/TicketMessage";
import Notification from "../Models/Notification";
import Transaction from "../Models/Transaction";
// the lookups below go through mongoose.model(): make sure they are registered
import "../Models/Pharmacy";
import "../Models/ProductSeller";
import "../Models/ProductPackage";
import { getDeliverySettings } from "../Lib/delivery";
import { itemsOfPharmacies } from "../Lib/shipmentDelivery";
import { notifyWithSms } from "./notificationSmsService";
import { notifyUserAlertSubscribers } from "./userAlertService";
import { settleOrderLine } from "./orderSettlementService";

// Tipax delivery confirmation (2026-10). An inter-city Tipax parcel goes
//
//   sent (the pharmacy enters the waybill number, every line of it already
//         fulfilled or cancelled; `confirmBy` = sent + the admin's
//         auto-confirm days, 7 by default)
//     -> delivered, confirmed by
//          the buyer («تحویل گرفتم» on the order page),
//          the sweep at `confirmBy` - unless the buyer reported a problem
//            («مرسوله نرسیده»: a support ticket opens, the auto-confirm
//            stops), or
//          support (the admin order page, with a reason)
//     -> returned (support only: lost or sent back) - its lines are
//          cancelled and refunded; nothing had been paid to the pharmacy
//
// Only on delivered is the pharmacy paid for its fulfilled lines (the
// settlement hold of Lib/payoutHold.ts starts then), is the buyer asked to
// rate it, and do the lines back a verified review (Lib/reviewVerification.ts).
// Digikala, Snappfood and Amazon do the same: "delivered" is the buyer's or
// the carrier's event, never the seller's own "I sent it".
//
// Every transition is one conditional update on the shipment (its current
// state is in the match), so a buyer tap, the sweep and support acting at
// the same moment change it once; the settlement after it is idempotent per
// line (Services/orderSettlementService.ts).

const DAY_MS = 24 * 60 * 60 * 1000;
const PHYSICAL = ["products", "productPackages"] as const;

type Shipment = IOrder["shipments"][number];

const idOf = (value: unknown) =>
  value ? String((value as { _id?: unknown })?._id ?? value) : "";

const shortId = (id: unknown) => idOf(id).slice(-8);

const pharmacyOf = async (id: unknown) =>
  id
    ? mongoose
        .model("Pharmacy")
        .findById(idOf(id))
        .select("name user")
        .lean<{ _id: mongoose.Types.ObjectId; name?: string; user?: unknown }>()
    : null;

// the order's lines that ship in this pharmacy's parcel
const linesOfShipment = async (order: IOrder, shipment: Shipment) => {
  const owned = await itemsOfPharmacies(order as never, new Set([idOf(shipment.pharmacy)]));
  return PHYSICAL.flatMap((model) =>
    ((order[model] || []) as unknown as { _id: mongoose.Types.ObjectId; item: unknown; status: string }[])
      .filter((l) => owned.has(idOf(l.item)))
      .map((line) => ({ model, line })),
  );
};

// the conditions of a parcel still on its way
const openShipment = (shipmentId: unknown) => ({
  _id: shipmentId,
  method: "tipax",
  shippedAt: { $exists: true },
  deliveredAt: { $exists: false },
  returnedAt: { $exists: false },
});

// -------------------------------------------------------------- delivered

export const confirmShipmentDelivered = async ({
  orderId,
  shipmentId,
  by,
  buyer,
  note,
  now = new Date(),
}: {
  orderId: unknown;
  shipmentId: unknown;
  by: ShipmentDeliveredBy;
  // the buyer's own confirmation: only on their own order
  buyer?: unknown;
  // support: the admin note kept on the order
  note?: Record<string, unknown>;
  now?: Date;
}): Promise<IOrder | null> => {
  if (!mongoose.isValidObjectId(idOf(orderId)) || !mongoose.isValidObjectId(idOf(shipmentId)))
    return null;
  const match: Record<string, unknown> = {
    ...openShipment(shipmentId),
    // the sweep: only past its date and with no problem reported
    ...(by === "auto"
      ? { confirmBy: { $lte: now }, "problem.reportedAt": { $exists: false } }
      : {}),
  };
  const updated = (await Order.findOneAndUpdate(
    {
      _id: orderId,
      status: "paid",
      ...(buyer ? { user: idOf(buyer) } : {}),
      shipments: { $elemMatch: match },
    },
    {
      $set: {
        "shipments.$.deliveredAt": now,
        "shipments.$.deliveredBy": by,
      },
      ...(note ? { $push: { adminNotes: note } } : {}),
    },
    { new: true },
  )) as unknown as IOrder | null;
  if (!updated) return null;
  const shipment = (updated.shipments || []).find((s) => idOf(s._id) === idOf(shipmentId));
  if (!shipment) return updated;
  await settleDeliveredShipment(updated, shipment, by).catch((err) =>
    console.log("[delivery] delivered settlement failed:", err),
  );
  return updated;
};

// The pharmacy is paid for every fulfilled line of the parcel (into its
// settlement hold), the buyer is asked to rate it, and both are told.
const settleDeliveredShipment = async (
  order: IOrder,
  shipment: Shipment,
  by: ShipmentDeliveredBy,
) => {
  const pharmacy = await pharmacyOf(shipment.pharmacy);
  for (const { model, line } of await linesOfShipment(order, shipment))
    if (line.status === "fulfilled")
      await settleOrderLine({
        order,
        model,
        itemId: idOf(line.item),
        sellerUserId: pharmacy?.user,
        org: pharmacy ? { pharmacy: pharmacy._id } : undefined,
        onDelivery: true,
      });
  // older parcels confirmed by the one-off migration were settled long ago
  if (by === "migration") return;
  const orderId = String(order._id);
  const sellerName = pharmacy?.name || "";
  // the buyer who tapped «تحویل گرفتم» needs no notice of their own tap
  if (by !== "buyer")
    notifyWithSms(
      "orderDeliveredUser",
      idOf(order.user),
      { orderId: String(order._id), sellerName },
      {
        notification: {
          title: "مرسوله‌ی شما تحویل‌شده ثبت شد",
          message:
            by === "auto"
              ? `مهلت تأیید تحویل مرسوله‌ی «${sellerName}» تمام شد و تحویل آن خودکار ثبت شد. اگر به دستتان نرسیده، به پشتیبانی خبر دهید.`
              : `پشتیبانی تحویل مرسوله‌ی «${sellerName}» را ثبت کرد.`,
          link: `/order/${orderId}`,
        },
        once: `delivered:${idOf(shipment._id)}`,
      },
    );
  if (pharmacy?.user)
    notifyWithSms(
      "orderDeliveredSeller",
      idOf(pharmacy.user),
      { orderId: String(order._id) },
      {
        notification: {
          title: "مرسوله به خریدار تحویل شد",
          message:
            "تحویل مرسوله‌ی تیپاکس این سفارش ثبت شد؛ مبلغ اقلام آن پس از دوره‌ی تسویه قابل برداشت می‌شود.",
          link: `/pharmacypanel/order/${orderId}`,
        },
        once: `delivered:${idOf(shipment._id)}`,
      },
    );
};

// ------------------------------------------------------- problem reported

export type ProblemResult =
  | { ok: true; ticket?: string }
  | { ok: false; status: number; error: string };

// «مرسوله نرسیده»: the buyer's parcel is late or lost. Once per parcel; it
// pauses the auto-confirm, opens a high-priority support ticket for the
// buyer (they follow it from their tickets page) and tells the pharmacy.
export const reportShipmentProblem = async ({
  orderId,
  shipmentId,
  user,
  note,
}: {
  orderId: string;
  shipmentId: string;
  user: { _id: unknown; phone?: string };
  note?: string;
}): Promise<ProblemResult> => {
  const text = String(note || "").trim().slice(0, 1000);
  const claimed = (await Order.findOneAndUpdate(
    {
      _id: orderId,
      user: idOf(user._id),
      status: "paid",
      shipments: {
        $elemMatch: { ...openShipment(shipmentId), "problem.reportedAt": { $exists: false } },
      },
    },
    {
      $set: {
        "shipments.$.problem": { reportedAt: new Date(), ...(text ? { note: text } : {}) },
      },
    },
    { new: true },
  )) as unknown as IOrder | null;
  if (!claimed)
    return { ok: false, status: 409, error: "این مرسوله دیگر در راه نیست یا مشکل آن پیش‌تر گزارش شده است" };
  const shipment = (claimed.shipments || []).find((s) => idOf(s._id) === shipmentId);
  const pharmacy = await pharmacyOf(shipment?.pharmacy);
  const title = `مرسوله‌ی سفارش ${shortId(orderId)} نرسیده است`;
  let ticketId = "";
  try {
    const ticket = await Ticket.create({
      title,
      subject: "GeneralInquiry",
      submittedBy: idOf(user._id),
      priority: "high",
    });
    ticketId = String(ticket._id);
    await TicketMessage.create({
      ticket: ticket._id,
      isAdmin: false,
      content: [
        `سفارش: ${orderId}`,
        `داروخانه: ${pharmacy?.name || "-"}`,
        `کد رهگیری تیپاکس: ${shipment?.trackingCode || "-"}`,
        text,
      ]
        .filter(Boolean)
        .join("\n"),
    });
    await Order.updateOne(
      { _id: orderId, "shipments._id": shipmentId },
      { $set: { "shipments.$.problem.ticket": ticket._id } },
    );
    notifyUserAlertSubscribers(
      "newTicket",
      { title: "تیکت پشتیبانی", message: `خریدار گزارش داد مرسوله‌ی سفارش ${shortId(orderId)} نرسیده است.` },
      { ticketId, userPhone: user.phone || "", ticketTitle: title },
    ).catch(() => undefined);
  } catch (err) {
    console.log("[delivery] problem ticket failed:", err);
  }
  if (pharmacy?.user)
    notifyWithSms(
      "orderDeliveryProblemSeller",
      idOf(pharmacy.user),
      { orderId: String(orderId) },
      {
        notification: {
          title: "خریدار گزارش داد مرسوله نرسیده است",
          message:
            "پشتیبانی پیگیری می‌کند و تأیید خودکار تحویل متوقف شد. وضعیت مرسوله را از تیپاکس پیگیری کنید.",
          link: `/pharmacypanel/order/${orderId}`,
        },
      },
    );
  return { ok: true, ...(ticketId ? { ticket: ticketId } : {}) };
};

// ---------------------------------------------------------------- returned

// Support: the parcel was lost or sent back. Every line still in it
// (prepared or not) is cancelled and refunded to the buyer through the
// shared settlement. A line whose payout already went out (an order from
// before delivery confirmation existed) is not undone here - that is a
// refund decision, not a delivery state - so the action refuses.
export const returnShipment = async ({
  orderId,
  shipmentId,
  note,
}: {
  orderId: string;
  shipmentId: string;
  note: Record<string, unknown>;
}): Promise<{ ok: true; cancelled: number } | { ok: false; status: number; error: string }> => {
  const order = (await Order.findOne({ _id: orderId, status: "paid" }).lean()) as unknown as IOrder | null;
  const shipment = (order?.shipments || []).find((s) => idOf(s._id) === shipmentId);
  if (!order || !shipment || shipment.method !== "tipax")
    return { ok: false, status: 404, error: "مرسوله پیدا نشد" };
  if (shipment.deliveredAt || shipment.returnedAt)
    return { ok: false, status: 409, error: "این مرسوله پیش‌تر تحویل یا برگشت ثبت شده است" };
  const lines = await linesOfShipment(order, shipment);
  const open = lines.filter(({ line }) => line.status !== "cancelled");
  if (
    open.length &&
    (await Transaction.exists({
      order: order._id,
      orderItem: { $in: open.map(({ line }) => line._id) },
      user: { $ne: order.user },
    }))
  )
    return {
      ok: false,
      status: 409,
      error: "مبلغ اقلام این مرسوله پیش‌تر به داروخانه پرداخت شده است؛ برگشت آن را از بازپرداخت پیگیری کنید",
    };
  const claimed = await Order.findOneAndUpdate(
    {
      _id: orderId,
      status: "paid",
      shipments: {
        $elemMatch: {
          _id: shipmentId,
          method: "tipax",
          deliveredAt: { $exists: false },
          returnedAt: { $exists: false },
        },
      },
    },
    { $set: { "shipments.$.returnedAt": new Date() }, $push: { adminNotes: note } },
    { new: true },
  );
  if (!claimed)
    return { ok: false, status: 409, error: "این مرسوله پیش‌تر تحویل یا برگشت ثبت شده است" };
  let cancelled = 0;
  for (const { model, line } of open) {
    // a prepared line leaves "fulfilled" only here: the parcel never
    // arrived and its seller was never paid (checked above)
    const updated = (await Order.findOneAndUpdate(
      {
        _id: orderId,
        status: "paid",
        [model]: { $elemMatch: { _id: line._id, status: { $in: ["pending", "fulfilled"] } } },
      },
      { $set: { [`${model}.$.status`]: "cancelled" } },
      { new: true },
    )) as unknown as IOrder | null;
    if (!updated) continue;
    cancelled++;
    await settleOrderLine({ order: updated, model, itemId: idOf(line.item) });
  }
  const pharmacy = await pharmacyOf(shipment.pharmacy);
  if (pharmacy?.user)
    await Notification.create({
      user: idOf(pharmacy.user),
      source: "System",
      title: "پشتیبانی مرسوله را برگشتی ثبت کرد",
      message: "مرسوله‌ی تیپاکس این سفارش گم‌شده یا برگشتی ثبت شد و مبلغ اقلام آن به خریدار برگشت.",
      link: `/pharmacypanel/order/${orderId}`,
    }).catch(() => undefined);
  return { ok: true, cancelled };
};

// ------------------------------------------------------ auto-confirm sweep

export const runShipmentAutoConfirmSweep = async (now: Date = new Date()): Promise<number> => {
  const due = await Order.find({
    status: "paid",
    shipments: {
      $elemMatch: {
        method: "tipax",
        shippedAt: { $exists: true },
        deliveredAt: { $exists: false },
        returnedAt: { $exists: false },
        "problem.reportedAt": { $exists: false },
        confirmBy: { $lte: now },
      },
    },
  })
    .select("_id shipments")
    .limit(200)
    .lean();
  let confirmed = 0;
  for (const order of due)
    for (const s of (order.shipments || []) as Shipment[])
      if (
        s.method === "tipax" &&
        s.shippedAt &&
        !s.deliveredAt &&
        !s.returnedAt &&
        !s.problem?.reportedAt &&
        s.confirmBy &&
        new Date(s.confirmBy) <= now
      )
        if (await confirmShipmentDelivered({ orderId: order._id, shipmentId: s._id, by: "auto", now }))
          confirmed++;
  if (confirmed) console.log(`[delivery] ${confirmed} Tipax shipment(s) auto-confirmed delivered`);
  return confirmed;
};

// hourly, one run at a time
export const startShipmentDeliveryJob = (intervalMs = 60 * 60 * 1000): void => {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    runShipmentAutoConfirmSweep()
      .catch((err) => console.log("[delivery] auto-confirm sweep failed:", err))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(run, 60 * 1000).unref?.();
  setInterval(run, intervalMs).unref?.();
};

// ----------------------------------------------------------- the migration

// Parcels from before delivery confirmation (2026-10), idempotent:
//   sent, no `confirmBy` yet -> older than the auto window: delivered
//     ("migration", quietly - their lines were paid when fulfilled);
//     inside it: its window starts (confirmBy = sent + the auto days)
//   never sent, but a line of it was already paid out at fulfilment (the
//     old rule) and the order is older than the window -> delivered
//     ("migration"); a younger one waits for the pharmacy to send it
export const migrateShipmentDelivery = async (now: Date = new Date()): Promise<void> => {
  const { tipaxAutoConfirmDays } = await getDeliverySettings();
  const windowMs = tipaxAutoConfirmDays * DAY_MS;
  let started = 0;
  let delivered = 0;

  const sent = await Order.find({
    shipments: {
      $elemMatch: {
        method: "tipax",
        shippedAt: { $exists: true },
        confirmBy: { $exists: false },
        deliveredAt: { $exists: false },
        returnedAt: { $exists: false },
      },
    },
  })
    .select("_id status shipments")
    .lean();
  for (const order of sent)
    for (const s of (order.shipments || []) as Shipment[]) {
      if (s.method !== "tipax" || !s.shippedAt || s.confirmBy || s.deliveredAt || s.returnedAt) continue;
      const confirmBy = new Date(new Date(s.shippedAt).getTime() + windowMs);
      await Order.updateOne(
        { _id: order._id, shipments: { $elemMatch: { _id: s._id, confirmBy: { $exists: false } } } },
        { $set: { "shipments.$.confirmBy": confirmBy } },
      );
      if (confirmBy <= now && order.status === "paid") {
        if (await confirmShipmentDelivered({ orderId: order._id, shipmentId: s._id, by: "migration", now: confirmBy }))
          delivered++;
      } else started++;
    }

  const cutoff = new Date(now.getTime() - windowMs);
  const unsent = (await Order.find({
    status: "paid",
    paidAt: { $lte: cutoff },
    shipments: {
      $elemMatch: {
        method: "tipax",
        shippedAt: { $exists: false },
        deliveredAt: { $exists: false },
        returnedAt: { $exists: false },
      },
    },
  }).lean()) as unknown as IOrder[];
  for (const order of unsent)
    for (const s of order.shipments || []) {
      if (s.method !== "tipax" || s.shippedAt || s.deliveredAt || s.returnedAt) continue;
      const lines = (await linesOfShipment(order, s)).filter(({ line }) => line.status === "fulfilled");
      if (!lines.length) continue;
      const paidOut = await Transaction.exists({
        order: order._id,
        orderItem: { $in: lines.map(({ line }) => line._id) },
        user: { $ne: order.user },
      });
      if (!paidOut) continue;
      const done = await Order.updateOne(
        {
          _id: order._id,
          shipments: {
            $elemMatch: {
              _id: s._id,
              shippedAt: { $exists: false },
              deliveredAt: { $exists: false },
              returnedAt: { $exists: false },
            },
          },
        },
        { $set: { "shipments.$.deliveredAt": now, "shipments.$.deliveredBy": "migration" } },
      );
      if (done.modifiedCount) delivered++;
    }
  if (started || delivered)
    console.log(`[delivery] migration: ${delivered} older Tipax shipment(s) delivered, ${started} window(s) started`);
};
