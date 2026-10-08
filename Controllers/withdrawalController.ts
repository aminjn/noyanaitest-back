import { notifyWithSms, smsAmount } from "../Services/notificationSmsService";
import { postWithdrawalPaid } from "../Lib/business/ledgerPoster";
import { getWithdrawalMinAmount, pendingSummaryOf } from "../Lib/payoutHold";
import {
  centreScope,
  creditScope,
  debitScope,
  personalScope,
  scopeBalance,
  scopeOfRow,
  scopeTxFields,
  WalletScope,
} from "../Lib/walletScope";
import { isMultiCentreKind, MultiCentreKind } from "../Lib/activeCentre";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import {
  pagingQuery,
  pageWindow,
  searchUserIds,
  sendCsv,
  userCsvLabel,
} from "../Lib/adminListing";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import Transaction from "../Models/Transaction";
import Notification from "../Models/Notification";
import WithdrawalRequest from "../Models/WithdrawalRequest";
import { notifyUserAlertSubscribers } from "../Services/userAlertService";

// Wallet -> bank withdrawals (2026-09). One flow for every wallet: patients
// (refunds), doctors, pharmacies and labs (payouts are credited to the
// owner's wallet) on /user/withdrawal, and since 2026-10 each clinic and
// hospital on its own wallet (Models/CentreWallet.ts) on
// /<clinic|hospital>/withdrawal, for the panel's active centre. The amount
// is held on request; an admin pays it by bank transfer and records the
// reference, or rejects it (the hold is returned to the wallet it came
// from).

const PANEL_LINK = "/dashboard/transaction";
const centrePanelLink: Record<MultiCentreKind, string> = {
  clinic: "/clinicpanel/finance/wallet",
  hospital: "/hospitalpanel/finance/wallet",
};

// which wallet a request on this route is about: the active centre on a
// clinic / hospital route (aclController.useAcl set req.clinic /
// req.hospital), else the user's own
const scopeOfReq = (req: Request): WalletScope | null => {
  const name = req.params?.name;
  if (isMultiCentreKind(name)) {
    const centre = req[name];
    return centre ? centreScope(name, centre as { _id: unknown; user?: unknown }) : null;
  }
  return req.user ? personalScope(req.user._id) : null;
};

// the requests of one wallet: a centre's own, or the user's personal ones
const requestFilter = async (scope: WalletScope) =>
  scope.centre
    ? { centreWallet: (await scopeTxFields(scope)).centreWallet }
    : { user: scope.user, centreWallet: { $exists: false } };

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

// GET /user/withdrawal, /<clinic|hospital>/withdrawal
export const getMyWithdrawals: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const scope = scopeOfReq(req);
    if (!req.user || !scope) return next(new MiddlewareError());
    const [wallet, requests, minAmount] = await Promise.all([
      scopeBalance(scope),
      WithdrawalRequest.find(await requestFilter(scope))
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
        ...(await pendingSummaryOf(scope)),
        minAmount,
        // a centre's withdrawal is the owner's to ask; staff only see it
        canWithdraw: !scope.centre || req.aclGrant === "FULL",
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

// POST /user/withdrawal, /<clinic|hospital>/withdrawal (owner only)
export const createWithdrawal: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const scope = scopeOfReq(req);
    if (!req.user || !scope) return next(new MiddlewareError());
    const { data, success } = createSchema.safeParse(req.body || {});
    if (!success) return next(new BadInputError());
    const iban = normalizeIban(data.iban);
    if (!iban) return next(new AppError("شماره شبا معتبر نیست", 400));
    // the minimum is set by the super admin (finance settings -> wallet);
    // the number is formatted for the reader by translateMessage
    const minimum = await getWithdrawalMinAmount();
    if (data.amount < minimum)
      return next(new AppError(`حداقل مبلغ برداشت ${minimum} تومان است`, 400));
    const pendingExists = () =>
      next(new AppError("یک درخواست برداشت در حال بررسی دارید", 409));
    const own = await requestFilter(scope);
    if (await WithdrawalRequest.exists({ ...own, status: "pending" }))
      return pendingExists();
    const walletFields = await scopeTxFields(scope);
    // The request is written first: the unique "one pending request per
    // user" index makes a second, simultaneous request fail here, before
    // any money moves. Then the amount is held atomically (never below
    // zero) and the hold is put in the ledger; a failed step undoes the
    // earlier ones, so money is never held without a request or a ledger
    // row (it used to be debited first and lost if a later write failed).
    let request;
    try {
      request = await WithdrawalRequest.create({
        user: req.user._id,
        amount: data.amount,
        iban,
        holderName: data.holderName,
        ...(scope.centre
          ? { centreWallet: walletFields.centreWallet, centreKind: scope.centre.kind, centre: scope.centre.id }
          : {}),
      });
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) return pendingExists();
      throw err;
    }
    const held = await debitScope(scope, data.amount);
    if (!held) {
      await WithdrawalRequest.deleteOne({ _id: request._id });
      return next(new AppError("موجودی کیف پول شما کافی نیست", 400));
    }
    let hold;
    try {
      hold = await Transaction.create({
        user: req.user._id,
        amount: -data.amount,
        withdrawal: request._id,
        ...walletFields,
      });
    } catch (err) {
      await creditScope(scope, data.amount);
      await WithdrawalRequest.deleteOne({ _id: request._id });
      throw err;
    }
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

// returns a held amount to the wallet it was held from (reject / cancel),
// exactly once
const releaseHold = async (request: { _id: unknown; user: unknown; amount: number; centreWallet?: unknown }) => {
  const existing = await Transaction.exists({ withdrawal: request._id, amount: { $gt: 0 } });
  if (existing) return existing._id;
  const scope = await scopeOfRow(request);
  await creditScope(scope, request.amount);
  const refund = await Transaction.create({
    user: request.user,
    amount: request.amount,
    withdrawal: request._id,
    ...(await scopeTxFields(scope)),
  });
  return refund._id;
};

// PUT /user/withdrawal/:nodeId, /<clinic|hospital>/withdrawal/:nodeId - the
// user (a centre's owner) cancels a pending request
export const cancelMyWithdrawal: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const scope = scopeOfReq(req);
    if (!req.user || !scope) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const request = await WithdrawalRequest.findOneAndUpdate(
      { _id: nodeId, ...(await requestFilter(scope)), status: "pending" },
      { $set: { status: "cancelled", decidedAt: new Date() } },
      { new: true },
    );
    if (!request) return next(new NotFoundError());
    const refundId = await releaseHold(request);
    await WithdrawalRequest.updateOne({ _id: request._id }, { $set: { refundTransaction: refundId } });
    res.status(200).json({ message: "cancelMyWithdrawal" });
  },
);

