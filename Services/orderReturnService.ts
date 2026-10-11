import mongoose from "mongoose";
import Order, { IOrder } from "../Models/Order";
import OrderReturn, {
  IOrderReturn,
  openReturnStatuses,
  OrderRefundReason,
  OrderReturnReason,
  orderRefundReasons,
  ReturnCondition,
  ReturnLineModel,
} from "../Models/OrderReturn";
import ReturnEscalation, { IReturnEscalation } from "../Models/ReturnEscalation";
import Transaction from "../Models/Transaction";
import UserFile from "../Models/UserFile";
import Notification from "../Models/Notification";
import BizClaim from "../Models/BizClaim";
import { claimStatus } from "../Lib/business/payments";
import { postClaimCredits } from "../Lib/business/insurerClaims";
import BizVoucher from "../Models/BizVoucher";
import BizClubSettings from "../Models/BizClubSettings";
import { LicensePromotionRedemption } from "../Models/LicensePromotion";
import { getDeliverySettings } from "../Lib/delivery";
import { takeFromHeld } from "../Lib/payoutHold";
import { creditScope, personalScope } from "../Lib/walletScope";
import { keptLine, money } from "../Lib/orderLineMoney";
import { planPromoOnReturn, OrderLineModelName } from "../Lib/orderPromoRecheck";
import { settlePromoAdjustments } from "../Lib/orderPromoAdjust";
import { releaseOrderPromo } from "../Lib/cartOffers";
import { defaultIncomeRole, postDoc } from "../Lib/business/finance";
import { returnOrderLineStock } from "../Lib/business/inventory";
import { syncContacts } from "../Lib/business/crm";
import { BizOwner } from "../Lib/business/coa";
import {
  earningOfLine,
  getReturnSettings,
  isSellerFault,
  lineOf,
  LineSeller,
  REFUND_MODELS,
  RETURN_MODELS,
  returnOptionsOf,
  sellerOfLine,
  shareOfReturn,
} from "../Lib/orderReturns";
import { notifyWithSms, smsAmount } from "./notificationSmsService";
import { notifyUserAlertSubscribers } from "./userAlertService";
import { recordPendingSettlement } from "./settlementRetryService";

// Returns of delivered goods and refunds of done services (2026-10, owner
// decision). Benchmark: Digikala «مرجوعی» (request per item and quantity
// within days of delivery, with a reason and photos; the seller decides,
// support arbitrates; the refund lands once the item is back and checked),
// Snapp Pharmacy / Halodoc (medicines: prescription and cold-chain items
// only for the pharmacy's error), Amazon (return shipping paid by the
// seller for its own error, by the buyer otherwise - here kept off the
// refund). What NoyanAI does more: the refund is a proportional reversal of
// the seller's earning (commission given back, VAT out of its VAT payable)
// taken from the earning the platform still holds - a seller is never in
// debt (2026-10 owner decision, Digikala's model: a pharmacy line is paid
// out only after its return window, Lib/payoutHold.ts); a refund that
// comes after the payout (support's goodwill, a lab's refund) is taken
// from the seller's other held earnings, and what they can not cover is
// the platform's loss, flagged to the super admin. A seller-error return of
// the whole parcel gives the buyer the delivery fee back too. The discount
// code is re-checked on what the buyer keeps, the insurer's share and the
// stock batch go back, and the seller's Moadian invoice gets its
// «برگشت از فروش» (Lib/moadian/issue.ts) - all in both sets of books.
//
// Every transition is one conditional update on OrderReturn.status (see
// Models/OrderReturn.ts). The units a return holds are counted on the
// order line (returnHeldQty = units in open returns + units returned), so
// two requests can never claim more than the line has.

export type ServiceResult<T = unknown> = { ok: true; data?: T } | { ok: false; status: number; error: string };

const fail = (status: number, error: string): ServiceResult<never> => ({ ok: false, status, error });

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");
const oid = (v: unknown) => new mongoose.Types.ObjectId(idOf(v));
const shortId = (v: unknown) => idOf(v).slice(-8);

type Actor = { kind: "buyer" | "seller" | "admin" | "system"; user?: unknown };

const historyOf = (action: string, actor: Actor, note?: string) => ({
  action,
  byKind: actor.kind,
  ...(actor.user && mongoose.isValidObjectId(idOf(actor.user)) ? { by: oid(actor.user) } : {}),
  ...(note ? { note: String(note).slice(0, 1000) } : {}),
  at: new Date(),
});

const orderLink = (orderId: unknown) => `/order/${idOf(orderId)}`;
const sellerLink = (kind: string, orderId: unknown) =>
  `${kind === "paraClinic" ? "/paraClinicPanel/order" : "/pharmacypanel/order"}/${idOf(orderId)}`;

// ------------------------------------------------------- holding units

// claim `qty` more units of the line for a return (atomic)
const claimUnits = async (orderId: unknown, model: string, lineId: string, lineQty: number, qty: number) => {
  const res = await Order.updateOne(
    {
      _id: orderId,
      status: "paid",
      [model]: {
        $elemMatch: {
          _id: oid(lineId),
          status: "fulfilled",
          qty: lineQty,
          $or: [{ returnHeldQty: { $exists: false } }, { returnHeldQty: { $lte: lineQty - qty } }],
        },
      },
    },
    { $inc: { [`${model}.$.returnHeldQty`]: qty } },
  );
  return res.modifiedCount === 1;
};

// give units back (a request cancelled or finally declined)
const releaseUnits = async (orderId: unknown, model: string, lineId: unknown, qty: number) => {
  await Order.updateOne(
    { _id: orderId, [model]: { $elemMatch: { _id: oid(lineId), returnHeldQty: { $gte: qty } } } },
    { $inc: { [`${model}.$.returnHeldQty`]: -qty } },
  );
};

// ------------------------------------------------------------ shipping

// How a pharmacy return comes back: the order's own way (Lib/delivery.ts).
//   tapsi (same city)  the pharmacy sends a courier to collect it; a
//                      buyer-fault return pays its flat fee (kept off the
//                      refund, paid to the pharmacy), the seller's error
//                      is the pharmacy's cost
//   tipax (inter-city) the buyer sends it; the seller's error goes
//                      «پس‌کرایه» (the pharmacy pays Tipax on receipt), the
//                      buyer's choice is paid by the buyer at the counter
const shippingPlan = async (order: Pick<IOrder, "shipments">, sellerId: string, sellerFault: boolean) => {
  const shipment = (order.shipments || []).find((s) => idOf(s.pharmacy) === sellerId);
  const method: "tapsi" | "tipax" | "inPerson" =
    shipment?.method === "tapsi" ? "tapsi" : shipment?.method === "tipax" ? "tipax" : "inPerson";
  const { tapsiFlatFee } = await getDeliverySettings();
  return {
    method,
    paidBy: sellerFault ? ("seller" as const) : ("buyer" as const),
    fee: method === "tapsi" && !sellerFault ? Math.max(0, Math.round(Number(tapsiFlatFee) || 0)) : 0,
  };
};

// ----------------------------------------------------------- notices

const notifySellerOf = async (ret: Pick<IOrderReturn, "sellerKind" | "seller" | "order">, title: string, message: string) => {
  const seller = await mongoose
    .model(ret.sellerKind === "paraClinic" ? "ParaClinic" : "Pharmacy")
    .findById(ret.seller)
    .select("user")
    .lean<{ user?: unknown }>();
  if (!seller?.user) return null;
  await Notification.create({
    user: idOf(seller.user),
    source: "System",
    title,
    message,
    link: sellerLink(ret.sellerKind, ret.order),
  }).catch(() => undefined);
  return idOf(seller.user);
};

