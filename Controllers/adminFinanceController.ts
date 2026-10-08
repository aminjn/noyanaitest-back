import { notifyWithSms, smsAmount } from "../Services/notificationSmsService";
import { NextFunction, Request, RequestHandler, Response } from "express";
import mongoose, { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import Order, { orderItemStatuses, orderStatuses } from "../Models/Order";
import Transaction from "../Models/Transaction";
import GatewayPayment, { gatewayPaymentStatuses } from "../Models/GatewayPayment";
import Wallet from "../Models/Wallet";
import DeliveryRide from "../Models/DeliveryRide";
import Pharmacy from "../Models/Pharmacy";
import Notification from "../Models/Notification";
import Invoice from "../Models/Invoice";
import LabSampling from "../Models/LabSampling";
import UserAddress from "../Models/UserAddress";
import {
  cancelSamplingAppointment,
  rescheduleSampling,
  samplingMovesFor,
} from "../Lib/labSamplingReschedule";
// registers the models the subscriptions overview / invoices look up by name
import "../Models/DoctorProfileLicense";
import "../Models/ClinicProfileLicense";
import "../Models/HospitalProfileLicense";
import "../Models/ParaClinicProfileLicense";
import "../Models/PharmacyProfileLicense";
import "../Models/InsuranceProfileLicense";
import "../Models/BaseDoctorLicense";
import "../Models/BaseClinicLicense";
import "../Models/BaseHospitalLicense";
import "../Models/BaseParaClinicLicense";
import "../Models/BasePharmacyLicense";
import "../Models/BaseInsuranceLicense";
import "../Models/DoctorProfile";
import "../Models/Clinic";
import "../Models/Hospital";
import "../Models/Paraclinic";
import "../Models/Insurance";
import "../Models/InvocieCheckout";
import "../Models/DoctorSession";
import "../Models/UserIdentity";
import {
  EXPORT_MAX,
  pagingQuery,
  pageWindow,
  searchUserIds,
  sendCsv,
  userCsvLabel,
} from "../Lib/adminListing";
import {
  notifySellerOfBuyerCancel,
  settleOrderLine,
} from "../Services/orderSettlementService";
import {
  dispatchDeliveryForPharmacy,
  refreshDeliveryForPharmacy,
} from "./pharmacyController";
import { snappRideStates } from "../Lib/snappClient";

// Super admin money pages (2026-09): orders, the wallet ledger and gateway
// payments - server-paged lists with a CSV export of the current filter
// (2026-10), resolving a "needsReview" payment (card charged, wallet credit
// and the automatic reverse both failed), and the order back office
// (2026-10): one order's lines, sellers, shipments, payments and refunds,
// with cancel / per-line override actions that go through the same
// settlement code a seller's or buyer's own action uses
// (Services/orderSettlementService.ts) - idempotent per line, never paying
// or refunding twice.

const USER_FIELDS = "phone username firstName lastName";

const listQuery = pagingQuery.extend({
  status: z.string().optional(),
  user: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  // orders: lines in this state (e.g. "pending" = waiting on a seller)
  lineStatus: z.enum(orderItemStatuses).optional(),
  // transactions: what the row is about; payments: walletCharge / order
  kind: z.string().optional(),
  purpose: z.string().optional(),
});

const dateRange = (from?: Date, to?: Date, field = "createdAt") =>
  from || to
    ? {
        [field]: {
          ...(from && { $gte: from }),
          ...(to && { $lte: to }),
        },
      }
    : {};

// `user` (an id) and `q` (a search) narrow a list to some users; a search
// that matches nobody must return nothing, not everything
const userScope = async (
  filter: Record<string, unknown>,
  data: { user?: string; q?: string },
  field = "user",
) => {
  if (data.user && isValidObjectId(data.user)) filter[field] = data.user;
  else if (data.q) {
    const ids = await searchUserIds(data.q);
    filter[field] = { $in: ids };
  }
};

const ORDER_LINE_MODELS = [
  "products",
  "productPackages",
  "services",
  "servicePackages",
  "tests",
] as const;
type LineModel = (typeof ORDER_LINE_MODELS)[number];

const linesOf = (o: any) =>
  ORDER_LINE_MODELS.map((k) => (Array.isArray(o?.[k]) ? o[k] : [])).flat();

// GET /admin/finance/orders?page=&limit=&status=&lineStatus=&q=&from=&to=&format=csv
export const listOrders: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = listQuery.safeParse(req.query);
    if (!success) return next(new BadInputError());
    const filter: Record<string, unknown> = dateRange(
      data.from,
      data.to,
      "submittedAt",
    );
    if (data.status && (orderStatuses as readonly string[]).includes(data.status))
      filter.status = data.status;
    const and: Record<string, unknown>[] = [];
    if (data.lineStatus)
      and.push({
        $or: ORDER_LINE_MODELS.map((m) => ({ [`${m}.status`]: data.lineStatus })),
      });
    // a pasted order number (full id, or the 8-char tail the list shows),
    // else the buyer's phone / name; digits alone may be either
    const q = data.q?.trim();
    if (q && /^[0-9a-f]{24}$/i.test(q)) filter._id = q;
    else if (q && /^[0-9a-f]{6,23}$/i.test(q)) {
      const idTail = {
        $expr: {
          $regexMatch: { input: { $toString: "$_id" }, regex: `${q.toLowerCase()}$` },
        },
      };
      if (/^\d+$/.test(q))
        and.push({ $or: [idTail, { user: { $in: await searchUserIds(q) } }] });
      else and.push(idTail);
    } else await userScope(filter, data);
    if (and.length) filter.$and = and;
    const { skip, limit } = pageWindow(data);
    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ submittedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: "user", select: USER_FIELDS })
        .lean(),
      Order.countDocuments(filter),
    ]);
    // the lab sampling appointments of the page's orders (2026-10)
    const samplingRows = await LabSampling.find({ order: { $in: orders.map((o: any) => o._id) } })
      .select("order kind ymd start end startsAt status collectedAt moveCount")
      .sort({ startsAt: 1 })
      .lean();
    const samplingsOf = (orderId: unknown) =>
      samplingRows
        .filter((b) => String(b.order) === String(orderId))
        .map((b) => ({
          _id: String(b._id),
          kind: b.kind,
          ymd: b.ymd,
          start: b.start,
          end: b.end,
          startsAt: b.startsAt,
          status: b.status,
          collected: !!b.collectedAt,
          moves: Number(b.moveCount) || 0,
        }));
    const rows = orders.map((o: any) => {
      const lines = linesOf(o);
      return {
        samplings: samplingsOf(o._id),
        _id: o._id,
        user: o.user || null,
        subtotal: o.subtotal,
        tax: o.tax,
        deliveryFee: o.deliveryFee || 0,
        total: o.total,
        paymentMethod: o.paymentMethod,
        status: o.status,
        submittedAt: o.submittedAt,
        paidAt: o.paidAt,
        lines: lines.length,
        pending: lines.filter((l: any) => l.status === "pending").length,
        fulfilled: lines.filter((l: any) => l.status === "fulfilled").length,
        cancelled: lines.filter((l: any) => l.status === "cancelled").length,
      };
    });
    if (data.format === "csv")
      return sendCsv(
        res,
        "orders",
        ["شماره سفارش", "خریدار", "جمع اقلام", "مالیات", "هزینه ارسال", "مبلغ کل", "روش پرداخت", "وضعیت", "اقلام", "در انتظار", "تحویل", "لغو", "تاریخ ثبت", "تاریخ پرداخت"],
        rows.map((r) => [String(r._id), userCsvLabel(r.user), r.subtotal, r.tax, r.deliveryFee, r.total, r.paymentMethod, r.status, r.lines, r.pending, r.fulfilled, r.cancelled, r.submittedAt, r.paidAt]),
      );
    res.status(200).json({
      message: "listOrders",
      data: rows,
      total,
      page: data.page,
      limit: data.limit,
    });
  },
);

