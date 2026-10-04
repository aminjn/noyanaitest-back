import { notifyWithSms, smsAmount } from "../Services/notificationSmsService";
import { getAppConfig } from "./appConfig";
import mongoose from "mongoose";
import GlobalFinanceSettings from "../Models/GlobalFinanceSettings";
import Transaction, { ITransaction } from "../Models/Transaction";
import Wallet from "../Models/Wallet";
import Notification from "../Models/Notification";

// Settlement hold (2026-10): a provider's earning (a visit's payout, a
// fulfilled order line) is not withdrawable at once. It sits in
// Wallet.pending for GlobalFinanceSettings.payoutHoldDays (15 by default)
// after the service was done, so a complaint or a refund can still be
// settled from it; then the release sweep moves it into Wallet.balance.
// Doctolib and Practo hold payouts the same way; Paziresh24 settles in a
// fixed cycle.

const DAY_MS = 24 * 60 * 60 * 1000;

export const getPayoutHoldDays = async (): Promise<number> => {
  const settings = await GlobalFinanceSettings.findOneAndUpdate(
    { singleton: "SINGLETON" },
    {},
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  const days = Number(settings?.payoutHoldDays ?? 15);
  return Number.isFinite(days) && days > 0 ? Math.min(days, 90) : 0;
};

const walletOf = (userId: unknown) =>
  Wallet.findOneAndUpdate(
    { user: userId },
    { user: userId },
    { upsert: true, new: true },
  );

// Writes one earning row and credits it: into pending while it's held, or
// straight into balance when the hold is 0 days or the amount is not
// positive. Returns the transaction.
export const creditEarning = async (
  userId: mongoose.Types.ObjectId | string,
  amount: number,
  fields: Partial<ITransaction> & Record<string, unknown>,
) => {
  const days = amount > 0 ? await getPayoutHoldDays() : 0;
  const wallet = await walletOf(userId);
  const held = days > 0;
  const tx = await Transaction.create({
    ...fields,
    user: userId,
    amount,
    ...(held
      ? { held: true, availableAt: new Date(Date.now() + days * DAY_MS) }
      : {}),
  });
  if (amount !== 0)
    await Wallet.findByIdAndUpdate(wallet._id, {
      $inc: held ? { pending: amount } : { balance: amount },
    });
  return tx;
};

// Moves one held earning into the balance. The flip of `held` is the lock:
// whoever flips it moves the money, so the sweep and an early release can
// never move it twice.
const releaseOne = async (txId: unknown): Promise<ITransaction | null> => {
  const tx = await Transaction.findOneAndUpdate(
    { _id: txId, held: true },
    { $set: { held: false, releasedAt: new Date() } },
    { new: true },
  ).lean<ITransaction>();
  if (!tx) return null;
  const amount = Math.max(0, tx.amount || 0);
  if (amount > 0) {
    await walletOf(tx.user);
    // pending can't go below 0 even if older data is off
    const wallet = await Wallet.findOne({ user: tx.user }).select("pending").lean();
    const fromPending = Math.min(amount, Math.max(0, wallet?.pending || 0));
    await Wallet.updateOne(
      { user: tx.user },
      { $inc: { balance: amount, pending: -fromPending } },
    );
  }
  // the move from pending to withdrawable goes into the books
  import("./business/ledgerPoster")
    .then((m) => m.postRelease(tx._id))
    .catch((err) => console.log("[business] release posting failed:", err));
  return tx;
};

// Releases the held earnings that match (e.g. one reservation's payout)
// right now, before their date - used before a payout is reversed, so the
// reversal debits a balance that actually holds the money.
export const releaseHeldEarly = async (filter: Record<string, unknown>) => {
  const rows = await Transaction.find({ ...filter, held: true }).select("_id").lean();
  for (const row of rows) await releaseOne(row._id);
  return rows.length;
};

// The hourly sweep: every held earning whose date has passed becomes
// withdrawable, and each provider gets one notice for the batch.
export const runPayoutReleaseSweep = async (): Promise<number> => {
  const due = await Transaction.find({ held: true, availableAt: { $lte: new Date() } })
    .select("_id")
    .limit(2000)
    .lean();
  const perUser = new Map<string, number>();
  for (const row of due) {
    const tx = await releaseOne(row._id);
    if (tx && tx.amount > 0) {
      const key = String(tx.user);
      perUser.set(key, (perUser.get(key) || 0) + tx.amount);
    }
  }
  for (const [user, total] of perUser) {
    await Notification.create({
      user,
      source: "System",
      title: "درآمد شما قابل برداشت شد",
      message: `${total.toLocaleString("fa-IR")} تومان پس از پایان دوره‌ی تسویه به موجودی قابل برداشت شما اضافه شد.`,
    }).catch(() => {});
    notifyWithSms("payoutReleasedProvider", user, { amount: smsAmount(total) });
  }
  return due.length;
};

export const startPayoutReleaseJob = (intervalMs = 60 * 60 * 1000): void => {
  const run = () =>
    runPayoutReleaseSweep().catch((err) =>
      console.log("[payouts] release sweep failed:", err),
    );
  setTimeout(run, 30 * 1000).unref?.();
  setInterval(run, intervalMs).unref?.();
};

// What a finance page shows next to the withdrawable balance: the amount
// still in its hold, when the next part of it is released, and the rule.
export const pendingSummary = async (userId: unknown) => {
  if (!userId)
    return { pending: 0, nextReleaseAt: null as Date | null, holdDays: await getPayoutHoldDays() };
  const [wallet, next, holdDays] = await Promise.all([
    Wallet.findOne({ user: userId }).select("pending").lean(),
    Transaction.findOne({ user: userId, held: true })
      .sort({ availableAt: 1 })
      .select("availableAt")
      .lean(),
    getPayoutHoldDays(),
  ]);
  return {
    pending: Math.max(0, wallet?.pending || 0),
    nextReleaseAt: next?.availableAt ?? null,
    holdDays,
  };
};

// the withdrawal minimum (tomans): finance settings, else the value an
// older install kept on AppConfig, else 10,000
export const getWithdrawalMinAmount = async (): Promise<number> => {
  const g = await GlobalFinanceSettings.findOne()
    .select("withdrawalMinAmount")
    .lean<{ withdrawalMinAmount?: number }>();
  if (g?.withdrawalMinAmount) return g.withdrawalMinAmount;
  const legacy = await getAppConfig();
  return legacy.withdrawalMinAmount || 10_000;
};