const sellerName = async (ret: Pick<IOrderReturn, "sellerKind" | "seller">) =>
  (
    await mongoose
      .model(ret.sellerKind === "paraClinic" ? "ParaClinic" : "Pharmacy")
      .findById(ret.seller)
      .select("name")
      .lean<{ name?: string }>()
  )?.name || "";

// ------------------------------------------------------------- request

export type ReturnRequestInput = {
  orderId: string;
  user: unknown;
  model: string;
  lineId: string;
  qty: number;
  reason: OrderReturnReason;
  note?: string;
  photos?: string[];
  unopened?: boolean;
};

const blockedText: Record<string, string> = {
  notDelivered: "این قلم هنوز به دست شما نرسیده است",
  noWindow: "مرجوع کردن کالا فعلاً ممکن نیست",
  windowClosed: "مهلت مرجوع کردن این قلم تمام شده است",
  allReturned: "همه‌ی این قلم مرجوع شده یا درخواست مرجوعی دارد",
};

export const requestReturn = async (input: ReturnRequestInput): Promise<ServiceResult<IOrderReturn>> => {
  if (!(RETURN_MODELS as readonly string[]).includes(input.model)) return fail(400, "این قلم سفارش مرجوع‌شدنی نیست");
  if (!mongoose.isValidObjectId(input.orderId) || !mongoose.isValidObjectId(input.lineId))
    return fail(404, "این قلم سفارش پیدا نشد");
  const order = await Order.findOne({ _id: input.orderId, user: idOf(input.user) }).lean<IOrder>();
  if (!order) return fail(404, "این قلم سفارش پیدا نشد");
  const option = (await returnOptionsOf(order)).find((o) => o.model === input.model && o.line === input.lineId);
  if (!option) return fail(404, "این قلم سفارش مرجوع‌شدنی نیست");
  if (option.blocked) return fail(409, blockedText[option.blocked]);
  if (!option.reasons.includes(input.reason))
    return fail(
      400,
      "این کالا فقط در صورت خطای فروشنده پس گرفته می‌شود (داروی نسخه‌ای، زنجیره‌ی سرد یا کالای غیرقابل مرجوع)",
    );
  if (input.reason === "changedMind" && !input.unopened)
    return fail(400, "برای انصراف از خرید، کالا باید باز نشده و سالم باشد");
  const qty = Math.round(Number(input.qty) || 0);
  if (qty < 1 || qty > option.available) return fail(400, "تعداد مرجوعی از تعداد قابل مرجوع بیشتر است");
  const photos = [...new Set((input.photos || []).filter((p) => mongoose.isValidObjectId(p)))].slice(0, 6);
  const sellerFault = isSellerFault(input.reason);
  if (sellerFault && !photos.length) return fail(400, "برای این دلیل دست‌کم یک عکس از کالا بفرستید");
  if (photos.length) {
    const owned = await UserFile.countDocuments({
      _id: { $in: photos },
      chatPath: "Order",
      readers: idOf(input.user),
      chat: { $exists: false },
    });
    if (owned !== photos.length) return fail(400, "عکس‌های مرجوعی معتبر نیستند؛ دوباره بارگذاری کنید");
  }
  const seller = await sellerOfLine(input.model as ReturnLineModel, option.item);
  if (!seller) return fail(409, "فروشنده‌ی این قلم پیدا نشد؛ با پشتیبانی تماس بگیرید");
  if (!(await claimUnits(order._id, input.model, input.lineId, option.qty, qty)))
    return fail(409, blockedText.allReturned);
  let ret: IOrderReturn;
  try {
    ret = (
      await OrderReturn.create({
        order: order._id,
        user: order.user,
        sellerKind: seller.kind,
        seller: seller.id,
        model: input.model,
        line: input.lineId,
        item: option.item,
        qty,
        kind: "return",
        initiatedBy: "buyer",
        reason: input.reason,
        note: String(input.note || "").trim().slice(0, 1000) || undefined,
        photos,
        unopened: input.reason === "changedMind" ? true : undefined,
        sellerFault,
        status: "requested",
        history: [historyOf("requested", { kind: "buyer", user: input.user }, input.note)],
      })
    ).toObject() as IOrderReturn;
  } catch (err) {
    await releaseUnits(order._id, input.model, input.lineId, qty);
    throw err;
  }
  // the photos belong to the order now: the buyer, the seller's owner (and
  // its staff and support, notPublicController) read them
  if (photos.length)
    await UserFile.updateMany(
      { _id: { $in: photos }, chat: { $exists: false } },
      { $set: { chat: order._id, chatPath: "Order" }, ...(seller.user ? { $addToSet: { readers: seller.user } } : {}) },
    );
  if (seller.user) {
    await Notification.create({
      user: seller.user,
      source: "System",
      title: "درخواست مرجوعی تازه",
      message: "خریدار برای یک قلم از سفارش درخواست مرجوعی داد؛ آن را بررسی و تأیید یا رد کنید.",
      link: sellerLink(seller.kind, order._id),
    }).catch(() => undefined);
    notifyWithSms("returnRequestedSeller", seller.user, { orderId: shortId(order._id) }, { once: `return:${idOf(ret._id)}` });
  }
  return { ok: true, data: ret };
};

// the buyer withdraws a request not sent back yet (or accepts a "no")
export const cancelReturn = async (returnId: string, user: unknown): Promise<ServiceResult> => {
  if (!mongoose.isValidObjectId(returnId)) return fail(404, "درخواست مرجوعی پیدا نشد");
  const ret = await OrderReturn.findOneAndUpdate(
    { _id: returnId, user: idOf(user), kind: "return", status: { $in: ["requested", "approved", "rejected"] } },
    { $set: { status: "cancelled" }, $push: { history: historyOf("cancelled", { kind: "buyer", user }) } },
    { new: true },
  ).lean<IOrderReturn>();
  if (!ret) return fail(409, "این درخواست مرجوعی دیگر لغوشدنی نیست");
  await releaseUnits(ret.order, ret.model, ret.line, ret.qty);
  return { ok: true };
};

// ------------------------------------------------------ the seller's say

const sellerMatch = (seller: { kind: string; id: unknown }) => ({ sellerKind: seller.kind, seller: idOf(seller.id) });