// what a ledger row is about, for the admin's "reason" column
const TRANSACTION_KINDS = [
  "withdrawal",
  "gatewayPayment",
  "order",
  "reservation",
  "license",
  "pharmacyLicense",
  "clinicLicense",
  "paraClinicLicense",
  "hospitalLicense",
  "insuranceLicense",
  // a provider's SMS campaign paid from the wallet, or its unsent part back
  "smsCampaign",
  // CRM automations and one-off SMS to a patient (2026-10)
  "smsAutomation",
  "smsMessage",
  // a patient's «پرو» membership (2026-10)
  "proPlan",
  "checkout",
] as const;

// GET /admin/finance/transactions?page=&limit=&kind=&q=&from=&to=&format=csv
export const listTransactions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = listQuery.safeParse(req.query);
    if (!success) return next(new BadInputError());
    const filter: Record<string, unknown> = dateRange(data.from, data.to);
    await userScope(filter, data);
    if (data.kind === "adminAdjustment") filter.adminAction = "adjustment";
    else if (data.kind === "other") {
      filter.$and = TRANSACTION_KINDS.map((k) => ({ [k]: { $exists: false } }));
      filter.adminAction = { $ne: "adjustment" };
    }
    else if (data.kind && (TRANSACTION_KINDS as readonly string[]).includes(data.kind))
      filter[data.kind] = { $exists: true };
    if (data.status === "credit") filter.amount = { $gt: 0 };
    else if (data.status === "debit") filter.amount = { $lt: 0 };
    const { skip, limit } = pageWindow(data);
    const [rows, total, commissionTotal] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: "user", select: USER_FIELDS })
        .lean(),
      Transaction.countDocuments(filter),
      Transaction.aggregate<{ sum: number }>([
        { $match: { ...castIds(filter), commission: { $gt: 0 } } },
        { $group: { _id: null, sum: { $sum: "$commission" } } },
      ]),
    ]);
    const mapped = rows.map((t: any) => ({
      _id: t._id,
      user: t.user || null,
      amount: t.amount,
      createdAt: t.createdAt,
      // a manual correction by an admin (Services/adminWalletService.ts)
      kind:
        TRANSACTION_KINDS.find((k) => !!t[k]) ||
        (t.adminAction === "adjustment" ? "adminAdjustment" : "other"),
      note: t.note,
      ref: TRANSACTION_KINDS.map((k) => t[k]).find(Boolean) || null,
      grossAmount: t.grossAmount,
      commission: t.commission,
      commissionPercent: t.commissionPercent,
    }));
    if (data.format === "csv")
      return sendCsv(
        res,
        "transactions",
        ["شناسه", "کاربر", "مبلغ", "بابت", "مرجع", "مبلغ ناخالص", "کمیسیون", "درصد کمیسیون", "تاریخ"],
        mapped.map((t) => [String(t._id), userCsvLabel(t.user), t.amount, t.kind, t.ref ? String(t.ref) : "", t.grossAmount, t.commission, t.commissionPercent, t.createdAt]),
      );
    res.status(200).json({
      message: "listTransactions",
      data: mapped,
      total,
      page: data.page,
      limit: data.limit,
      // the platform's income: commission taken on the filtered payouts
      commissionTotal: commissionTotal[0]?.sum || 0,
    });
  },
);

// aggregate() doesn't cast like find(): ids in a $match must be ObjectIds
const castIds = (filter: Record<string, unknown>) => {
  const out: Record<string, unknown> = { ...filter };
  const user = out.user as any;
  if (typeof user === "string") out.user = new Types.ObjectId(user);
  else if (user?.$in)
    out.user = { $in: user.$in.map((id: string) => new Types.ObjectId(id)) };
  return out;
};

// GET /admin/finance/payments?page=&limit=&status=&purpose=&q=&from=&to=&format=csv
export const listPayments: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = listQuery.safeParse(req.query);
    if (!success) return next(new BadInputError());
    const filter: Record<string, unknown> = dateRange(data.from, data.to);
    if (
      data.status &&
      (gatewayPaymentStatuses as readonly string[]).includes(data.status)
    )
      filter.status = data.status;
    if (data.purpose && ["walletCharge", "order"].includes(data.purpose))
      filter.purpose = data.purpose;
    const q = data.q?.trim();
    // digits may be a bank reference or the payer's phone
    if (q && /^\d{6,}$/.test(q))
      filter.$or = [
        { rrn: q },
        { refNum: q },
        { traceNo: q },
        { user: { $in: await searchUserIds(q) } },
      ];
    else await userScope(filter, data);
    const { skip, limit } = pageWindow(data);
    const [rows, total] = await Promise.all([
      GatewayPayment.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("-token")
        .populate({ path: "user", select: USER_FIELDS })
        .populate({ path: "resolvedBy", select: "phone username" })
        .lean(),
      GatewayPayment.countDocuments(filter),
    ]);
    if (data.format === "csv")
      return sendCsv(
        res,
        "payments",
        ["شناسه", "پرداخت‌کننده", "مبلغ", "بابت", "وضعیت", "کد پیگیری", "رسید", "کارت", "علت خطا", "سفارش", "تاریخ", "توضیح رسیدگی"],
        rows.map((p: any) => [String(p._id), userCsvLabel(p.user), p.amount, p.purpose, p.status, p.rrn, p.refNum, p.maskedPan, p.failureReason, p.order ? String(p.order) : "", p.createdAt, p.resolutionNote]),
      );
    res.status(200).json({
      message: "listPayments",
      data: rows,
      total,
      page: data.page,
      limit: data.limit,
    });
  },
);

