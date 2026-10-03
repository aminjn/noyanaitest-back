import { postWithdrawalPaid } from "../Lib/business/ledgerPoster";
import { getWithdrawalMinAmount, pendingSummary } from "../Lib/payoutHold";
import {
  pagingQuery,
  pageWindow,
  searchUserIds,
  sendCsv,
  userCsvLabel,
} from "../Lib/adminListing";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import Notification from "../Models/Notification";
import WithdrawalRequest from "../Models/WithdrawalRequest";
import { notifyUserAlertSubscribers } from "../Services/userAlertService";

// Wallet -> bank withdrawals (2026-09). One flow for every user: patients
// (refunds), doctors, pharmacies and labs (payouts are credited to the
// owner's wallet). The amount is held on request; an admin pays it by bank
// transfer and records the reference, or rejects it (the hold is returned).

const PANEL_LINK = "/dashboard/transaction";

// Iranian Sheba: "IR" + 24 digits, ISO 13616 mod-97 checksum
export const normalizeIban = (raw: string) => {
  const value = raw
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/\s|-/g, "")
    .toUpperCase();
  const iban = value.startsWith("IR") ? value : `IR${value}`;
  if (!/^IR\d{24}$/.test(iban)) return null;
  const rearranged = iban.slice(4) + "1827" + iban.slice(2, 4); // I=18 R=27
  let rem = 0;
  for (const ch of rearranged) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1 ? iban : null;
};

// GET /user/withdrawal
export const getMyWithdrawals: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const [wallet, requests, minAmount] = await Promise.all([
      Wallet.findOne({ user: req.user._id }).select("balance").lean(),
      WithdrawalRequest.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .select("-holdTransaction -refundTransaction -decidedBy")
        .lean(),
      getWithdrawalMinAmount(),
    ]);
    res.status(200).json({
      message: "getMyWithdrawals",
      data: {
        balance: wallet?.balance || 0,
        // settlement hold (Lib/payoutHold.ts)
        ...(await pendingSummary(req.user._id)),
        minAmount,
        requests,
        // prefill the form with the last account used
        last: requests[0]
          ? { iban: requests[0].iban, holderName: requests[0].holderName }
          : null,
      },
    });
  },
);

const createSchema = z.strictObject({
  amount: z.coerce.number().int().positive(),
  iban: z.string().max(40),
  holderName: z.string().trim().min(2).max(100),
});

// POST /user/withdrawal
export const createWithdrawal: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = createSchema.safeParse(req.body || {});
    if (!success) return next(new BadInputError());
    const iban = normalizeIban(data.iban);
    if (!iban) return next(new AppError("شماره شبا معتبر نیست", 400));
    // the minimum is set by the super admin (finance settings -> wallet);
    // the number is formatted for the reader by translateMessage
    const minimum = await getWithdrawalMinAmount();
    if (data.amount < minimum)
      return next(new AppError(`حداقل مبلغ برداشت ${minimum} تومان است`, 400));
    if (await WithdrawalRequest.exists({ user: req.user._id, status: "pending" }))
      return next(new AppError("یک درخواست برداشت در حال بررسی دارید", 409));
    // hold the amount atomically: never below zero, never twice
    const held = await Wallet.findOneAndUpdate(
      { user: req.user._id, balance: { $gte: data.amount } },
      { $inc: { balance: -data.amount } },
      { new: true },
    );
    if (!held) return next(new AppError("موجودی کیف پول شما کافی نیست", 400));
    const request = await WithdrawalRequest.create({
      user: req.user._id,
      amount: data.amount,
      iban,
      holderName: data.holderName,
    });
    const hold = await Transaction.create({
      user: req.user._id,
      amount: -data.amount,
      withdrawal: request._id,
    });
    await WithdrawalRequest.updateOne({ _id: request._id }, { $set: { holdTransaction: hold._id } });
    notifyUserAlertSubscribers(
      "newWithdrawalRequest",
      {
        title: "درخواست برداشت جدید",
        message: `کاربر ${req.user.phone} درخواست برداشت ${data.amount.toLocaleString("fa-IR")} تومان ثبت کرد.`,
        link: "/notadmin/finance/withdrawals",
      },
      {
        requestId: request._id.toString(),
        userPhone: req.user.phone,
        amount: String(data.amount),
      },
    ).catch(() => {});
    res.status(200).json({ message: "createWithdrawal", data: { _id: request._id } });
  },
);

// returns a held amount to the wallet (reject / cancel), exactly once
const releaseHold = async (requestId: unknown, userId: unknown, amount: number) => {
  const existing = await Transaction.exists({ withdrawal: requestId, amount: { $gt: 0 } });
  if (existing) return existing._id;
  await Wallet.updateOne({ user: userId }, { $inc: { balance: amount } }, { upsert: true });
  const refund = await Transaction.create({ user: userId, amount, withdrawal: requestId });
  return refund._id;
};