export const sellerDecideReturn = async (
  returnId: string,
  seller: { kind: "pharmacy" | "paraClinic"; id: unknown },
  decision: "approve" | "reject",
  by: unknown,
  reason?: string,
): Promise<ServiceResult> => {
  if (!mongoose.isValidObjectId(returnId)) return fail(404, "درخواست مرجوعی پیدا نشد");
  const current = await OrderReturn.findOne({ _id: returnId, ...sellerMatch(seller) }).lean<IOrderReturn>();
  if (!current) return fail(404, "درخواست مرجوعی پیدا نشد");
  if (current.status !== "requested") return fail(409, "این درخواست مرجوعی پیش‌تر بررسی شده است");
  if (decision === "reject") {
    const text = String(reason || "").trim();
    if (text.length < 3) return fail(400, "دلیل رد درخواست را بنویسید (دست‌کم ۳ حرف)");
    const ret = await OrderReturn.findOneAndUpdate(
      { _id: returnId, ...sellerMatch(seller), status: "requested" },
      { $set: { status: "rejected", rejectReason: text.slice(0, 500) }, $push: { history: historyOf("rejected", { kind: "seller", user: by }, text) } },
      { new: true },
    ).lean<IOrderReturn>();
    if (!ret) return fail(409, "این درخواست مرجوعی پیش‌تر بررسی شده است");
    const name = await sellerName(ret);
    await Notification.create({
      user: ret.user,
      source: "System",
      title: "درخواست مرجوعی شما رد شد",
      message: `«${name}» درخواست مرجوعی شما را نپذیرفت. دلیل: ${text}. اگر قبول ندارید، از صفحه‌ی سفارش آن را برای بررسی به پشتیبانی بفرستید.`,
      link: orderLink(ret.order),
    }).catch(() => undefined);
    notifyWithSms("returnRejectedUser", ret.user, { orderId: shortId(ret.order), reason: text }, { once: `returnRejected:${idOf(ret._id)}` });
    return { ok: true };
  }
  return approveReturn(current, { kind: "seller", user: by }, ["requested"]);
};

// requested / escalated -> approved: how the goods come back is fixed now
const approveReturn = async (current: IOrderReturn, actor: Actor, from: string[]): Promise<ServiceResult> => {
  const order = await Order.findById(current.order).select("shipments").lean<IOrder>();
  if (!order) return fail(404, "سفارش پیدا نشد");
  const shipping = await shippingPlan(order, idOf(current.seller), current.sellerFault);
  const ret = await OrderReturn.findOneAndUpdate(
    { _id: current._id, status: { $in: from } },
    { $set: { status: "approved", shipping }, $unset: { rejectReason: 1 }, $push: { history: historyOf("approved", actor) } },
    { new: true },
  ).lean<IOrderReturn>();
  if (!ret) return fail(409, "این درخواست مرجوعی پیش‌تر بررسی شده است");
  // who said yes: the seller, or support overruling its "no"
  const name = actor.kind === "admin" ? "پشتیبانی نویان" : await sellerName(ret);
  await Notification.create({
    user: ret.user,
    source: "System",
    title: "درخواست مرجوعی شما تأیید شد",
    message:
      shipping.method === "tapsi"
        ? `«${name}» مرجوعی را پذیرفت؛ پیک برای تحویل گرفتن کالا با شما هماهنگ می‌کند.`
        : shipping.paidBy === "seller"
          ? `«${name}» مرجوعی را پذیرفت؛ کالا را پس‌کرایه با تیپاکس بفرستید و کد رهگیری را در صفحه‌ی سفارش ثبت کنید.`
          : `«${name}» مرجوعی را پذیرفت؛ کالا را با تیپاکس بفرستید و کد رهگیری را در صفحه‌ی سفارش ثبت کنید.`,
    link: orderLink(ret.order),
  }).catch(() => undefined);
  notifyWithSms("returnApprovedUser", ret.user, { orderId: shortId(ret.order), sellerName: name }, { once: `returnApproved:${idOf(ret._id)}` });
  if (actor.kind === "admin")
    await notifySellerOf(
      ret,
      "پشتیبانی مرجوعی را تأیید کرد",
      "پشتیبانی درخواست مرجوعی یک قلم این سفارش را پذیرفت؛ کالا به شما برگردانده می‌شود. پس از دریافت، آن را در صفحه‌ی سفارش تأیید کنید.",
    );
  return { ok: true };
};

// --------------------------------------------------------- the way back

// the buyer sent it (Tipax waybill) / the pharmacy's courier picked it up
export const markReturnShipped = async (
  returnId: string,
  actor: { kind: "buyer"; user: unknown } | { kind: "seller"; user: unknown; seller: { kind: string; id: unknown } },
  trackingCode?: string,
): Promise<ServiceResult> => {
  if (!mongoose.isValidObjectId(returnId)) return fail(404, "درخواست مرجوعی پیدا نشد");
  const code = String(trackingCode || "").trim().slice(0, 200);
  const match: Record<string, unknown> =
    actor.kind === "buyer"
      ? { _id: returnId, user: idOf(actor.user), status: "approved", "shipping.method": { $in: ["tipax", "inPerson"] } }
      : { _id: returnId, ...sellerMatch(actor.seller), status: "approved", "shipping.method": "tapsi" };
  if (actor.kind === "buyer" && !code) {
    const probe = await OrderReturn.findOne(match).select("shipping.method").lean<IOrderReturn>();
    if (probe?.shipping?.method === "tipax") return fail(400, "کد رهگیری تیپاکس را وارد کنید");
  }
  const ret = await OrderReturn.findOneAndUpdate(
    match,
    {
      $set: { status: "shipped", "shipping.shippedAt": new Date(), ...(code ? { "shipping.trackingCode": code } : {}) },
      $push: { history: historyOf("shipped", actor, code) },
    },
    { new: true },
  ).lean<IOrderReturn>();
  if (!ret) return fail(409, "ارسال این مرجوعی پیش‌تر ثبت شده یا هنوز تأیید نشده است");
  if (actor.kind === "buyer")
    await notifySellerOf(
      ret,
      "کالای مرجوعی ارسال شد",
      "خریدار کالای مرجوعی را فرستاد؛ پس از دریافت و بررسی، دریافت آن را در صفحه‌ی سفارش تأیید کنید تا مبلغش به خریدار برگردد.",
    );
  else
    await Notification.create({
      user: ret.user,
      source: "System",
      title: "پیک برای کالای مرجوعی فرستاده شد",
      message: "پیک فروشنده برای تحویل گرفتن کالای مرجوعی در راه است.",
      link: orderLink(ret.order),
    }).catch(() => undefined);
  return { ok: true };
};

// The seller has the goods back (or support says so): the refund is made.
export const receiveReturn = async (
  returnId: string,
  actor: Actor & { seller?: { kind: string; id: unknown } },
  condition?: ReturnCondition,
): Promise<ServiceResult> => {
  if (!mongoose.isValidObjectId(returnId)) return fail(404, "درخواست مرجوعی پیدا نشد");
  const filter: Record<string, unknown> = {
    _id: returnId,
    kind: "return",
    status: { $in: actor.kind === "admin" ? ["approved", "shipped", "escalated"] : ["approved", "shipped"] },
    ...(actor.seller ? sellerMatch(actor.seller) : {}),
  };
  const current = await OrderReturn.findOne(filter).lean<IOrderReturn>();
  if (!current) return fail(409, "این مرجوعی آماده‌ی تأیید دریافت نیست");
  // damaged or expired goods are written off; otherwise back on the shelf
  const cond: ReturnCondition =
    condition === "damaged" || condition === "resellable"
      ? condition
      : current.reason === "damaged" || current.reason === "expired"
        ? "damaged"
        : "resellable";
  const now = new Date();
  const ret = await OrderReturn.findOneAndUpdate(
    filter,
    {
      $set: { status: "refunded", receivedAt: now, condition: cond, refundedAt: now },
      $push: { history: historyOf("received", actor, cond) },
    },
    { new: true },
  ).lean<IOrderReturn>();
  if (!ret) return fail(409, "این مرجوعی آماده‌ی تأیید دریافت نیست");
  await settleReturnSafely(ret._id);
  return { ok: true };
};