const resolveSchema = z.strictObject({
  // credit: the money stays with us - put it in the user's wallet (what the
  //         automatic flow failed to do)
  // refunded: the admin returned it to the card outside the system
  resolution: z.enum(["credit", "refunded"]),
  note: z.string().trim().min(3).max(1000),
});

// POST /admin/finance/payments/:nodeId/resolve
export const resolvePayment: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const { data, success } = resolveSchema.safeParse(req.body);
    if (!success) return next(new BadInputError());

    // claim the row first so two admins can never resolve it twice
    const payment = await GatewayPayment.findOneAndUpdate(
      { _id: nodeId, status: "needsReview" },
      {
        $set: {
          status: data.resolution === "credit" ? "paid" : "reversed",
          resolvedBy: req.user!._id,
          resolvedAt: new Date(),
          resolutionNote: data.note,
        },
      },
      { new: true },
    );
    if (!payment)
      return next(new AppError("این پرداخت در وضعیت نیازمند بررسی نیست", 400));

    if (data.resolution === "credit") {
      const existing = await Transaction.findOne({ gatewayPayment: payment._id });
      let creditId = existing?._id;
      if (!existing) {
        // ledger row first, then the balance; if the balance update fails
        // both are undone and the payment goes back to "needsReview", so it
        // is never marked paid with no money in the wallet
        const credit = await Transaction.create({
          user: payment.user,
          amount: payment.amount,
          gatewayPayment: payment._id,
        });
        try {
          await Wallet.updateOne(
            { user: payment.user },
            { $inc: { balance: payment.amount } },
            { upsert: true },
          );
        } catch (err) {
          await Transaction.deleteOne({ _id: credit._id }).catch(() => {});
          await GatewayPayment.updateOne(
            { _id: payment._id, status: "paid" },
            {
              $set: { status: "needsReview" },
              $unset: { resolvedBy: 1, resolvedAt: 1, resolutionNote: 1 },
            },
          ).catch(() => {});
          throw err;
        }
        creditId = credit._id;
      }
      await GatewayPayment.updateOne(
        { _id: payment._id },
        { $set: { transaction: creditId } },
      );
    }

    // the payer learns where their money went
    Notification.create({
      user: payment.user,
      source: "System",
      title:
        data.resolution === "credit"
          ? "پرداخت شما به کیف پول واریز شد"
          : "پرداخت شما به کارت برگشت داده شد",
      message:
        data.resolution === "credit"
          ? `پس از بررسی پشتیبانی، ${payment.amount.toLocaleString("fa-IR")} تومان پرداخت درگاه شما به کیف پولتان واریز شد.`
          : `پس از بررسی پشتیبانی، ${payment.amount.toLocaleString("fa-IR")} تومان پرداخت درگاه شما به کارت بانکی‌تان برگشت داده شد.`,
      link: "/dashboard/transaction",
    }).catch(() => {});
    notifyWithSms(
      data.resolution === "credit" ? "gatewayPaymentCreditedUser" : "gatewayPaymentRefundedUser",
      payment.user,
      { amount: smsAmount(payment.amount) },
    );

    res.status(200).json({ message: "resolvePayment", data: { _id: payment._id } });
  },
);

// ---- order back office (2026-10) ----

// Which catalog doc a line points to and which org sells it - mirrors
// Services/orderSettlementService.ts's lineOwner.
const LINE_OWNER: Record<
  LineModel,
  { model: string; field: string; org: "Pharmacy" | "DoctorProfile" | "ParaClinic"; orgKey: "pharmacy" | "doctor" | "paraClinic" }
> = {
  products: { model: "ProductSeller", field: "seller", org: "Pharmacy", orgKey: "pharmacy" },
  productPackages: { model: "ProductPackage", field: "owner", org: "Pharmacy", orgKey: "pharmacy" },
  services: { model: "Service", field: "owner", org: "DoctorProfile", orgKey: "doctor" },
  servicePackages: { model: "ServicePackage", field: "owner", org: "DoctorProfile", orgKey: "doctor" },
  tests: { model: "ParaClinicTest", field: "paraClinic", org: "ParaClinic", orgKey: "paraClinic" },
};

// admin entity route segment per seller org (EntityOverview kinds)
const SELLER_KIND: Record<string, string> = {
  Pharmacy: "pharmacy",
  DoctorProfile: "doctorprofile",
  ParaClinic: "paraClinic",
};

const idOf = (value: unknown) =>
  value ? String((value as { _id?: unknown })?._id ?? value) : "";

// Snapp ride state number -> its name (Lib/snappClient.ts)
const snappStateName = (state?: number) =>
  typeof state === "number"
    ? Object.entries(snappRideStates).find(([, v]) => v === state)?.[0] || String(state)
    : null;

const orderPopulate = [
  { path: "user", select: USER_FIELDS },
  { path: "address", populate: { path: "city", select: "name" } },
  {
    path: "products.item",
    select: "seller product price",
    populate: [
      { path: "seller", select: "name user" },
      { path: "product", select: "name" },
    ],
  },
  {
    path: "productPackages.item",
    select: "name owner",
    populate: { path: "owner", select: "name user" },
  },
  {
    path: "services.item",
    select: "name owner",
    populate: { path: "owner", select: "firstName lastName user" },
  },
  {
    path: "servicePackages.item",
    select: "name owner",
    populate: { path: "owner", select: "firstName lastName user" },
  },
  {
    path: "tests.item",
    select: "test paraClinic",
    populate: [
      { path: "test", select: "name" },
      { path: "paraClinic", select: "name user" },
    ],
  },
  { path: "shipments.pharmacy", select: "name" },
  { path: "shipments.originCity", select: "name" },
  { path: "shipments.destinationCity", select: "name" },
  { path: "adminNotes.by", select: "phone username" },
];