// PUT /user/withdrawal/:nodeId - the user cancels a pending request
export const cancelMyWithdrawal: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const request = await WithdrawalRequest.findOneAndUpdate(
      { _id: nodeId, user: req.user._id, status: "pending" },
      { $set: { status: "cancelled", decidedAt: new Date() } },
      { new: true },
    );
    if (!request) return next(new NotFoundError());
    const refundId = await releaseHold(request._id, req.user._id, request.amount);
    await WithdrawalRequest.updateOne({ _id: request._id }, { $set: { refundTransaction: refundId } });
    res.status(200).json({ message: "cancelMyWithdrawal" });
  },
);

// GET /admin/finance/withdrawals?status=&q=&from=&to=&page=&limit=&format=csv
// Server-paged (2026-10, was capped at 500): pending first, then newest.
const adminWithdrawalsQuery = pagingQuery.extend({
  status: z.enum(["pending", "paid", "rejected", "cancelled"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const adminListWithdrawals: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = adminWithdrawalsQuery.safeParse(req.query);
    if (!parsed.success) return next(new BadInputError());
    const query = parsed.data;
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.from || query.to)
      filter.createdAt = {
        ...(query.from && { $gte: query.from }),
        ...(query.to && { $lte: query.to }),
      };
    const q = query.q?.trim();
    // a pasted Sheba / bank reference finds its request
    // digits may be a Sheba, a bank reference or the user's phone
    if (q && /^(IR)?\d{6,}$/i.test(q.replace(/\s/g, "")))
      filter.$or = [
        { iban: new RegExp(q.replace(/\s/g, "").replace(/^IR/i, ""), "i") },
        { trackingCode: q },
        { user: { $in: await searchUserIds(q) } },
      ];
    else if (q) filter.user = { $in: await searchUserIds(q) };
    const { skip, limit } = pageWindow(query);
    const [data, total, pendingSum] = await Promise.all([
      WithdrawalRequest.find(filter)
        .sort({ status: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: "user", select: "phone username firstName lastName" })
        .populate({ path: "decidedBy", select: "phone username" })
        .lean(),
      WithdrawalRequest.countDocuments(filter),
      WithdrawalRequest.aggregate<{ sum: number; count: number }>([
        { $match: { status: "pending" } },
        { $group: { _id: null, sum: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
    ]);
    if (query.format === "csv")
      return sendCsv(
        res,
        "withdrawals",
        ["شناسه", "کاربر", "مبلغ", "شبا", "صاحب حساب", "وضعیت", "کد پیگیری", "توضیح", "تاریخ درخواست", "تاریخ رسیدگی"],
        data.map((w: any) => [String(w._id), userCsvLabel(w.user), w.amount, w.iban, w.holderName, w.status, w.trackingCode, w.adminNote, w.createdAt, w.decidedAt]),
      );
    res.status(200).json({
      message: "adminListWithdrawals",
      data,
      total,
      page: query.page,
      limit: query.limit,
      // what is waiting to be transferred, whatever the filter
      pending: { count: pendingSum[0]?.count || 0, sum: pendingSum[0]?.sum || 0 },
    });
  },
);

const decideSchema = z.strictObject({
  decision: z.enum(["paid", "rejected"]),
  trackingCode: z.string().trim().max(100).optional(),
  note: z.string().trim().max(1000).optional(),
});

// POST /admin/finance/withdrawals/:nodeId/decide
export const adminDecideWithdrawal: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const { data, success } = decideSchema.safeParse(req.body || {});
    if (!success) return next(new BadInputError());
    if (data.decision === "paid" && !data.trackingCode)
      return next(new AppError("کد پیگیری انتقال بانکی را وارد کنید", 400));
    if (data.decision === "rejected" && !data.note)
      return next(new AppError("دلیل رد درخواست را بنویسید", 400));
    // claim: only a pending request is decided, and only once
    const request = await WithdrawalRequest.findOneAndUpdate(
      { _id: nodeId, status: "pending" },
      {
        $set: {
          status: data.decision,
          trackingCode: data.trackingCode,
          adminNote: data.note,
          decidedBy: req.user?._id,
          decidedAt: new Date(),
        },
      },
      { new: true },
    );
    if (!request) return next(new AppError("این درخواست در انتظار بررسی نیست", 409));
    if (data.decision === "rejected") {
      const refundId = await releaseHold(request._id, request.user, request.amount);
      await WithdrawalRequest.updateOne({ _id: request._id }, { $set: { refundTransaction: refundId } });
    }
    // the bank transfer goes into the books (the ledger sweep retries it)
    if (data.decision === "paid") postWithdrawalPaid(request._id).catch(() => {});
    const amount = request.amount.toLocaleString("fa-IR");
    await Notification.create({
      user: request.user,
      source: "System",
      title: data.decision === "paid" ? "برداشت شما واریز شد" : "درخواست برداشت شما رد شد",
      message:
        data.decision === "paid"
          ? `${amount} تومان به حساب شما واریز شد. کد پیگیری: ${data.trackingCode}`
          : `${amount} تومان به کیف پول شما برگشت. دلیل: ${data.note}`,
      link: PANEL_LINK,
    }).catch(() => {});
    res.status(200).json({ message: "adminDecideWithdrawal" });
  },
);