// ------------------------------------------- a refund with nothing back

// A lab's refund of a test it performed, or support's refund of a
// delivered line (goods not returned): the money goes back now.
export const refundOrderLine = async (input: {
  orderId: string;
  model: string;
  lineId: string;
  qty: number;
  reason: OrderRefundReason;
  note: string;
  actor: Actor;
  // the lab refunding its own line
  seller?: { kind: "pharmacy" | "paraClinic"; id: unknown };
}): Promise<ServiceResult<IOrderReturn>> => {
  if (!(REFUND_MODELS as readonly string[]).includes(input.model)) return fail(400, "این قلم سفارش بازپرداخت‌شدنی نیست");
  if (!(orderRefundReasons as readonly string[]).includes(input.reason)) return fail(400, "دلیل بازپرداخت را انتخاب کنید");
  const note = String(input.note || "").trim();
  if (note.length < 3) return fail(400, "دلیل بازپرداخت را بنویسید (دست‌کم ۳ حرف)");
  if (!mongoose.isValidObjectId(input.orderId) || !mongoose.isValidObjectId(input.lineId)) return fail(404, "این قلم سفارش پیدا نشد");
  const order = await Order.findOne({ _id: input.orderId, status: "paid" }).lean<IOrder>();
  const line = order ? lineOf(order, input.model, input.lineId) : null;
  if (!order || !line) return fail(404, "این قلم سفارش پیدا نشد");
  if (line.status !== "fulfilled") return fail(409, "فقط قلمِ انجام‌شده بازپرداخت می‌شود؛ قلم در انتظار را لغو کنید");
  const seller = await sellerOfLine(input.model as ReturnLineModel, line.item);
  if (!seller) return fail(409, "فروشنده‌ی این قلم پیدا نشد");
  if (input.seller && (input.seller.kind !== seller.kind || idOf(input.seller.id) !== seller.id))
    return fail(404, "این قلم سفارش پیدا نشد");
  if (!(await earningOfLine(order._id, line._id, order.user)))
    return fail(409, "این قلم هنوز تسویه نشده است؛ پس از تحویل بازپرداخت می‌شود");
  const qty = Math.round(Number(input.qty) || 0);
  const free = (Number(line.qty) || 0) - money(line.returnHeldQty);
  if (qty < 1 || qty > free) return fail(400, "تعداد بازپرداخت از تعداد قابل بازپرداخت بیشتر است");
  if (!(await claimUnits(order._id, input.model, input.lineId, Number(line.qty) || 0, qty)))
    return fail(409, "همه‌ی این قلم مرجوع یا بازپرداخت شده است");
  let ret: IOrderReturn;
  try {
    const now = new Date();
    ret = (
      await OrderReturn.create({
        order: order._id,
        user: order.user,
        sellerKind: seller.kind,
        seller: seller.id,
        model: input.model,
        line: line._id,
        item: idOf(line.item),
        qty,
        kind: "refund",
        initiatedBy: input.actor.kind === "seller" ? "seller" : "admin",
        reason: input.reason,
        note: note.slice(0, 1000),
        sellerFault: input.reason !== "goodwill",
        status: "refunded",
        refundedAt: now,
        history: [historyOf("refunded", input.actor, note)],
      })
    ).toObject() as IOrderReturn;
  } catch (err) {
    await releaseUnits(order._id, input.model, input.lineId, qty);
    throw err;
  }
  await settleReturnSafely(ret._id);
  if (input.actor.kind === "admin")
    await notifySellerOf(
      ret,
      "پشتیبانی بخشی از سفارش را بازپرداخت کرد",
      `پشتیبانی مبلغ یک قلم این سفارش را به خریدار برگرداند و درآمد آن از حساب شما برگشت. دلیل: ${note}`,
    );
  return { ok: true, data: ret };
};

// ----------------------------------------------------------- escalation

// the buyer takes the seller's "no" to support
export const escalateReturn = async (returnId: string, user: unknown, note?: string): Promise<ServiceResult> => {
  if (!mongoose.isValidObjectId(returnId)) return fail(404, "درخواست مرجوعی پیدا نشد");
  const ret = await OrderReturn.findOneAndUpdate(
    { _id: returnId, user: idOf(user), status: "rejected" },
    { $set: { status: "escalated" }, $push: { history: historyOf("escalated", { kind: "buyer", user }, note) } },
    { new: true },
  ).lean<IOrderReturn>();
  if (!ret) return fail(409, "فقط درخواست ردشده را می‌توان به پشتیبانی فرستاد");
  await openEscalation(ret, "buyer", String(note || "").trim().slice(0, 1000));
  return { ok: true };
};

const openEscalation = async (ret: IOrderReturn, raisedBy: "buyer" | "system", note: string) => {
  const esc = await ReturnEscalation.findOneAndUpdate(
    { orderReturn: ret._id },
    {
      $set: { status: "Pending", note: note || undefined, raisedBy },
      $unset: { rejectReason: 1, decidedAt: 1, decidedBy: 1 },
      $setOnInsert: { order: ret.order, user: ret.user, sellerKind: ret.sellerKind, seller: ret.seller },
    },
    { upsert: true, new: true },
  ).lean<IReturnEscalation>();
  await OrderReturn.updateOne({ _id: ret._id }, { $set: { escalation: esc._id } });
  notifyUserAlertSubscribers(
    "newReturnEscalation",
    {
      title: "مرجوعی برای داوری پشتیبانی",
      message: `مرجوعی سفارش ${shortId(ret.order)} منتظر تصمیم پشتیبانی است.`,
      link: `/notadmin/requests?group=return&open=${idOf(esc._id)}`,
    },
    { requestId: idOf(esc._id), orderId: shortId(ret.order) },
  ).catch(() => undefined);
  return esc;
};

// The queue's approve (Controllers/adminRequestsController.ts group
// "return"): the return goes ahead; if the goods are already back with the
// seller (it never confirmed receipt), the refund is made now.
export const approveEscalation = async (escalationId: string, by: unknown): Promise<ServiceResult> => {
  if (!mongoose.isValidObjectId(escalationId)) return fail(404, "درخواست پیدا نشد");
  const esc = await ReturnEscalation.findOneAndUpdate(
    { _id: escalationId, status: "Pending" },
    { $set: { status: "Approved", decidedAt: new Date(), decidedBy: idOf(by) } },
    { new: true },
  ).lean<IReturnEscalation>();
  if (!esc) return fail(409, "فقط درخواست در انتظار بررسی را می‌توان تأیید کرد");
  const ret = await OrderReturn.findById(esc.orderReturn).lean<IOrderReturn>();
  if (!ret || ret.status !== "escalated") return { ok: true };
  const goodsSent = !!ret.shipping?.shippedAt || ret.history.some((h) => h.action === "shipped");
  if (goodsSent) return receiveReturn(idOf(ret._id), { kind: "admin", user: by });
  return approveReturn(ret, { kind: "admin", user: by }, ["escalated"]);
};

