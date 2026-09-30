import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import Order, { orderStatuses } from "../Models/Order";
import Transaction from "../Models/Transaction";
import GatewayPayment, { gatewayPaymentStatuses } from "../Models/GatewayPayment";
import Wallet from "../Models/Wallet";

// Super admin money pages (2026-09): orders, the wallet ledger and gateway
// payments - read-only lists, plus the one manual action the payment flow
// needs: resolving a "needsReview" payment (card charged, wallet credit and
// the automatic reverse both failed).

const LIST_LIMIT = 500;
const USER_FIELDS = "phone username firstName lastName";

const listQuery = z.object({
  status: z.string().optional(),
  user: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
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

// GET /admin/finance/orders
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
    if (data.user && isValidObjectId(data.user)) filter.user = data.user;
    const orders = await Order.find(filter)
      .sort({ submittedAt: -1 })
      .limit(LIST_LIMIT)
      .populate({ path: "user", select: USER_FIELDS })
      .lean();
    const lineCount = (o: any) =>
      ["products", "productPackages", "services", "servicePackages", "tests"]
        .map((k) => (Array.isArray(o[k]) ? o[k] : []))
        .flat();
    res.status(200).json({
      message: "listOrders",
      data: orders.map((o: any) => {
        const lines = lineCount(o);
        return {
          _id: o._id,
          user: o.user || null,
          subtotal: o.subtotal,
          tax: o.tax,
          total: o.total,
          paymentMethod: o.paymentMethod,
          status: o.status,
          submittedAt: o.submittedAt,
          paidAt: o.paidAt,
          lines: lines.length,
          fulfilled: lines.filter((l: any) => l.status === "fulfilled").length,
          cancelled: lines.filter((l: any) => l.status === "cancelled").length,
        };
      }),
    });
  },
);

// GET /admin/finance/transactions
export const listTransactions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = listQuery.safeParse(req.query);
    if (!success) return next(new BadInputError());
    const filter: Record<string, unknown> = dateRange(data.from, data.to);
    if (data.user && isValidObjectId(data.user)) filter.user = data.user;
    const [rows, commissionTotal] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .limit(LIST_LIMIT)
        .populate({ path: "user", select: USER_FIELDS })
        .lean(),
      Transaction.aggregate<{ sum: number }>([
        { $match: { ...filter, commission: { $gt: 0 } } },
        { $group: { _id: null, sum: { $sum: "$commission" } } },
      ]),
    ]);
    // what the row is about, for the admin's "reason" column
    const kinds = [
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
      "checkout",
    ] as const;
    res.status(200).json({
      message: "listTransactions",
      data: rows.map((t: any) => ({
        _id: t._id,
        user: t.user || null,
        amount: t.amount,
        createdAt: t.createdAt,
        kind: kinds.find((k) => !!t[k]) || "other",
        ref: kinds.map((k) => t[k]).find(Boolean) || null,
        grossAmount: t.grossAmount,
        commission: t.commission,
        commissionPercent: t.commissionPercent,
      })),
      // the platform's income: commission taken on every payout so far
      commissionTotal: commissionTotal[0]?.sum || 0,
    });
  },
);

// GET /admin/finance/payments
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
    if (data.user && isValidObjectId(data.user)) filter.user = data.user;
    const rows = await GatewayPayment.find(filter)
      .sort({ createdAt: -1 })
      .limit(LIST_LIMIT)
      .select("-token")
      .populate({ path: "user", select: USER_FIELDS })
      .populate({ path: "resolvedBy", select: "phone username" })
      .lean();
    res.status(200).json({ message: "listPayments", data: rows });
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
        await Wallet.updateOne(
          { user: payment.user },
          { $inc: { balance: payment.amount } },
          { upsert: true },
        );
        const credit = await Transaction.create({
          user: payment.user,
          amount: payment.amount,
          gatewayPayment: payment._id,
        });
        creditId = credit._id;
      }
      await GatewayPayment.updateOne(
        { _id: payment._id },
        { $set: { transaction: creditId } },
      );
    }


    res.status(200).json({ message: "resolvePayment", data: { _id: payment._id } });
  },
);