const lineView = (model: LineModel, line: any) => {
  const item = line.item && typeof line.item === "object" ? line.item : null;
  const owner = LINE_OWNER[model];
  const org = item?.[owner.field];
  const orgName =
    org && typeof org === "object"
      ? org.name || [org.firstName, org.lastName].filter(Boolean).join(" ")
      : "";
  const name =
    model === "products"
      ? item?.product?.name
      : model === "tests"
        ? item?.test?.name
        : item?.name;
  return {
    _id: String(line._id),
    model,
    itemId: idOf(line.item),
    name: name || "",
    qty: line.qty,
    price: line.price,
    tax: line.tax ?? null,
    lineTotal: Math.max(0, (line.price || 0) * (line.qty || 0)),
    status: line.status,
    seller: org
      ? { _id: idOf(org), name: orgName || "", kind: SELLER_KIND[owner.org] }
      : null,
    // prescription-only line (2026-10, Lib/rxPrescription.ts): what the
    // buyer gave and the pharmacy's decision; paper files open through
    // /notpublic/:id (Services/rxPrescriptionAccess.ts lets the admin in)
    requiresPrescription: !!line.requiresPrescription,
    prescription:
      line.prescription && typeof line.prescription === "object"
        ? {
            kind: line.prescription.kind,
            insurer: line.prescription.insurer || "",
            trackingCode: line.prescription.trackingCode || "",
            nationalCode: line.prescription.nationalCode || "",
            files: (Array.isArray(line.prescription.files) ? line.prescription.files : []).map(
              (f: unknown) => idOf(f),
            ),
            note: line.prescription.note || "",
            status: line.prescription.status || "pending",
            reason: line.prescription.reason || "",
            reviewedAt: line.prescription.reviewedAt || null,
          }
        : null,
  };
};

const samplingPlaceView = (p: any) =>
  p
    ? {
        kind: p.kind,
        ymd: p.ymd,
        start: p.start,
        end: p.end,
        startsAt: p.startsAt,
        fee: p.fee || 0,
      }
    : null;

// The order's lab sampling appointments for support (2026-10): when, where,
// how far it got, every move, and what support may do now
// (Lib/labSamplingReschedule.ts samplingMoveInfo, actor "admin").
const samplingViews = async (order: any, docs: any[], lineById: Map<string, any>) => {
  if (!docs.length) return [];
  const info = await samplingMovesFor(docs, "admin");
  return docs.map((b) => ({
    _id: String(b._id),
    paraClinic: b.paraClinic ? { _id: idOf(b.paraClinic), name: b.paraClinic.name || "" } : null,
    kind: b.kind,
    ymd: b.ymd,
    start: b.start,
    end: b.end,
    startsAt: b.startsAt,
    status: b.status,
    confirmedAt: b.confirmedAt || null,
    collectedAt: b.collectedAt || null,
    cancelledAt: b.cancelledAt || null,
    remindedAt: b.remindedAt || null,
    fee: b.fee || 0,
    feeSettled: b.feeSettled || null,
    address: b.address
      ? {
          _id: idOf(b.address),
          displayName: b.address.displayName || "",
          address: b.address.address || "",
          receiverPhone: b.address.receiverPhone || "",
          city: b.address.city?.name || "",
          district: b.address.district?.name || "",
        }
      : null,
    tests: (b.lines || []).map((id: unknown) => {
      const line = lineById.get(String(id));
      return { _id: String(id), name: line?.name || "", status: line?.status || "" };
    }),
    moves: (b.moves || []).map((m: any) => ({
      _id: String(m._id),
      at: m.at,
      by: m.by,
      byUser: m.byUser ? m.byUser.username || m.byUser.phone || "" : "",
      from: samplingPlaceView(m.from),
      to: samplingPlaceView(m.to),
      feeDelta: m.feeDelta || 0,
      reason: m.reason || "",
    })),
    move: info[String(b._id)] || null,
    orderStatus: order.status,
  }));
};

// the buyer's addresses, for support switching an appointment to home
const buyerAddressesFor = async (order: any, docs: any[]) => {
  if (!docs.some((b) => b.status === "active")) return [];
  const list = await UserAddress.find({ user: idOf(order.user), archived: { $ne: true } })
    .select("displayName address city")
    .populate({ path: "city", select: "name" })
    .lean();
  return list.map((a: any) => ({
    _id: String(a._id),
    displayName: a.displayName || "",
    address: a.address || "",
    city: a.city ? { _id: idOf(a.city), name: a.city.name || "" } : null,
  }));
};

