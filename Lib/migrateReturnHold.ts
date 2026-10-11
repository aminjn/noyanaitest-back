import mongoose from "mongoose";
import Transaction, { ITransaction } from "../Models/Transaction";
import Wallet from "../Models/Wallet";
import CentreWallet from "../Models/CentreWallet";
import AppConfig from "../Models/AppConfig";
import { getReturnSettings, returnWindowEnd } from "./orderReturns";
import { releaseHeldEarly } from "./payoutHold";
import { creditScope, personalScope, scopeTxFields, WalletScope } from "./walletScope";
import { notifyUserAlertSubscribers } from "../Services/userAlertService";

// (2026-10 owner decision: a seller is never in debt) On start, idempotent:
//
// 1. Earnings a return can still reach and that are still held - a
//    pharmacy line's earning and its discount adjustments, written before
//    the return-window hold existed - get their guard (Transaction.
//    returnGuard) and wait for the end of their return window (delivery +
//    the AppConfig return settings) when that is later than their date.
//    One already released can not be held again; a refund on it later
//    comes out of the seller's other held earnings or is the platform's.
//
// 2. A wallet left below zero by the old reversal-into-debt path is settled
//    by the new rule: the owner's earnings still held are released early
//    into it until it is back at zero (they were the seller's money
//    anyway, Lib/payoutHold.ts releaseHeldEarly posts each release), and
//    whatever they can not cover the platform absorbs - one adjustment row
//    booked as the platform's expense (Lib/business/ledgerPoster.ts
//    "adjustment"), flagged to the super admin. Never left as a debt.
//
// 3. The retired setting (AppConfig.returnSellerDebtLimit) is removed.

const RETURNABLE = ["products", "productPackages"] as const;

const guardHeldEarnings = async () => {
  const rows = await Transaction.find({
    held: true,
    order: { $exists: true },
    returnGuard: { $exists: false },
    amount: { $gt: 0 },
    returnPart: { $exists: false },
  })
    .select("_id order orderItem promoAdjust availableAt createdAt")
    .limit(5000)
    .lean<ITransaction[]>();
  if (!rows.length) return 0;
  const settings = await getReturnSettings();
  const orders = new Map<string, Set<string>>();
  let n = 0;
  for (const r of rows) {
    const orderId = String(r.order);
    if (!orders.has(orderId)) {
      const o = await mongoose
        .model("Order")
        .findById(orderId)
        .select(RETURNABLE.map((m) => `${m}._id`).join(" "))
        .lean<Record<string, { _id: unknown }[]>>();
      orders.set(orderId, new Set(RETURNABLE.flatMap((m) => (o?.[m] || []).map((l) => String(l._id)))));
    }
    const line = String(r.promoAdjust?.orderItem || r.orderItem || "");
    if (!line || !orders.get(orderId)!.has(line)) continue;
    // the delivery: the line's own earning's date
    const earning = r.promoAdjust
      ? await Transaction.findOne({ order: r.order, orderItem: r.promoAdjust.orderItem, amount: { $gt: 0 }, grossAmount: { $exists: true } })
          .select("createdAt")
          .lean<ITransaction>()
      : r;
    const from = new Date(earning?.createdAt || r.createdAt);
    const end = returnWindowEnd(from, settings);
    const later = end && (!r.availableAt || end > new Date(r.availableAt));
    await Transaction.updateOne(
      { _id: r._id, held: true },
      { $set: { returnGuard: "line", returnFrom: from, ...(later ? { availableAt: end, holdReason: "returnWindow" } : {}) } },
    );
    n++;
  }
  return n;
};

const settleNegative = async (scope: WalletScope, balance: number, label: string) => {
  const rowsFilter = scope.centre
    ? { centreWallet: (await scopeTxFields(scope)).centreWallet }
    : { user: new mongoose.Types.ObjectId(String(scope.user)), centreWallet: { $exists: false } };
  // the owner's held earnings, the soonest first, until the debt is covered
  let debt = -balance;
  const held = await Transaction.find({ ...rowsFilter, held: true, amount: { $gt: 0 } })
    .sort({ availableAt: 1 })
    .select("_id amount heldTaken")
    .lean<ITransaction[]>();
  for (const r of held) {
    if (debt <= 0) break;
    const free = (Number(r.amount) || 0) - Math.max(0, Number(r.heldTaken) || 0);
    if (free <= 0) continue;
    await releaseHeldEarly({ _id: r._id });
    debt -= free;
  }
  if (debt <= 0) return;
  // what they could not cover: the platform's, once (adminRequestKey)
  const key = `debt-migration:${scope.centre ? `${scope.centre.kind}:${scope.centre.id}` : String(scope.user)}:${Math.round(debt)}`;
  try {
    await Transaction.create({
      user: scope.user,
      amount: Math.round(debt),
      adminAction: "adjustment",
      adminRequestKey: key,
      note: "جبران موجودی منفی پس از مرجوعی توسط نویان (فروشنده بدهکار نمی‌ماند)",
      ...(await scopeTxFields(scope)),
    });
  } catch (err) {
    if ((err as { code?: number })?.code === 11000) return;
    throw err;
  }
  await creditScope(scope, Math.round(debt));
  notifyUserAlertSubscribers(
    "refundPlatformCovered",
    {
      title: "بازپرداختی که نویان جبران کرد",
      message: `${Math.round(debt).toLocaleString("fa-IR")} تومان موجودی منفی «${label}» پس از مرجوعی را نویان جبران کرد.`,
      link: `/notadmin/finance/transactions?user=${String(scope.user)}`,
    },
    { orderId: "-", amount: String(Math.round(debt)) },
  ).catch(() => undefined);
};

export const migrateReturnHold = async () => {
  const guarded = await guardHeldEarnings();
  const negatives = await Wallet.find({ balance: { $lt: 0 } }).select("user balance").lean<{ user: unknown; balance: number }[]>();
  for (const w of negatives) await settleNegative(personalScope(w.user), w.balance, String(w.user));
  const centreNegatives = await CentreWallet.find({ balance: { $lt: 0 } }).select("kind centre balance").lean<{ kind: "clinic" | "hospital"; centre: unknown; balance: number }[]>();
  for (const w of centreNegatives) {
    const centre = await mongoose
      .model(w.kind === "clinic" ? "Clinic" : "Hospital")
      .findById(w.centre)
      .select("user")
      .lean<{ user?: unknown }>();
    if (centre?.user) await settleNegative({ user: String(centre.user), centre: { kind: w.kind, id: String(w.centre) } }, w.balance, String(w.centre));
  }
  await AppConfig.updateMany({ returnSellerDebtLimit: { $exists: true } }, { $unset: { returnSellerDebtLimit: 1 } }, { strict: false });
  if (guarded || negatives.length || centreNegatives.length)
    console.log(`[returns] hold migration: ${guarded} held earnings guarded, ${negatives.length + centreNegatives.length} negative wallets settled`);
};