// aggregate() does not cast like find(): user ids in a $match must be ObjectIds
const castUserIds = (filter: Record<string, unknown>) => {
  const toId = (v: unknown) =>
    typeof v === "string" && isValidObjectId(v) ? new Types.ObjectId(v) : v;
  const castUser = (cond: any) =>
    cond?.user?.$in ? { ...cond, user: { $in: cond.user.$in.map(toId) } } : cond;
  const out = castUser({ ...filter });
  if (Array.isArray(out.$or)) out.$or = out.$or.map(castUser);
  return out as Record<string, unknown>;
};

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
    // pending first, then newest. A plain sort on `status` is alphabetical
    // ("cancelled" < "paid" < "pending"), which buried the requests waiting
    // for a transfer under the finished ones.
    const ordered = async () => {
      const rows = await WithdrawalRequest.aggregate([
        { $match: castUserIds(filter) },
        { $addFields: { _waiting: { $cond: [{ $eq: ["$status", "pending"] }, 0, 1] } } },
        { $sort: { _waiting: 1, createdAt: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: { _waiting: 0 } },
      ]);
      const populated = await WithdrawalRequest.populate(rows, [
        { path: "user", select: "phone username firstName lastName" },
        { path: "decidedBy", select: "phone username" },
      ]);
      return withCentreNames(populated as unknown as Record<string, unknown>[]);
    };
    const [data, total, pendingSum] = await Promise.all([
      ordered(),
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
        ["شناسه", "کاربر", "کیف پول", "مبلغ", "شبا", "صاحب حساب", "وضعیت", "کد پیگیری", "توضیح", "تاریخ درخواست", "تاریخ رسیدگی"],
        data.map((w: any) => [String(w._id), userCsvLabel(w.user), w.centreName || "شخصی", w.amount, w.iban, w.holderName, w.status, w.trackingCode, w.adminNote, w.createdAt, w.decidedAt]),
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

// a centre's request shows the centre it is for (one wallet per centre)
const withCentreNames = async (rows: Record<string, unknown>[]) => {
  const ids = (kind: string) => rows.filter((r) => r.centreKind === kind && r.centre).map((r) => r.centre);
  const [clinics, hospitals] = await Promise.all([
    Clinic.find({ _id: { $in: ids("clinic") } }).select("name").lean<{ _id: unknown; name?: string }[]>(),
    Hospital.find({ _id: { $in: ids("hospital") } }).select("name").lean<{ _id: unknown; name?: string }[]>(),
  ]);
  const names = new Map<string, string>();
  for (const c of [...clinics, ...hospitals]) names.set(String(c._id), c.name || "");
  return rows.map((r) => (r.centre ? { ...r, centreName: names.get(String(r.centre)) || "" } : r));
};

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
      const refundId = await releaseHold(request);
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
      link: request.centreKind ? centrePanelLink[request.centreKind] : PANEL_LINK,
    }).catch(() => {});
    if (data.decision === "paid")
      notifyWithSms("withdrawalPaidProvider", request.user, {
        amount: smsAmount(request.amount),
        trackingCode: data.trackingCode || "",
      });
    else
      notifyWithSms("withdrawalRejectedProvider", request.user, {
        amount: smsAmount(request.amount),
        reason: data.note || "",
      });
    res.status(200).json({ message: "adminDecideWithdrawal" });
  },
);

// GET /<clinic|hospital>/wallet - the active centre's own wallet and, for
// its spending (plan, SMS: Lib/walletScope.ts debitSpending), the owner's
// personal balance that pays when the centre's does not cover a bill
export const getMyCentreWallet: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const scope = scopeOfReq(req);
    if (!req.user || !scope?.centre) return next(new MiddlewareError());
    const [own, personal] = await Promise.all([
      scopeBalance(scope),
      // the owner's own money is shown to the owner only
      req.aclGrant === "FULL" ? scopeBalance(personalScope(req.user._id)) : null,
    ]);
    res.status(200).json({
      message: "getMyCentreWallet",
      data: { balance: own.balance, pending: own.pending, personalBalance: personal?.balance ?? null },
    });
  },
);