const buildOrderDetail = async (nodeId: string) => {
  const order: any = await Order.findById(nodeId).populate(orderPopulate as any).lean();
  if (!order) return null;
  const [transactions, payments, rides, samplingDocs] = await Promise.all([
    Transaction.find({ order: order._id })
      .sort({ createdAt: 1 })
      .populate({ path: "user", select: USER_FIELDS })
      .lean(),
    GatewayPayment.find({ order: order._id })
      .sort({ createdAt: 1 })
      .select("-token")
      .lean(),
    DeliveryRide.find({ order: order._id })
      .populate({ path: "pharmacy", select: "name" })
      .lean(),
    // lab sampling appointments (2026-10, Lib/labSampling.ts)
    LabSampling.find({ order: order._id })
      .sort({ startsAt: 1 })
      .populate([
        { path: "paraClinic", select: "name" },
        { path: "address", populate: [{ path: "city", select: "name" }, { path: "district", select: "name" }] },
        { path: "moves.byUser", select: "username phone" },
      ])
      .lean(),
  ]);
  // the appointments and their moves are ledger lines too: a home fee paid
  // to the lab, refunded, or charged / refunded by a move
  const samplingIds = new Set<string>();
  for (const b of samplingDocs as any[]) {
    samplingIds.add(String(b._id));
    for (const m of b.moves || []) samplingIds.add(String(m._id));
  }
  const buyerId = idOf(order.user);
  const lines = ORDER_LINE_MODELS.flatMap((m) =>
    (Array.isArray(order[m]) ? order[m] : []).map((l: any) => lineView(m, l)),
  );
  const lineById = new Map(lines.map((l) => [l._id, l]));
  const shipmentIds = new Set(
    (order.shipments || []).map((s: any) => String(s._id)),
  );
  const ledger = (transactions as any[]).map((t) => {
    const lineId = t.orderItem ? String(t.orderItem) : "";
    const toBuyer = idOf(t.user) === buyerId;
    return {
      _id: String(t._id),
      user: t.user || null,
      amount: t.amount,
      createdAt: t.createdAt,
      // the buyer's charge, a refund back to the buyer, a seller payout or
      // a courier fee to the pharmacy
      kind: !lineId
        ? t.amount < 0 && toBuyer
          ? "charge"
          : "other"
        : toBuyer
          ? t.amount < 0
            ? "charge"
            : "refund"
          : shipmentIds.has(lineId)
            ? "deliveryFee"
            : "payout",
      line:
        lineById.get(lineId)?.name ||
        (shipmentIds.has(lineId) ? "delivery" : samplingIds.has(lineId) ? "sampling" : ""),
      grossAmount: t.grossAmount,
      commission: t.commission,
    };
  });
  const refunded = ledger
    .filter((t) => t.kind === "refund")
    .reduce((sum, t) => sum + (t.amount || 0), 0);
  const paidOut = ledger
    .filter((t) => t.kind === "payout" || t.kind === "deliveryFee")
    .reduce((sum, t) => sum + (t.amount || 0), 0);
  const commission = ledger.reduce((sum, t) => sum + (t.commission || 0), 0);
  const ridesByPharmacy = new Map(
    (rides as any[]).map((r) => [idOf(r.pharmacy), r]),
  );
  const rideView = (r: any) =>
    r
      ? {
          _id: String(r._id),
          hri: r.hri,
          state: r.currentState ?? null,
          stateName: snappStateName(r.currentState),
          finalPrice: r.finalPrice ?? null,
          driverName: r.driverName || "",
          driverCellphone: r.driverCellphone || "",
          shareUrl: r.shareUrl || "",
          requestedAt: r.requestedAt,
          lastRefreshedAt: r.lastRefreshedAt || null,
          cancelledAt: r.cancelledAt || null,
        }
      : null;
  // one shipment per pharmacy with physical items; a pharmacy whose Snapp
  // ride exists without a shipment plan (older orders) still shows
  const pharmacies = new Map<string, any>();
  for (const s of order.shipments || [])
    pharmacies.set(idOf(s.pharmacy), {
      _id: String(s._id),
      pharmacy: s.pharmacy ? { _id: idOf(s.pharmacy), name: s.pharmacy.name || "" } : null,
      method: s.method,
      fee: s.fee || 0,
      // the platform's «پرو» share of the fee (the buyer paid fee - this)
      proDiscount: s.proDiscount || 0,
      payOnDelivery: !!s.payOnDelivery,
      originCity: s.originCity?.name || "",
      destinationCity: s.destinationCity?.name || "",
      ride: rideView(ridesByPharmacy.get(idOf(s.pharmacy))),
    });
  for (const l of lines)
    if (l.seller?.kind === "pharmacy" && !pharmacies.has(l.seller._id))
      pharmacies.set(l.seller._id, {
        _id: "",
        pharmacy: { _id: l.seller._id, name: l.seller.name },
        method: null,
        fee: 0,
        payOnDelivery: false,
        originCity: "",
        destinationCity: "",
        ride: rideView(ridesByPharmacy.get(l.seller._id)),
      });
  const address = order.address
    ? {
        displayName: order.address.displayName || "",
        address: order.address.address || "",
        receiverPhone: order.address.receiverPhone || "",
        postalCode: order.address.postalCode || "",
        city: order.address.city?.name || "",
      }
    : null;
  return {
    _id: String(order._id),
    user: order.user || null,
    status: order.status,
    paymentMethod: order.paymentMethod,
    subtotal: order.subtotal,
    tax: order.tax,
    deliveryFee: order.deliveryFee || 0,
    proDeliveryDiscount: order.proDeliveryDiscount || 0,
    total: order.total,
    submittedAt: order.submittedAt,
    paidAt: order.paidAt || null,
    address,
    lines,
    shipments: [...pharmacies.values()],
    transactions: ledger,
    payments: (payments as any[]).map((p) => ({
      _id: String(p._id),
      amount: p.amount,
      status: p.status,
      rrn: p.rrn || p.refNum || "",
      maskedPan: p.maskedPan || "",
      failureReason: p.failureReason || "",
      createdAt: p.createdAt,
    })),
    totals: { refunded, paidOut, commission },
    adminNotes: (order.adminNotes || []).map((n: any) => ({
      action: n.action,
      model: n.model || "",
      line: n.line ? String(n.line) : "",
      reason: n.reason,
      by: n.by ? n.by.username || n.by.phone || "" : "",
      at: n.at,
    })),
    samplings: await samplingViews(order, samplingDocs as any[], lineById),
    buyerAddresses: await buyerAddressesFor(order, samplingDocs as any[]),
    // a paid order with a line still waiting on its seller can be cancelled
    canCancel: order.status === "paid" && lines.some((l) => l.status === "pending"),
  };
};

// GET /admin/finance/orders/:nodeId
export const getOrder: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const data = await buildOrderDetail(nodeId);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getOrder", data });
  },
);

const reasonSchema = z.string().trim().min(3).max(1000);

const noteFor = (
  req: Request,
  action: "cancelOrder" | "cancelLine" | "fulfillLine" | "rescheduleSampling" | "cancelSampling",
  reason: string,
  model?: string,
  line?: unknown,
) => ({
  action,
  reason,
  ...(model && { model }),
  ...(line ? { line } : {}),
  by: req.user?._id,
  at: new Date(),
});

// Moves one pending line to `status` and settles it through the shared
// settlement (refund to the buyer's wallet, or the seller's payout minus
// commission). Conditional on "pending": a seller acting at the same moment,
// or a second click, wins/loses cleanly and nothing is paid twice.
// The seller org (and its owner account) a line pays out to.
const sellerOfLine = async (model: LineModel, itemId: string) => {
  const owner = LINE_OWNER[model];
  const catalog = itemId
    ? await mongoose
        .model(owner.model)
        .findById(itemId)
        .select(owner.field)
        .lean<Record<string, unknown>>()
    : null;
  const orgId = catalog?.[owner.field];
  const org = orgId
    ? await mongoose
        .model(owner.org)
        .findById(orgId)
        .select("user")
        .lean<{ _id: Types.ObjectId; user?: unknown }>()
    : null;
  return org?.user ? { user: org.user, org: { [owner.orgKey]: org._id } } : null;
};

