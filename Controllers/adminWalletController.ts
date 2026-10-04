import { notifyWithSms, smsAmount } from "../Services/notificationSmsService";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import User from "../Models/User";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import Notification from "../Models/Notification";
import { moveWalletMoneyByAdmin } from "../Services/adminWalletService";

// One user's wallet in the super admin back office (2026-10, audit P1-3 /
// P2-6): the balance with its ledger, and a manual correction (credit or
// debit) that always carries its written reason. Full admins only - this
// is money. The correction is a normal ledger row (adminAction
// "adjustment"), so the user's own wallet history and the finance ledger
// show it like any other movement.

const MAX_LIMIT = 100;
const USER_FIELDS = "phone username";

// what a ledger row is about (same order as the finance ledger)
const KINDS = [
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
  "checkout",
] as const;

const ledgerSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
});

// GET /admin/wallet/:userId?page=&limit=
export const getUserWallet: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { userId } = req.params;
    if (!isValidObjectId(userId)) return next(new NotFoundError("کاربر"));
    const parsed = ledgerSchema.safeParse(req.query);
    if (!parsed.success) return next(new BadInputError());
    const { page, limit } = parsed.data;
    if (!(await User.exists({ _id: userId }))) return next(new NotFoundError("کاربر"));
    const [wallet, rows, total] = await Promise.all([
      Wallet.findOne({ user: userId }).select("balance pending").lean(),
      Transaction.find({ user: userId })
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate({ path: "adminBy", select: USER_FIELDS })
        .lean(),
      Transaction.countDocuments({ user: userId }),
    ]);
    res.status(200).json({
      message: "getUserWallet",
      data: {
        data: {
          balance: wallet?.balance ?? 0,
          // earnings in their settlement hold (Lib/payoutHold.ts)
          pending: wallet?.pending ?? 0,
          items: rows.map((t: any) => ({
            _id: t._id,
            amount: t.amount,
            createdAt: t.createdAt,
            held: !!t.held,
            availableAt: t.availableAt,
            kind: t.adminAction === "adjustment" ? "adminAdjustment" : KINDS.find((k) => !!t[k]) || "other",
            ref: KINDS.map((k) => t[k]).find(Boolean) || null,
            adminAction: t.adminAction,
            adminBy: t.adminBy || null,
            note: t.note,
          })),
          total,
          page,
          limit,
        },
      },
    });
  },
);

const adjustSchema = z.strictObject({
  direction: z.enum(["credit", "debit"]),
  amount: z.coerce.number().int().positive().max(1_000_000_000),
  reason: z.string().trim().min(5).max(500),
  // the form's one-time key: a resubmitted form moves the money once
  requestKey: z.string().trim().min(8).max(100),
});

// POST /admin/wallet/:userId/adjust
export const adjustUserWallet: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { userId } = req.params;
    if (!isValidObjectId(userId)) return next(new NotFoundError("کاربر"));
    const parsed = adjustSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError());
    const input = parsed.data;
    const user = await User.findById(userId).select("status");
    if (!user) return next(new NotFoundError("کاربر"));
    if ((user as any).status === "deleted")
      return next(new AppError("کیف پول حساب حذف‌شده قابل اصلاح نیست", 400));
    const signed = input.direction === "credit" ? input.amount : -input.amount;
    const { transaction, duplicate } = await moveWalletMoneyByAdmin({
      user: user._id,
      amount: signed,
      action: "adjustment",
      adminBy: req.user!._id,
      note: input.reason,
      requestKey: `wallet:${input.requestKey}`,
    });
    if (!duplicate)
      Notification.create({
        user: user._id,
        source: "System",
        title: "کیف پول شما اصلاح شد",
        message:
          input.direction === "credit"
            ? `پشتیبانی ${input.amount.toLocaleString("fa-IR")} تومان به کیف پول شما افزود. توضیح: ${input.reason}`
            : `پشتیبانی ${input.amount.toLocaleString("fa-IR")} تومان از کیف پول شما کسر کرد. توضیح: ${input.reason}`,
        link: "/dashboard/transaction",
      }).catch(() => {});
    if (!duplicate)
      notifyWithSms(input.direction === "credit" ? "walletCreditedUser" : "walletDebitedUser", user._id, {
        amount: smsAmount(input.amount),
        reason: input.reason,
      });
    const wallet = await Wallet.findOne({ user: user._id }).select("balance").lean();
    res.status(200).json({
      message: "adjustUserWallet",
      data: {
        data: {
          transaction: transaction._id,
          duplicate,
          balance: wallet?.balance ?? 0,
        },
      },
    });
  },
);
