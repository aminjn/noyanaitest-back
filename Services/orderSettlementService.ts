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

export const settleOrderLine = async ({
  order,
  model,
  itemId,
  sellerUserId,
  org,
}: {
  order: IOrder;
  model: OrderLineModel;
  itemId: string;
  // the org's owner account (a populated User or its id)
  sellerUserId?: unknown;
  org?: OrgRef;
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
    await credit(sellerId, lineTotal);
    await Transaction.create({
      user: sellerId,
      amount: lineTotal,
      order: order._id,
      orderItem: line._id,
      ...(org || {}),
    });
    await Notification.create({
      user: buyerId,
      source: "System",
      title: "بخشی از سفارش شما آماده شد",
      message: "فروشنده یک قلم از سفارش شما را آماده و تحویل کرد.",
      link,
    }).catch(() => {});
    return;
  }

  if (line.status === "cancelled") {
    // the line's share of the order's tax goes back with it
    const taxShare =
      order.subtotal > 0 && order.tax > 0
        ? Math.round((order.tax * lineTotal) / order.subtotal)
        : 0;
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
      title: "یک قلم از سفارش شما لغو شد",
      message: "مبلغ این قلم به کیف پول شما برگشت.",
      link,
    }).catch(() => {});
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

// The buyer cancelled a line before it was prepared: tell the seller not to
// ship it. Best effort - a lookup miss never blocks the refund.
export const notifySellerOfBuyerCancel = async (
  orderId: unknown,
  model: OrderLineModel,
  itemId: string,
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
      title: "خریدار سفارش را لغو کرد",
      message: "یکی از اقلام سفارش پیش از آماده‌سازی توسط خریدار لغو شد؛ آن را ارسال نکنید.",
      link: `${sellerPanelLink[owner.org]}/${String(orderId)}`,
    });
  } catch {
    // ignore
  }
};