const settleLineAsAdmin = async (
  orderId: string,
  model: LineModel,
  lineId: string,
  status: "fulfilled" | "cancelled",
  note: ReturnType<typeof noteFor>,
): Promise<"done" | "notPending" | "noSeller"> => {
  // a delivered line pays its seller: refuse up front when there is no
  // owner account to pay, rather than closing the line with nobody paid
  let seller: Awaited<ReturnType<typeof sellerOfLine>> = null;
  if (status === "fulfilled") {
    const current: any = await Order.findById(orderId).select(model).lean();
    const line = (current?.[model] || []).find((l: any) => String(l._id) === lineId);
    if (!line || line.status !== "pending") return "notPending";
    seller = await sellerOfLine(model, idOf(line.item));
    if (!seller) return "noSeller";
  }
  const updated = await Order.findOneAndUpdate(
    {
      _id: orderId,
      status: "paid",
      [model]: { $elemMatch: { _id: lineId, status: "pending" } },
    },
    {
      $set: { [`${model}.$.status`]: status },
      $push: { adminNotes: note },
    },
    { new: true },
  );
  if (!updated) return "notPending";
  const line = ((updated as any)[model] || []).find(
    (l: any) => String(l._id) === lineId,
  );
  const itemId = idOf(line?.item);
  if (status === "cancelled") {
    await settleOrderLine({ order: updated, model, itemId });
    await notifySellerOfBuyerCancel(updated._id, model, itemId, {
      title: "پشتیبانی یک قلم سفارش را لغو کرد",
      message: "این قلم توسط پشتیبانی لغو و مبلغش به خریدار برگشت؛ آن را ارسال نکنید.",
    });
    return "done";
  }
  // fulfilled: pay the seller org's owner, as the seller's own action would
  await settleOrderLine({
    order: updated,
    model,
    itemId,
    sellerUserId: seller?.user,
    org: seller?.org,
  });
  return "done";
};

const cancelOrderSchema = z.strictObject({ reason: reasonSchema });

// POST /admin/finance/orders/:nodeId/cancel  { reason }
// Cancels every line still waiting on its seller and refunds each to the
// buyer's wallet (the buyer's own cancel, done by support). Lines a seller
// already fulfilled stay as they are - their money has moved.
export const cancelOrder: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const { data, success } = cancelOrderSchema.safeParse(req.body || {});
    if (!success)
      return next(new AppError("دلیل لغو را بنویسید (دست‌کم ۳ حرف)", 400));
    const order: any = await Order.findById(nodeId).lean();
    if (!order) return next(new NotFoundError());
    if (order.status !== "paid")
      return next(new AppError("فقط سفارش پرداخت‌شده را می‌توان لغو کرد", 400));
    let cancelled = 0;
    for (const model of ORDER_LINE_MODELS)
      for (const line of order[model] || [])
        if (line.status === "pending") {
          const done = await settleLineAsAdmin(
            nodeId,
            model,
            String(line._id),
            "cancelled",
            noteFor(req, "cancelOrder", data.reason, model, line._id),
          );
          if (done === "done") cancelled++;
        }
    if (!cancelled)
      return next(new AppError("این سفارش قلم در انتظاری برای لغو ندارد", 409));
    await Notification.create({
      user: order.user,
      source: "System",
      title: "سفارش شما توسط پشتیبانی لغو شد",
      message: `مبلغ اقلام لغوشده به کیف پول شما برگشت. دلیل: ${data.reason}`,
      link: `/order/${order._id}`,
    }).catch(() => {});
    res.status(200).json({ message: "cancelOrder", data: { cancelled } });
  },
);

const lineStatusSchema = z.strictObject({
  model: z.enum(ORDER_LINE_MODELS),
  status: z.enum(["fulfilled", "cancelled"]),
  reason: reasonSchema,
});

// POST /admin/finance/orders/:nodeId/lines/:lineId/status  { model, status, reason }
// A line stuck "pending" (the seller is unreachable, or delivered but never
// marked it): support cancels it (refund) or marks it delivered (the seller
// is paid). Only pending lines - a finished line never flips back.
export const setLineStatus: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId, lineId } = req.params;
    if (!isValidObjectId(nodeId) || !isValidObjectId(lineId))
      return next(new NotFoundError());
    const { data, success } = lineStatusSchema.safeParse(req.body || {});
    if (!success)
      return next(new AppError("دلیل تغییر وضعیت را بنویسید (دست‌کم ۳ حرف)", 400));
    const done = await settleLineAsAdmin(
      nodeId,
      data.model,
      lineId,
      data.status,
      noteFor(
        req,
        data.status === "cancelled" ? "cancelLine" : "fulfillLine",
        data.reason,
        data.model,
        lineId,
      ),
    );
    if (done === "noSeller")
      return next(
        new AppError("فروشنده‌ی این قلم حساب مالک ندارد؛ ثبت تحویل و تسویه ممکن نیست", 409),
      );
    if (done !== "done")
      return next(
        new AppError("فقط قلمِ در انتظارِ یک سفارش پرداخت‌شده را می‌توان تغییر داد", 409),
      );
    if (data.status === "cancelled") {
      const order = await Order.findById(nodeId).select("user").lean();
      if (order)
        await Notification.create({
          user: order.user,
          source: "System",
          title: "یک قلم از سفارش شما لغو شد",
          message: `مبلغ این قلم به کیف پول شما برگشت. دلیل: ${data.reason}`,
          link: `/order/${nodeId}`,
        }).catch(() => {});
    }
    res.status(200).json({ message: "setLineStatus" });
  },
);

// ---- lab sampling appointments (2026-10, Lib/labSamplingReschedule.ts) ----
// Support moves an appointment (the buyer's own move, not limited by the
// lab's notice or the move count; the buyer and the lab are both told) or
// cancels it (its waiting tests refunded in full). Same functions as the
// buyer's and the lab's actions, with the reason kept on the order.
const samplingOfOrder = async (req: Request) => {
  const { nodeId, samplingId } = req.params;
  if (!isValidObjectId(nodeId) || !isValidObjectId(samplingId)) return null;
  return LabSampling.exists({ _id: samplingId, order: nodeId });
};

const rescheduleSamplingSchema = z.strictObject({
  kind: z.enum(["lab", "home"]).optional(),
  ymd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.number().int().min(0).max(1440),
  address: z.string().refine((v) => isValidObjectId(v)).optional(),
  reason: reasonSchema,
});

// POST /admin/finance/orders/:nodeId/samplings/:samplingId/reschedule
//   { kind?, ymd, start, address?, reason }
export const rescheduleOrderSampling: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!(await samplingOfOrder(req))) return next(new NotFoundError());
    const { data, success } = rescheduleSamplingSchema.safeParse(req.body || {});
    if (!success) return next(new AppError("دلیل جابه‌جایی را بنویسید (دست‌کم ۳ حرف)", 400));
    const { reason, ...slot } = data;
    const result = await rescheduleSampling({
      bookingId: req.params.samplingId,
      actor: "admin",
      actorUser: req.user?._id,
      reason,
      ...slot,
    });
    if ("error" in result) return next(new AppError(result.error, result.status));
    await Order.updateOne(
      { _id: req.params.nodeId },
      { $push: { adminNotes: noteFor(req, "rescheduleSampling", reason, "tests", req.params.samplingId) } },
    );
    res.status(200).json({ message: "rescheduleOrderSampling", data: { feeDelta: result.feeDelta } });
  },
);