// the queue's reject: the return is declined (the buyer is told why)
export const declineEscalated = async (esc: { orderReturn: unknown }, reason: string, by?: unknown) => {
  const ret = await OrderReturn.findOneAndUpdate(
    { _id: esc.orderReturn, status: "escalated" },
    { $set: { status: "declined", rejectReason: reason.slice(0, 500) }, $push: { history: historyOf("declined", { kind: "admin", user: by }, reason) } },
    { new: true },
  ).lean<IOrderReturn>();
  if (!ret) return;
  await releaseUnits(ret.order, ret.model, ret.line, ret.qty);
  await Notification.create({
    user: ret.user,
    source: "System",
    title: "پشتیبانی درخواست مرجوعی شما را نپذیرفت",
    message: `دلیل: ${reason}`,
    link: orderLink(ret.order),
  }).catch(() => undefined);
  notifyWithSms("returnRejectedUser", ret.user, { orderId: shortId(ret.order), reason }, { once: `returnDeclined:${idOf(ret._id)}` });
};

// the queue's reopen: back to support's desk - only while its units can
// still be held (refused when another request took them meanwhile)
export const reopenDeclined = async (esc: { orderReturn: unknown }): Promise<string | null> => {
  const ret = await OrderReturn.findById(esc.orderReturn).lean<IOrderReturn>();
  if (!ret || ret.status !== "declined") return null;
  const order = await Order.findById(ret.order).lean<IOrder>();
  const line = order ? lineOf(order, ret.model, idOf(ret.line)) : null;
  if (!order || !line || !(await claimUnits(order._id, ret.model, idOf(ret.line), Number(line.qty) || 0, ret.qty)))
    return "واحدهای این قلم دیگر آزاد نیستند؛ درخواست را نمی‌توان دوباره باز کرد";
  const done = await OrderReturn.updateOne(
    { _id: ret._id, status: "declined" },
    { $set: { status: "escalated" }, $unset: { rejectReason: 1 }, $push: { history: historyOf("reopened", { kind: "admin" }) } },
  );
  if (!done.modifiedCount) await releaseUnits(ret.order, ret.model, ret.line, ret.qty);
  return null;
};

// ---------------------------------------------------------------- money

// Runs the settlement and, if a step fails, queues it for the retry sweep
// (Services/settlementRetryService.ts kind "orderReturn"): the status
// change is saved, its money must follow.
export const settleReturnSafely = async (returnId: unknown) => {
  try {
    await settleReturn(returnId);
  } catch (err) {
    const ret = await OrderReturn.findById(returnId).select("order").lean<IOrderReturn>().catch(() => null);
    await recordPendingSettlement({ kind: "orderReturn", order: ret?.order, itemId: idOf(returnId) }, err);
  }
};

const isDup = (err: unknown) => (err as { code?: number })?.code === 11000;

const stamp = (returnId: unknown, step: string) =>
  OrderReturn.updateOne({ _id: returnId }, { $set: { [`steps.${step}`]: new Date() } });

const ORG_FIELD: Record<string, string> = { pharmacy: "pharmacy", paraClinic: "paraClinic" };

