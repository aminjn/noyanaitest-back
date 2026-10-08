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
import CentreWallet from "../Models/CentreWallet";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import { centreScope, personalScope, scopeBalance, WalletScope } from "../Lib/walletScope";

// The wallets of one user (2026-10, one wallet per centre): the personal
// one, then one per clinic / hospital the user owns. `id` is "" for the
// personal wallet, else the centre's id.
const walletsOf = async (userId: unknown) => {
  const [clinics, hospitals] = await Promise.all([
    Clinic.find({ user: userId }).sort({ _id: 1 }).select("name user").lean<{ _id: unknown; name?: string; user?: unknown }[]>(),
    Hospital.find({ user: userId }).sort({ _id: 1 }).select("name user").lean<{ _id: unknown; name?: string; user?: unknown }[]>(),
  ]);
  const personal = await scopeBalance(personalScope(userId));
  const centres = await Promise.all(
    [
      ...clinics.map((c) => ({ kind: "clinic" as const, c })),
      ...hospitals.map((c) => ({ kind: "hospital" as const, c })),
    ].map(async ({ kind, c }) => {
      const scope = centreScope(kind, c);
      return { id: String(c._id), kind, name: c.name || "", scope, ...(await scopeBalance(scope)) };
    }),
  );
  return { personal, centres };
};

// the wallet a request names (?wallet= / body.wallet): a centre the user
// owns, else the personal one; undefined when it names one they do not own
const pickWallet = async (userId: unknown, wallet: unknown): Promise<WalletScope | undefined> => {
  const id = typeof wallet === "string" ? wallet.trim() : "";
  if (!id) return personalScope(userId);
  if (!isValidObjectId(id)) return undefined;
  const clinic = await Clinic.findOne({ _id: id, user: userId }).select("user").lean<{ _id: unknown; user?: unknown }>();
  if (clinic) return centreScope("clinic", clinic);
  const hospital = await Hospital.findOne({ _id: id, user: userId }).select("user").lean<{ _id: unknown; user?: unknown }>();
  if (hospital) return centreScope("hospital", hospital);
  return undefined;
};

// One user's wallet in the super admin back office (2026-10, audit P1-3 /
// P2-6): the balance with its ledger, and a manual correction (credit or
// debit) that always carries its written reason. Full admins and staff
// with Finance "update" (Routers/adminWalletRouter.ts) - this is money.
// The correction is a normal ledger row (adminAction "adjustment"), so the
// user's own wallet history and the finance ledger show it like any other
// movement.

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
  // CRM automations and one-off SMS to a patient (2026-10)
  "smsAutomation",
  "smsMessage",
  // a patient's «پرو» membership (2026-10)
  "proPlan",
  "checkout",
] as const;

const ledgerSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
  // a centre's id: that clinic's / hospital's wallet; empty: personal
  wallet: z.string().max(40).optional(),
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
    const scope = await pickWallet(userId, parsed.data.wallet);
    if (!scope) return next(new NotFoundError("کیف پول"));
    const centreWallet = scope.centre
      ? (await CentreWallet.findOne({ kind: scope.centre.kind, centre: scope.centre.id }).select("_id").lean())?._id
      : null;
    // a centre's ledger is its own wallet's rows; the personal one is the
    // user's rows that moved no centre wallet
    const rowFilter = scope.centre
      ? { centreWallet: centreWallet || null }
      : { user: userId, centreWallet: { $exists: false } };
    const all = await walletsOf(userId);
    const [wallet, rows, total] = await Promise.all([
      scopeBalance(scope),
      Transaction.find(rowFilter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate({ path: "adminBy", select: USER_FIELDS })
        .lean(),
      Transaction.countDocuments(rowFilter),
    ]);
    res.status(200).json({
      message: "getUserWallet",
      data: {
        data: {
          balance: wallet?.balance ?? 0,
          // earnings in their settlement hold (Lib/payoutHold.ts)
          pending: wallet?.pending ?? 0,
          // the wallet shown and the others to switch to
          wallet: scope.centre ? String(scope.centre.id) : "",
          wallets: [
            { id: "", kind: "personal", name: "", balance: all.personal.balance, pending: all.personal.pending },
            ...all.centres.map(({ id, kind, name, balance, pending }) => ({ id, kind, name, balance, pending })),
          ],
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
  // a centre's id: that clinic's / hospital's own wallet; empty: personal
  wallet: z.string().max(40).optional(),
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
    const scope = await pickWallet(user._id, input.wallet);
    if (!scope) return next(new NotFoundError("کیف پول"));
    const { transaction, duplicate } = await moveWalletMoneyByAdmin({
      scope,
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
        link: scope.centre ? `/${scope.centre.kind}panel/finance/wallet` : "/dashboard/transaction",
      }).catch(() => {});
    if (!duplicate)
      notifyWithSms(input.direction === "credit" ? "walletCreditedUser" : "walletDebitedUser", user._id, {
        amount: smsAmount(input.amount),
        reason: input.reason,
      });
    const wallet = await scopeBalance(scope);
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
