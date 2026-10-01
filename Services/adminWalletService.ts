import mongoose from "mongoose";
import AppError from "../Lib/AppError";
import Wallet from "../Models/Wallet";
import Transaction, {
  AdminTransactionAction,
  ITransaction,
} from "../Models/Transaction";

// Money an admin moves by hand (2026-10): manual wallet adjustment, admin
// refund of a reservation, reversal of a doctor's payout. Same ledger rules as
// the rest of the code (Controllers/bookingController.ts submitBookingNew,
// Services/reservationCancelService.ts, withdrawalController's releaseHold):
// one Transaction row per balance change, and a debit re-checks the balance in
// the same update so the wallet can never go below zero.
//
// The ledger row is written FIRST, carrying the admin form's one-time key
// (Transaction.adminRequestKey, unique): a resubmitted form (double click,
// retry after a timeout) hits the unique index and moves nothing a second
// time. If the balance update then fails, the row is removed again.

export type AdminWalletMove = {
  user: mongoose.Types.ObjectId | string;
  // signed: > 0 credits the wallet, < 0 debits it
  amount: number;
  action: AdminTransactionAction;
  adminBy: mongoose.Types.ObjectId | string;
  note: string;
  requestKey: string;
  // links the row to what it is about (reservation, doctor...)
  extra?: { reservation?: unknown; doctor?: unknown };
};

export type AdminWalletResult = {
  transaction: ITransaction;
  // true when this key was already used: nothing moved this time
  duplicate: boolean;
};

export const moveWalletMoneyByAdmin = async (
  move: AdminWalletMove,
): Promise<AdminWalletResult> => {
  if (!Number.isFinite(move.amount) || move.amount === 0)
    throw new AppError("مبلغ باید بیشتر از صفر باشد", 400);
  const amount = Math.round(move.amount);
  let transaction: ITransaction;
  try {
    transaction = (await Transaction.create({
      user: move.user,
      amount,
      adminAction: move.action,
      adminBy: move.adminBy,
      note: move.note,
      adminRequestKey: move.requestKey,
      ...(move.extra || {}),
    })) as unknown as ITransaction;
  } catch (err) {
    if ((err as { code?: number })?.code === 11000) {
      const existing = await Transaction.findOne({
        adminRequestKey: move.requestKey,
      });
      if (existing)
        return {
          transaction: existing as unknown as ITransaction,
          duplicate: true,
        };
    }
    throw err;
  }
  try {
    if (amount < 0) {
      const debited = await Wallet.findOneAndUpdate(
        { user: move.user, balance: { $gte: -amount } },
        { $inc: { balance: amount } },
      );
      if (!debited) {
        await Transaction.deleteOne({ _id: transaction._id });
        throw new AppError("موجودی کیف پول برای این برداشت کافی نیست", 400);
      }
    } else {
      await Wallet.updateOne(
        { user: move.user },
        { $inc: { balance: amount } },
        { upsert: true },
      );
    }
  } catch (err) {
    if (!(err instanceof AppError))
      await Transaction.deleteOne({ _id: transaction._id }).catch(() => {});
    throw err;
  }
  return { transaction, duplicate: false };
};