// POST /admin/finance/orders/:nodeId/samplings/:samplingId/cancel  { reason }
export const cancelOrderSampling: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!(await samplingOfOrder(req))) return next(new NotFoundError());
    const { data, success } = cancelOrderSchema.safeParse(req.body || {});
    if (!success) return next(new AppError("دلیل لغو را بنویسید (دست‌کم ۳ حرف)", 400));
    const result = await cancelSamplingAppointment({
      bookingId: req.params.samplingId,
      actor: "admin",
      note: noteFor(req, "cancelSampling", data.reason),
    });
    if ("error" in result) return next(new AppError(result.error, result.status));
    await Notification.create({
      user: result.booking.user,
      source: "System",
      title: "نوبت نمونه‌گیری شما توسط پشتیبانی لغو شد",
      message: `مبلغ آزمایش‌های آن به کیف پول شما برگشت. دلیل: ${data.reason}`,
      link: `/order/${req.params.nodeId}`,
    }).catch(() => {});
    res.status(200).json({ message: "cancelOrderSampling", data: { cancelled: result.cancelled } });
  },
);

// POST /admin/finance/orders/:nodeId/lines/:lineId/cancel  { model, reason }
export const cancelOrderLine: RequestHandler = (req, res, next) => {
  req.body = { ...(req.body || {}), status: "cancelled" };
  return setLineStatus(req, res, next);
};

const deliverySchema = z.strictObject({ pharmacyId: z.string() });

const pharmacyOfOrder = async (req: Request) => {
  const { data, success } = deliverySchema.safeParse(req.body || {});
  if (!success || !isValidObjectId(data.pharmacyId)) throw new BadInputError();
  const pharmacy = await Pharmacy.findById(data.pharmacyId);
  if (!pharmacy) throw new NotFoundError("داروخانه");
  return pharmacy;
};

// POST /admin/finance/orders/:nodeId/delivery  { pharmacyId }
// Request a Snapp Box courier for one pharmacy's part of the order - the
// pharmacy panel's own dispatch (idempotent: an existing ride is returned),
// moved here from the devtools Snapp page.
export const dispatchDelivery: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const pharmacy = await pharmacyOfOrder(req);
    const ride = await dispatchDeliveryForPharmacy(pharmacy, nodeId);
    res.status(200).json({ message: "dispatchDelivery", data: { _id: ride._id } });
  },
);

// POST /admin/finance/orders/:nodeId/delivery/refresh  { pharmacyId }
export const refreshDelivery: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const pharmacy = await pharmacyOfOrder(req);
    const ride = await refreshDeliveryForPharmacy(pharmacy, nodeId);
    res.status(200).json({ message: "refreshDelivery", data: { _id: ride._id } });
  },
);

// ---- invoices (read-only, 2026-10) ----
// Models/Invoice.ts: the visit invoices of the older booking flow, with
// their manual checkout. Nothing creates them any more, but they stay
// visible for support and accounting.

const invoicePopulate = [
  { path: "user", select: USER_FIELDS },
  { path: "patient", select: "givenName lastName nationalId" },
  {
    path: "session",
    select: "doctor date start end",
    populate: { path: "doctor", select: "firstName lastName" },
  },
  { path: "checkout", select: "paidAt paymentMethod" },
];

const invoiceView = (i: any) => ({
  _id: String(i._id),
  user: i.user || null,
  patient: i.patient
    ? {
        _id: idOf(i.patient),
        name: [i.patient.givenName, i.patient.lastName].filter(Boolean).join(" "),
        nationalId: i.patient.nationalId || "",
      }
    : null,
  doctor: i.session?.doctor
    ? {
        _id: idOf(i.session.doctor),
        name: [i.session.doctor.firstName, i.session.doctor.lastName].filter(Boolean).join(" "),
      }
    : null,
  sessionDate: i.session?.date || "",
  sessionKind: i.sessionKind || "",
  total: i.total,
  payable: i.payable !== false,
  paid: !!i.checkout,
  paidAt: i.checkout?.paidAt || null,
  paymentMethod: i.checkout?.paymentMethod || "",
  submittedAt: i.submittedAt,
});

// GET /admin/finance/invoices?page=&limit=&status=paid|unpaid&q=&from=&to=&format=csv
export const listInvoices: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = listQuery.safeParse(req.query);
    if (!success) return next(new BadInputError());
    const filter: Record<string, unknown> = dateRange(data.from, data.to, "submittedAt");
    await userScope(filter, data);
    if (data.status === "paid" || data.status === "unpaid") {
      const paidIds = await mongoose.model("InvoiceCheckout").distinct("invoice");
      filter._id = data.status === "paid" ? { $in: paidIds } : { $nin: paidIds };
    }
    const { skip, limit } = pageWindow(data);
    const [rows, total] = await Promise.all([
      Invoice.find(filter)
        .sort({ submittedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate(invoicePopulate as any)
        .lean(),
      Invoice.countDocuments(filter),
    ]);
    const mapped = rows.map(invoiceView);
    if (data.format === "csv")
      return sendCsv(
        res,
        "invoices",
        ["شناسه", "کاربر", "بیمار", "کد ملی", "پزشک", "تاریخ ویزیت", "نوع ویزیت", "مبلغ", "قابل پرداخت", "پرداخت‌شده", "تاریخ پرداخت", "روش پرداخت", "تاریخ صدور"],
        mapped.map((i) => [i._id, userCsvLabel(i.user), i.patient?.name, i.patient?.nationalId, i.doctor?.name, i.sessionDate, i.sessionKind, i.total, i.payable ? "بله" : "خیر", i.paid ? "بله" : "خیر", i.paidAt, i.paymentMethod, i.submittedAt]),
      );
    res.status(200).json({
      message: "listInvoices",
      data: mapped,
      total,
      page: data.page,
      limit: data.limit,
    });
  },
);

// GET /admin/finance/invoices/:nodeId
export const getInvoice: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const row = await Invoice.findById(nodeId)
      .populate(invoicePopulate as any)
      .lean();
    if (!row) return next(new NotFoundError());
    res.status(200).json({ message: "getInvoice", data: invoiceView(row) });
  },
);

// ---- subscriptions overview (2026-10) ----
// Every provider's current plan in one list (Doctolib Pro / Practo Ray
// style "accounts & billing"): which plan, since when, until when, whether
// it is running out, and whether this period was paid for or granted
// (a free tier, or set by an admin).