// The refund of a received return / a refund, idempotent step by step:
//   1 the returned units' share of the line and of the seller's earning
//     (written once, before anything changes)
//   2 the units counted as returned on the line
//   3 the discount code re-checked on what the buyer keeps (its plan
//     written once, then applied once); the kept lines already paid out are
//     adjusted (Lib/orderPromoAdjust.ts)
//   4 the seller's earning on the units reversed, out of its earnings
//     still held (the line's own first, Lib/payoutHold.ts takeFromHeld);
//     what they can not cover the platform absorbs - never a seller debt
//   5 the buyer refunded what they paid, less the discount no longer due
//     and a buyer-fault courier fee (paid to the pharmacy); a seller-error
//     return that leaves nothing of the parcel also refunds its delivery
//     fee, taken back from the pharmacy's held fee
//   6 the insurer's share taken back (an open claim line reduced, a sent
//     list credited)
//   7 the stock batch back (or written off), 8 the club points refreshed
export const settleReturn = async (returnId: unknown): Promise<void> => {
  let ret = await OrderReturn.findById(returnId).lean<IOrderReturn>();
  if (!ret || ret.status !== "refunded") return;
  const rid = ret._id;
  let order = await Order.findById(ret.order).lean<IOrder>();
  if (!order) return;
  let line = lineOf(order, ret.model, idOf(ret.line));
  if (!line) return;
  const seller: LineSeller | null = await sellerOfLine(ret.model, ret.item);
  const owner: BizOwner | null = seller ? { kind: seller.kind, id: seller.id } : null;

  // 1) the share
  if (!ret.share) {
    const share = await shareOfReturn(order, line, ret.qty);
    await OrderReturn.updateOne({ _id: rid, share: { $exists: false } }, { $set: { share } });
    ret = (await OrderReturn.findById(rid).lean<IOrderReturn>())!;
  }
  const share = ret.share!;

  // 2) counted on the line
  if (!ret.steps?.applied) {
    await Order.updateOne(
      { _id: order._id, [ret.model]: { $elemMatch: { _id: ret.line, returnsApplied: { $ne: rid } } } },
      {
        $inc: {
          [`${ret.model}.$.returned.qty`]: ret.qty,
          [`${ret.model}.$.returned.lineTotal`]: share.lineTotal,
          [`${ret.model}.$.returned.club`]: share.club,
          [`${ret.model}.$.returned.promo`]: share.promo,
          [`${ret.model}.$.returned.insurer`]: share.insurer,
          [`${ret.model}.$.returned.tax`]: share.tax,
          [`${ret.model}.$.returned.paid`]: share.paid,
        },
        $push: { [`${ret.model}.$.returnsApplied`]: rid },
      },
    );
    await stamp(rid, "applied");
    order = (await Order.findById(ret.order).lean<IOrder>())!;
    line = lineOf(order, ret.model, idOf(ret.line))!;
  }

  // what the buyer pays for the way back (a buyer-fault Tapsi pickup)
  const shippingDeduction =
    ret.kind === "return" && ret.shipping?.paidBy === "buyer" && ret.shipping.method === "tapsi"
      ? Math.min(money(ret.shipping.fee), share.paid)
      : 0;

  // 3) the discount code on what is left
  if (!ret.promoPlan) {
    const plan = order.promo
      ? await planPromoOnReturn(
          order as never,
          ret.model as OrderLineModelName,
          { qty: ret.qty, price: line.price, club: share.club, promo: share.promo, insurer: share.insurer, tax: share.tax },
          Math.max(0, share.paid - shippingDeduction),
        )
      : { clawback: 0, changes: [], releaseCode: false };
    await OrderReturn.updateOne({ _id: rid, promoPlan: { $exists: false } }, { $set: { promoPlan: plan } });
    ret = (await OrderReturn.findById(rid).lean<IOrderReturn>())!;
  }
  const plan = ret.promoPlan!;
  if (!ret.steps?.promo) {
    if (plan.changes.length) {
      const inc: Record<string, number> = {};
      const arrayFilters: Record<string, unknown>[] = [];
      let reduced = 0;
      plan.changes.forEach((c, i) => {
        inc[`${c.model}.$[c${i}].promoDiscount`] = -c.reducedBy;
        inc[`${c.model}.$[c${i}].tax`] = c.taxDelta;
        inc[`${c.model}.$[c${i}].promoReduced`] = c.reducedBy;
        arrayFilters.push({ [`c${i}._id`]: oid(c.lineId) });
        reduced += c.reducedBy;
      });
      const done = await Order.updateOne(
        { _id: order._id, returnsPromoApplied: { $ne: rid } },
        { $inc: { ...inc, promoDiscount: -reduced, "promo.amount": -reduced }, $push: { returnsPromoApplied: rid } },
        { arrayFilters },
      );
      if (done.modifiedCount && reduced > 0)
        await LicensePromotionRedemption.updateOne({ order: order._id }, [
          {
            $set: {
              discount: { $max: [0, { $subtract: [{ $ifNull: ["$discount", 0] }, reduced] }] },
              paid: { $add: [{ $ifNull: ["$paid", 0] }, reduced] },
            },
          },
        ]).catch(() => undefined);
    }
    if (plan.releaseCode) await releaseOrderPromo(order._id as never).catch(() => undefined);
    await stamp(rid, "promo");
  }
  // the kept lines already paid out get what the re-check changed (once)
  if (order.promo) await settlePromoAdjustments(order._id, { cause: idOf(ret.line) });

  const refund = Math.max(0, share.paid - shippingDeduction - money(plan.clawback));
  if (!ret.money)
    await OrderReturn.updateOne(
      { _id: rid, money: { $exists: false } },
      { $set: { money: { refund, shippingDeduction, promoClawback: money(plan.clawback), sellerReversal: share.sellerAmount } } },
    );

  // 4) the seller's earning on the units, out of what the platform still
  // holds for it (a seller is never in debt)
  if (!ret.steps?.seller && seller?.user && share.earning && (share.sellerGross > 0 || share.sellerAmount > 0)) {
    const key = `ret:${idOf(rid)}:reversal`;
    const { taken, short } = await takeFromHeld({
      user: seller.user,
      org: { field: ORG_FIELD[seller.kind] as "pharmacy" | "paraClinic", id: seller.id },
      amount: share.sellerAmount,
      key,
      prefer: [{ order: order._id, orderItem: ret.line }, { "promoAdjust.orderItem": ret.line }],
    });
    const earning = await Transaction.findById(share.earning).select("commissionPercent").lean<{ commissionPercent?: number }>();
    let created = false;
    try {
      await Transaction.create({
        user: seller.user,
        amount: -share.sellerAmount,
        order: order._id,
        orderReturn: rid,
        returnLine: ret.line,
        returnPart: "reversal",
        returnKey: key,
        grossAmount: share.sellerGross,
        commission: share.sellerCommission,
        commissionPercent: Number(earning?.commissionPercent) || 0,
        tax: share.sellerTax,
        ...(share.subsidy > 0 ? { subsidyBack: share.subsidy } : {}),
        fromPending: taken,
        platformCovered: short,
        [ORG_FIELD[seller.kind]]: seller.id,
      });
      created = true;
    } catch (err) {
      if (!isDup(err)) throw err;
    }
    if (created && short > 0) await flagPlatformCovered(order._id, seller, short);
    await stamp(rid, "seller");
  }

  // 5) the buyer
  if (!ret.steps?.buyer) {
    if (refund > 0) {
      let created = false;
      try {
        await Transaction.create({
          user: order.user,
          amount: refund,
          order: order._id,
          orderReturn: rid,
          returnLine: ret.line,
          returnPart: "refund",
          returnKey: `ret:${idOf(rid)}:refund`,
        });
        created = true;
      } catch (err) {
        if (!isDup(err)) throw err;
      }
      if (created) await creditScope(personalScope(order.user), refund);
    }
    await stamp(rid, "buyer");
    await Notification.create({
      user: order.user,
      source: "System",
      title: "مبلغ مرجوعی به کیف پول شما برگشت",
      message: `${refund.toLocaleString("fa-IR")} تومان بابت مرجوعی یا بازپرداخت یک قلم از سفارش به کیف پول شما برگشت.`,
      link: orderLink(order._id),
    }).catch(() => undefined);
    notifyWithSms("returnRefundedUser", order.user, { orderId: shortId(order._id), amount: smsAmount(refund) }, { once: `returnRefunded:${idOf(rid)}` });
  }

  // the courier fee a buyer-fault Tapsi return pays goes to the pharmacy
  if (!ret.steps?.shipping && shippingDeduction > 0 && seller?.user) {
    let created = false;
    try {
      await Transaction.create({
        user: seller.user,
        amount: shippingDeduction,
        order: order._id,
        orderReturn: rid,
        returnLine: ret.line,
        returnPart: "shipping",
        returnKey: `ret:${idOf(rid)}:shipping`,
        pharmacy: seller.id,
      });
      created = true;
    } catch (err) {
      if (!isDup(err)) throw err;
    }
    if (created) await creditScope(personalScope(seller.user), shippingDeduction);
    await stamp(rid, "shipping");
  }

  // 5b) the delivery fee of a parcel the seller's error sent back whole
  if (!ret.steps?.delivery) {
    if (ret.kind === "return" && ret.sellerFault && seller?.kind === "pharmacy" && seller.user)
      await refundDeliveryFee(rid, order._id, seller);
    await stamp(rid, "delivery");
  }

  // 6) the insurer's share
  if (!ret.steps?.insurer) {
    if (owner && share.insurer > 0) await reverseInsurerShare(ret, order, owner);
    await stamp(rid, "insurer");
  }

  // 7) the stock (goods back on the shelf, or written off)
  if (!ret.steps?.stock) {
    if (owner && ret.kind === "return" && owner.kind === "pharmacy")
      await returnOrderLineStock(owner, order._id, ret.line, ret.qty, rid, ret.condition === "damaged");
    await stamp(rid, "stock");
  }

  // 8) the buyer's club points at this seller follow what they kept
  if (!ret.steps?.club) {
    if (owner && (await BizClubSettings.exists({ ownerKind: owner.kind, ownerId: owner.id, enabled: true })))
      await syncContacts(owner, true).catch(() => undefined);
    await stamp(rid, "club");
  }
};

// (2026-10, a seller is never in debt) A refund the seller's held earnings
// could not cover - it came after the payout (support's goodwill, a lab's
// refund of a test it performed) - is the platform's loss: booked as such
// (the reversal's platformCovered, Lib/business/ledgerPoster.ts) and the
// super admin is told, never posted as a seller debt.
const flagPlatformCovered = async (orderId: unknown, seller: LineSeller, amount: number) => {
  notifyUserAlertSubscribers(
    "refundPlatformCovered",
    {
      title: "بازپرداختی که نویان جبران کرد",
      message: `${amount.toLocaleString("fa-IR")} تومان از بازپرداخت سفارش ${shortId(orderId)} از درآمدهای در انتظار «${seller.name}» پوشش داده نشد و به حساب زیان نویان رفت.`,
      link: `/notadmin/finance/orders/${idOf(orderId)}`,
    },
    { orderId: shortId(orderId), amount: smsAmount(amount) },
  ).catch(() => undefined);
};

// The pharmacy's parcel of this order once a seller-error return left the
// buyer nothing of it (every line cancelled or returned in full, at least
// one delivered): the buyer gets back the delivery fee they paid (less a
// «پرو» discount the platform had paid), and the pharmacy's fee earning -
// still held with the parcel (Lib/payoutHold.ts returnGuard "parcel") - is
// taken back in full, the «پرو» part going back to the platform. Once per
// parcel (returnKey "ship:<shipment>:..."), whichever return closes it. A
// Tipax parcel's fee was paid to Tipax at the door, not to NoyanAI: there
// is nothing of it to give back here.
const refundDeliveryFee = async (rid: unknown, orderId: unknown, seller: LineSeller) => {
  const order = await Order.findById(orderId).lean<IOrder>();
  const shipment = (order?.shipments || []).find((s) => idOf(s.pharmacy) === seller.id);
  if (!order || !shipment || !(money(shipment.fee) > 0)) return;
  const feeRow = await Transaction.findOne({ order: order._id, orderItem: shipment._id, amount: { $gt: 0 } })
    .select("_id")
    .lean<{ _id: unknown }>();
  if (!feeRow) return;
  const [sellerItems, packageItems] = await Promise.all([
    mongoose.model("ProductSeller").find({ _id: { $in: (order.products || []).map((l) => l.item) }, seller: seller.id }).distinct("_id"),
    mongoose.model("ProductPackage").find({ _id: { $in: (order.productPackages || []).map((l) => l.item) }, owner: seller.id }).distinct("_id"),
  ]);
  const owned = new Set([...sellerItems, ...packageItems].map(String));
  const lines = ([...(order.products || []), ...(order.productPackages || [])] as unknown as ParcelLine[]).filter((l) =>
    owned.has(idOf(l.item)),
  );
  if (!lines.some((l) => l.status === "fulfilled")) return;
  // anything the buyer still has (or that is still coming) keeps the fee
  const kept = lines.some((l) =>
    l.status === "fulfilled" ? (Number(l.qty) || 0) - money(l.returned?.qty) > 0 : l.status !== "cancelled",
  );
  if (kept) return;
  const fee = money(shipment.fee);
  const subsidy = Math.min(fee, money(shipment.proDiscount));
  const paid = fee - subsidy;
  const key = `ship:${idOf(shipment._id)}:deliveryReversal`;
  const { taken, short } = await takeFromHeld({
    user: seller.user,
    org: { field: "pharmacy", id: seller.id },
    amount: fee,
    key,
    prefer: [{ _id: feeRow._id }, { order: order._id }],
  });
  let created = false;
  try {
    await Transaction.create({
      user: seller.user,
      amount: -fee,
      order: order._id,
      orderReturn: rid,
      returnLine: shipment._id,
      returnPart: "deliveryReversal",
      returnKey: key,
      pharmacy: seller.id,
      ...(subsidy > 0 ? { subsidyBack: subsidy } : {}),
      fromPending: taken,
      platformCovered: short,
    });
    created = true;
  } catch (err) {
    if (!isDup(err)) throw err;
  }
  if (created && short > 0) await flagPlatformCovered(order._id, seller, short);
  if (!(paid > 0)) return;
  let refunded = false;
  try {
    await Transaction.create({
      user: order.user,
      amount: paid,
      order: order._id,
      orderReturn: rid,
      returnLine: shipment._id,
      returnPart: "deliveryRefund",
      returnKey: `ship:${idOf(shipment._id)}:deliveryRefund`,
    });
    refunded = true;
  } catch (err) {
    if (!isDup(err)) throw err;
  }
  if (!refunded) return;
  await creditScope(personalScope(order.user), paid);
  await OrderReturn.updateOne({ _id: rid }, { $set: { "money.deliveryRefund": paid } });
  await Notification.create({
    user: order.user,
    source: "System",
    title: "هزینه‌ی ارسال سفارش به کیف پول شما برگشت",
    message: `${paid.toLocaleString("fa-IR")} تومان هزینه‌ی ارسال، چون همه‌ی بسته به خطای فروشنده مرجوع شد، به کیف پول شما برگشت.`,
    link: orderLink(order._id),
  }).catch(() => undefined);
};

type ParcelLine = { _id: unknown; item: unknown; status: string; qty: number; returned?: { qty?: number } };

// The supplementary insurer's share of the returned units (Lib/business/
// orderInsurance.ts): a line not on a list, or on a draft list, simply
// claims less (the draft's line is reduced, or dropped when nothing is
// left); a list already sent gets a credit - the seller owes it back,
// netted against what the insurer pays. Booked Dr income returns,
// Cr insurers (a rejected list's deduction is taken back instead).
const reverseInsurerShare = async (ret: IOrderReturn, order: IOrder, owner: BizOwner) => {
  const fresh = (await Order.findById(order._id).lean<IOrder>())!;
  const line = lineOf(fresh, ret.model, idOf(ret.line));
  if (!line || line.insuranceStatus !== "booked") return;
  const amount = money(ret.share?.insurer);
  if (!(amount > 0)) return;
  const insurer = fresh.insurance?.name || "—";
  const ref = `ordins:${idOf(order._id)}:${idOf(ret.line)}:ret:${idOf(ret._id)}`;
  // once: its voucher is the mark (a retry never reduces a list twice)
  if (await BizVoucher.exists({ ownerKind: owner.kind, ownerId: owner.id, ref })) return;
  const fully = money(keptLine(line).insurerShare) <= 0;
  const claim = line.insuranceClaim ? await BizClaim.findById(line.insuranceClaim) : null;
  let credit = "insuranceReceivable";
  if (claim && claim.status !== "draft") {
    if (claim.status === "rejected") credit = "insuranceDeductions";
    if (!(claim.credits || []).some((c) => c.ref === ref)) {
      const item = claim.items.find((i) => idOf(i.order) === idOf(order._id) && idOf(i.orderLine) === idOf(ret.line));
      const pushed = await BizClaim.updateOne(
        { _id: claim._id, "credits.ref": { $ne: ref } },
        {
          $push: {
            credits: {
              order: order._id,
              orderLine: ret.line,
              amount,
              ref,
              at: new Date(),
              reason: ret.reason,
              orderReturn: ret._id,
              ...(item?.service ? { service: item.service } : {}),
            },
          },
        },
      );
      if (pushed.modifiedCount) {
        // what is still open on the list (both sides) is net of the credit
        const fresh = await BizClaim.findById(claim._id);
        if (fresh) {
          fresh.status = claimStatus(fresh);
          await fresh.save();
        }
        await postClaimCredits(claim._id).catch((err) => console.log(`[returns] insurer credit of claim ${idOf(claim._id)}:`, err));
      }
    }
  } else if (claim) {
    const item = claim.items.find((i) => idOf(i.order) === idOf(order._id) && idOf(i.orderLine) === idOf(ret.line));
    if (item) {
      const left = Math.max(0, money(item.share) - amount);
      if (left > 0) {
        item.share = left;
      } else {
        claim.items = claim.items.filter((i) => i !== item);
        await Order.updateOne({ _id: order._id, [`${ret.model}._id`]: ret.line }, { $unset: { [`${ret.model}.$.insuranceClaim`]: 1 } });
      }
      claim.claimed = claim.items.reduce((s, i) => s + (Number(i.share) || 0), 0);
      await claim.save();
    }
  }
  if (fully && !(claim && claim.status !== "draft"))
    await Order.updateOne(
      { _id: order._id, [ret.model]: { $elemMatch: { _id: ret.line, insuranceStatus: "booked" } } },
      { $set: { [`${ret.model}.$.insuranceStatus`]: "reversed" } },
    );
  const label = `${insurer} · ${shortId(order._id)}`.slice(0, 300);
  await postDoc(owner, {
    ref,
    date: new Date(),
    description:
      claim && claim.status !== "draft" ? "اعتبار به بیمه‌ی تکمیلی بابت کالای مرجوعی" : "برگشت سهم بیمه‌ی تکمیلی کالای مرجوعی",
    lines: [
      { role: owner.kind === "platform" ? defaultIncomeRole(owner.kind) : "incomeReturns", debit: amount, credit: 0, label },
      { role: credit, debit: 0, credit: amount, label, ...(credit === "insuranceReceivable" ? { party: { kind: "insurer", name: insurer } } : {}) },
    ],
    source: { type: "order", id: order._id },
    party: { kind: "insurer", name: insurer },
  });
};