const SUBSCRIPTION_KINDS = {
  doctorprofile: { license: "DoctorProfileLicense", org: "DoctorProfile", base: "BaseDoctorLicense", txOrg: "doctor", txLicense: "license", person: true },
  clinic: { license: "ClinicProfileLicense", org: "Clinic", base: "BaseClinicLicense", txOrg: "clinic", txLicense: "clinicLicense", person: false },
  hospital: { license: "HospitalProfileLicense", org: "Hospital", base: "BaseHospitalLicense", txOrg: "hospital", txLicense: "hospitalLicense", person: false },
  paraClinic: { license: "ParaClinicProfileLicense", org: "ParaClinic", base: "BaseParaClinicLicense", txOrg: "paraClinic", txLicense: "paraClinicLicense", person: false },
  pharmacy: { license: "PharmacyProfileLicense", org: "Pharmacy", base: "BasePharmacyLicense", txOrg: "pharmacy", txLicense: "pharmacyLicense", person: false },
  insurance: { license: "InsuranceProfileLicense", org: "Insurance", base: "BaseInsuranceLicense", txOrg: "insurance", txLicense: "insuranceLicense", person: false },
} as const;
type SubscriptionKind = keyof typeof SUBSCRIPTION_KINDS;
const subscriptionKinds = Object.keys(SUBSCRIPTION_KINDS) as SubscriptionKind[];

const EXPIRING_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;

const subscriptionQuery = pagingQuery.extend({
  kind: z.enum(subscriptionKinds as [SubscriptionKind, ...SubscriptionKind[]]).optional(),
  // active | expiring (within 14 days) | expired | unpaid
  status: z.enum(["active", "expiring", "expired", "unpaid"]).optional(),
});

const loadSubscriptions = async (kind: SubscriptionKind) => {
  const cfg = SUBSCRIPTION_KINDS[kind];
  const [licenses, purchases] = await Promise.all([
    mongoose
      .model(cfg.license)
      .find({})
      .select("owner displayName baseLicense startedAt expiresAt modules")
      .populate({
        path: "owner",
        model: cfg.org,
        select: cfg.person ? "firstName lastName user" : "name user",
        populate: { path: "user", select: "phone username" },
      })
      .populate({ path: "baseLicense", model: cfg.base, select: "displayName" })
      .limit(EXPORT_MAX)
      .lean(),
    // the latest plan purchase of each org (its wallet debit)
    Transaction.aggregate<{ _id: Types.ObjectId; at: Date; amount: number }>([
      { $match: { [cfg.txLicense]: { $exists: true }, [cfg.txOrg]: { $exists: true } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: `$${cfg.txOrg}`,
          at: { $first: "$createdAt" },
          amount: { $first: "$amount" },
        },
      },
    ]),
  ]);
  const lastPurchase = new Map(purchases.map((p) => [String(p._id), p]));
  const now = Date.now();
  return (licenses as any[]).map((l) => {
    const owner = l.owner && typeof l.owner === "object" ? l.owner : null;
    const ownerId = idOf(l.owner);
    const expires = l.expiresAt ? new Date(l.expiresAt).getTime() : null;
    const started = l.startedAt ? new Date(l.startedAt).getTime() : null;
    const purchase = lastPurchase.get(ownerId);
    // paid for this period: a purchase recorded when the period started
    const paid =
      !!purchase &&
      (started === null || new Date(purchase.at).getTime() >= started - 5 * 60 * 1000);
    const status =
      expires !== null && expires < now
        ? "expired"
        : expires !== null && expires - now <= EXPIRING_DAYS * DAY
          ? "expiring"
          : "active";
    return {
      _id: String(l._id),
      kind,
      provider: {
        _id: ownerId,
        name: owner
          ? (cfg.person
              ? [owner.firstName, owner.lastName].filter(Boolean).join(" ")
              : owner.name) || ""
          : "",
        owner: owner?.user
          ? { _id: idOf(owner.user), phone: owner.user.phone || "", username: owner.user.username || "" }
          : null,
      },
      plan:
        (l.baseLicense && typeof l.baseLicense === "object"
          ? l.baseLicense.displayName
          : "") ||
        l.displayName ||
        "",
      modules: Array.isArray(l.modules) ? l.modules.length : 0,
      startedAt: l.startedAt || null,
      expiresAt: l.expiresAt || null,
      daysLeft: expires === null ? null : Math.ceil((expires - now) / DAY),
      status,
      paid,
      lastPaidAmount: purchase ? Math.abs(purchase.amount || 0) : 0,
      lastPaidAt: purchase?.at || null,
    };
  });
};

// GET /admin/finance/subscriptions?kind=&status=&q=&page=&limit=&format=csv
export const listSubscriptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = subscriptionQuery.safeParse(req.query);
    if (!success) return next(new BadInputError());
    const all = (
      await Promise.all(
        (data.kind ? [data.kind] : subscriptionKinds).map(loadSubscriptions),
      )
    ).flat();
    const counts = {
      all: all.length,
      active: all.filter((r) => r.status === "active").length,
      expiring: all.filter((r) => r.status === "expiring").length,
      expired: all.filter((r) => r.status === "expired").length,
      unpaid: all.filter((r) => !r.paid && r.status !== "expired").length,
    };
    const q = data.q?.trim().toLowerCase();
    const rows = all
      .filter((r) =>
        !data.status
          ? true
          : data.status === "unpaid"
            ? !r.paid && r.status !== "expired"
            : r.status === data.status,
      )
      .filter(
        (r) =>
          !q ||
          r.provider.name.toLowerCase().includes(q) ||
          r.plan.toLowerCase().includes(q) ||
          (r.provider.owner?.phone || "").includes(q),
      )
      // what runs out first comes first; open-ended plans last
      .sort(
        (a, b) =>
          (a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity) -
          (b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity),
      );
    if (data.format === "csv")
      return sendCsv(
        res,
        "subscriptions",
        ["نوع", "ارائه‌دهنده", "مالک", "طرح", "شروع", "پایان", "روز مانده", "وضعیت", "پرداخت‌شده", "آخرین پرداخت", "تاریخ آخرین پرداخت"],
        rows.map((r) => [r.kind, r.provider.name, userCsvLabel(r.provider.owner), r.plan, r.startedAt, r.expiresAt, r.daysLeft, r.status, r.paid ? "بله" : "خیر", r.lastPaidAmount, r.lastPaidAt]),
      );
    const { skip, limit } = pageWindow(data);
    res.status(200).json({
      message: "listSubscriptions",
      data: rows.slice(skip, skip + limit),
      total: rows.length,
      page: data.page,
      limit: data.limit,
      counts,
    });
  },
);