// ---------------------------------------------------------------- sweep

// Hourly (Services/orderReturnService.ts startReturnJob): a request the
// seller never answered, or a parcel it never confirmed, goes to support's
// queue; an approved return the buyer never sent, or a "no" the buyer never
// took further, is closed and its units freed.
export const runReturnSweep = async (now = new Date()) => {
  const s = await getReturnSettings();
  const answerBy = new Date(now.getTime() - s.responseHours * 3600_000);
  const receiveBy = new Date(now.getTime() - s.receiveDays * 86_400_000);
  let escalated = 0;
  let closed = 0;
  const stale = await OrderReturn.find({
    $or: [
      { status: "requested", createdAt: { $lte: answerBy } },
      { status: "shipped", "shipping.shippedAt": { $lte: receiveBy } },
      { status: "approved", "shipping.method": "tapsi", updatedAt: { $lte: receiveBy } },
    ],
  })
    .limit(200)
    .lean<IOrderReturn[]>();
  for (const r of stale) {
    const moved = await OrderReturn.findOneAndUpdate(
      { _id: r._id, status: r.status },
      { $set: { status: "escalated" }, $push: { history: historyOf("escalated", { kind: "system" }, "noResponse") } },
      { new: true },
    ).lean<IOrderReturn>();
    if (!moved) continue;
    escalated++;
    await openEscalation(moved, "system", "noResponse");
    await notifySellerOf(
      moved,
      "مرجوعی بی‌پاسخ به پشتیبانی رفت",
      "به درخواست مرجوعی این سفارش به‌موقع پاسخ داده نشد و برای تصمیم به پشتیبانی رفت.",
    );
  }
  const dead = await OrderReturn.find({
    $or: [
      { status: "approved", "shipping.method": { $in: ["tipax", "inPerson"] }, updatedAt: { $lte: receiveBy } },
      { status: "rejected", updatedAt: { $lte: receiveBy } },
    ],
  })
    .limit(200)
    .lean<IOrderReturn[]>();
  for (const r of dead) {
    const done = await OrderReturn.findOneAndUpdate(
      { _id: r._id, status: r.status },
      { $set: { status: "cancelled" }, $push: { history: historyOf("expired", { kind: "system" }) } },
      { new: true },
    ).lean<IOrderReturn>();
    if (!done) continue;
    closed++;
    await releaseUnits(done.order, done.model, done.line, done.qty);
  }
  // a settlement that never finished (a crash between steps)
  const unfinished = await OrderReturn.find({ status: "refunded", "steps.club": { $exists: false }, refundedAt: { $lte: new Date(now.getTime() - 10 * 60_000) } })
    .select("_id")
    .limit(50)
    .lean();
  for (const r of unfinished) await settleReturnSafely(r._id);
  if (escalated || closed) console.log(`[returns] sweep: ${escalated} escalated, ${closed} closed`);
  return { escalated, closed };
};

export const startReturnJob = (intervalMs = 60 * 60 * 1000) => {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    runReturnSweep()
      .catch((err) => console.log("[returns] sweep failed:", err))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(run, 90 * 1000).unref?.();
  setInterval(run, intervalMs).unref?.();
};

// ----------------------------------------------------------------- views

// The returns of an order, as each side sees them (the buyer's order page,
// the seller's order page - its own lines only - and support).
export const returnsOfOrder = async (orderId: unknown, seller?: { kind: string; id: unknown }) =>
  OrderReturn.find({ order: orderId, ...(seller ? sellerMatch(seller) : {}) })
    .sort({ createdAt: 1 })
    .select("-steps -promoPlan")
    .lean<IOrderReturn[]>();

export { openReturnStatuses };

// A return as the order pages show it (no internal bookkeeping)
export const returnView = (r: IOrderReturn & { escalation?: unknown }) => ({
  _id: idOf(r._id),
  model: r.model,
  line: idOf(r.line),
  item: idOf(r.item),
  qty: r.qty,
  kind: r.kind,
  initiatedBy: r.initiatedBy,
  reason: r.reason,
  note: r.note || "",
  photos: (r.photos || []).map(idOf),
  unopened: !!r.unopened,
  sellerFault: !!r.sellerFault,
  status: r.status,
  rejectReason: r.rejectReason || "",
  shipping: r.shipping
    ? {
        method: r.shipping.method,
        fee: money(r.shipping.fee),
        paidBy: r.shipping.paidBy,
        trackingCode: r.shipping.trackingCode || "",
        shippedAt: r.shipping.shippedAt || null,
      }
    : null,
  receivedAt: r.receivedAt || null,
  condition: r.condition || null,
  money: r.money
    ? {
        refund: money(r.money.refund),
        shippingDeduction: money(r.money.shippingDeduction),
        promoClawback: money(r.money.promoClawback),
        sellerReversal: money(r.money.sellerReversal),
        deliveryRefund: money(r.money.deliveryRefund),
      }
    : null,
  refundedAt: r.refundedAt || null,
  createdAt: r.createdAt,
  history: (r.history || []).map((h) => ({ action: h.action, byKind: h.byKind, note: h.note || "", at: h.at })),
});

export const returnViewsOfOrder = async (orderId: unknown, seller?: { kind: string; id: unknown }) => {
  const rows = await returnsOfOrder(orderId, seller);
  const escalations = rows.some((r) => r.escalation)
    ? await ReturnEscalation.find({ _id: { $in: rows.map((r) => r.escalation).filter(Boolean) } })
        .select("status rejectReason raisedBy")
        .lean<IReturnEscalation[]>()
    : [];
  const escOf = new Map(escalations.map((e) => [idOf(e._id), e]));
  // (2026-10, a seller is never in debt) where the seller's part came from:
  // its held earnings, and what the platform absorbed (a refund after the
  // payout) - read off the reversal rows themselves
  const sides = rows.length
    ? await Transaction.find({ orderReturn: { $in: rows.map((r) => r._id) }, returnPart: { $in: ["reversal", "deliveryReversal"] } })
        .select("orderReturn fromPending platformCovered")
        .lean<{ orderReturn?: unknown; fromPending?: number; platformCovered?: number }[]>()
    : [];
  const sideOf = new Map<string, { sellerFromHeld: number; platformCovered: number }>();
  for (const t of sides) {
    const k = idOf(t.orderReturn);
    const a = sideOf.get(k) || { sellerFromHeld: 0, platformCovered: 0 };
    a.sellerFromHeld += money(t.fromPending);
    a.platformCovered += money(t.platformCovered);
    sideOf.set(k, a);
  }
  return rows.map((r) => {
    const e = r.escalation ? escOf.get(idOf(r.escalation)) : undefined;
    const view = returnView(r);
    return {
      ...view,
      money: view.money ? { ...view.money, ...(sideOf.get(idOf(r._id)) || { sellerFromHeld: 0, platformCovered: 0 }) } : null,
      escalation: e ? { _id: idOf(e._id), status: e.status, rejectReason: e.rejectReason || "", raisedBy: e.raisedBy } : null,
    };
  });
};
