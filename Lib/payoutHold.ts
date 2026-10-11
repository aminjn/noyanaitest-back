import { notifyWithSms, smsAmount } from "../Services/notificationSmsService";
import { getAppConfig } from "./appConfig";
import mongoose from "mongoose";
import GlobalFinanceSettings from "../Models/GlobalFinanceSettings";
import Transaction, { ITransaction } from "../Models/Transaction";
import {
  creditScope,
  ensureCentreWallet,
  personalRowsFilter,
  personalScope,
  releaseScope,
  scopeBalance,
  scopeOfRow,
  scopeTxFields,
  WalletScope,
} from "./walletScope";
import Notification from "../Models/Notification";
import OrderReturn, { openReturnStatuses } from "../Models/OrderReturn";
import { getReturnSettings, returnWindowEnd } from "./orderReturns";

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

// Writes one earning row and credits it: into pending while it's held, or
// straight into balance when the hold is 0 days or the amount is not
// positive. Returns the transaction. An earning of a clinic or a hospital
// (fields.clinic / fields.hospital, 2026-10) goes to that centre's own
// wallet (Lib/walletScope.ts), never to the owner's personal one or to the
// owner's other centres.
// opts.releaseWith: an adjustment of an earning still in its hold is
// released with it (its date), not on a fresh hold of its own.
// opts.returnGuard (2026-10 owner decision: a seller is never in debt): an
// earning a return can still reach - a pharmacy line, its discount
// adjustment, its parcel's delivery fee - is held until the later of the
// settlement days and the end of its return window (Lib/orderReturns.ts
// returnWindowEnd, counted from opts.returnFrom, the delivery), and the
// release sweep keeps it while a return of it is open. Digikala pays its
// sellers after the return window the same way.
export const creditEarning = async (
  userId: mongoose.Types.ObjectId | string,
  amount: number,
  fields: Partial<ITransaction> & Record<string, unknown>,
  opts: { releaseWith?: Date | null; returnGuard?: "line" | "parcel"; returnFrom?: Date | null } = {},
) => {
  const days = amount > 0 ? await getPayoutHoldDays() : 0;
  const releaseWith = amount > 0 && opts.releaseWith && new Date(opts.releaseWith).getTime() > Date.now() ? new Date(opts.releaseWith) : null;
  const centre = fields.clinic
    ? { kind: "clinic" as const, id: String((fields.clinic as { _id?: unknown })?._id ?? fields.clinic) }
    : fields.hospital
      ? { kind: "hospital" as const, id: String((fields.hospital as { _id?: unknown })?._id ?? fields.hospital) }
      : null;
  const scope: WalletScope = { user: userId, centre };
  let until: Date | null = releaseWith || (days > 0 ? new Date(Date.now() + days * DAY_MS) : null);
  let holdReason: "returnWindow" | undefined;
  const guard = amount > 0 && opts.returnGuard ? opts.returnGuard : undefined;
  const returnFrom = guard ? (opts.returnFrom ? new Date(opts.returnFrom) : new Date()) : undefined;
  if (guard && returnFrom) {
    const end = returnWindowEnd(returnFrom, await getReturnSettings());
    if (end && end.getTime() > Date.now() && (!until || end > until)) {
      until = end;
      holdReason = "returnWindow";
    }
  }
  const held = !!until;
  const tx = await Transaction.create({
    ...fields,
    ...(await scopeTxFields(scope)),
    user: userId,
    amount,
    ...(held ? { held: true, availableAt: until } : {}),
    ...(guard ? { returnGuard: guard, returnFrom } : {}),
    ...(holdReason ? { holdReason } : {}),
  });
  if (amount !== 0) await creditScope(scope, amount, { pending: held });
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
  // what a return's reversal took from it while it was held stays out
  // (Lib/payoutHold.ts takeFromHeld)
  const amount = Math.max(0, (tx.amount || 0) - Math.max(0, Number(tx.heldTaken) || 0));
  // the wallet that holds it: the centre's for a centre earning
  // (pending can't go below 0 even if older data is off)
  if (amount > 0) await releaseScope(await scopeOfRow(tx), amount);
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

// (2026-10, a seller is never in debt) Whether a held earning a return can
// still reach must wait longer: until its return window ends (the admin may
// have lengthened it since), or - past it - while a return of its line (a
// parcel's delivery fee: of any line of that pharmacy in the order) is
// still open; it is looked at again every hour until that return closes.
type GateRow = Pick<ITransaction, "_id" | "order" | "orderItem" | "promoAdjust" | "pharmacy" | "returnGuard" | "returnFrom" | "createdAt">;
const OPEN_RECHECK_MS = 60 * 60 * 1000;
export const returnGateOf = async (
  row: GateRow,
  now = new Date(),
  settings?: Awaited<ReturnType<typeof getReturnSettings>>,
): Promise<{ until: Date; reason: "returnWindow" | "returnOpen" } | null> => {
  if (!row.returnGuard || !row.order) return null;
  const s = settings || (await getReturnSettings());
  const end = returnWindowEnd(new Date(row.returnFrom || row.createdAt), s);
  if (end && end > now) return { until: end, reason: "returnWindow" };
  const line = row.promoAdjust?.orderItem || row.orderItem;
  const open = await OrderReturn.exists({
    order: row.order,
    status: { $in: openReturnStatuses },
    ...(row.returnGuard === "parcel" ? { sellerKind: "pharmacy", seller: row.pharmacy } : { line }),
  });
  return open ? { until: new Date(now.getTime() + OPEN_RECHECK_MS), reason: "returnOpen" } : null;
};

// The hourly sweep: every held earning whose date has passed becomes
// withdrawable, and each provider gets one notice for the batch - unless a
// return can still reach it (returnGateOf): then its date moves on.
export const runPayoutReleaseSweep = async (): Promise<number> => {
  const now = new Date();
  const due = await Transaction.find({ held: true, availableAt: { $lte: now } })
    .select("_id order orderItem promoAdjust pharmacy returnGuard returnFrom createdAt")
    .sort({ availableAt: 1 })
    .limit(2000)
    .lean<GateRow[]>();
  const settings = due.some((r) => r.returnGuard) ? await getReturnSettings() : undefined;
  const perUser = new Map<string, number>();
  for (const row of due) {
    const gate = await returnGateOf(row, now, settings);
    if (gate) {
      await Transaction.updateOne({ _id: row._id, held: true }, { $set: { availableAt: gate.until, holdReason: gate.reason } });
      continue;
    }
    const tx = await releaseOne(row._id);
    const released = tx ? Math.max(0, tx.amount - Math.max(0, Number(tx.heldTaken) || 0)) : 0;
    if (tx && released > 0) {
      const key = String(tx.user);
      perUser.set(key, (perUser.get(key) || 0) + released);
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

// (2026-10 owner decision: a seller is never in debt) Takes `amount` out of
// a seller's earnings still in their hold - the money the platform still
// holds for it - for a return's reversal or a delivery-fee refund: first
// the rows matching `prefer` (the returned line's own earning and its
// adjustments, the parcel's fee), then the seller's other held earnings of
// the same org (latest release first). Never the withdrawable balance,
// never below zero: what the held earnings can not cover is returned as
// `short`, for the platform to absorb. Each row is taken from once per key
// (heldTakes.key), so a retry continues where it stopped and never takes
// twice. The wallet's pending follows each take.
export const takeFromHeld = async (opts: {
  user: unknown;
  org: { field: "pharmacy" | "paraClinic"; id: unknown };
  amount: number;
  key: string;
  prefer?: Record<string, unknown>[];
}): Promise<{ taken: number; short: number }> => {
  const want = Math.max(0, Math.round(Number(opts.amount) || 0));
  const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");
  const base = {
    user: new mongoose.Types.ObjectId(idOf(opts.user)),
    [opts.org.field]: new mongoose.Types.ObjectId(idOf(opts.org.id)),
    centreWallet: { $exists: false },
    amount: { $gt: 0 },
  };
  // what this key took already (a retry)
  const before = await Transaction.find({ ...base, "heldTakes.key": opts.key }).select("heldTakes").lean<ITransaction[]>();
  let taken = before.reduce((s, r) => s + (r.heldTakes || []).filter((h) => h.key === opts.key).reduce((a, h) => a + (Number(h.amount) || 0), 0), 0);
  const filters = [...(opts.prefer || []), {}];
  for (const f of filters) {
    if (taken >= want) break;
    const rows = await Transaction.find({ ...base, ...f, held: true, "heldTakes.key": { $ne: opts.key } })
      .sort({ availableAt: -1 })
      .select("_id amount heldTaken user centreWallet")
      .limit(500)
      .lean<ITransaction[]>();
    for (const row of rows) {
      if (taken >= want) break;
      const free = (Number(row.amount) || 0) - Math.max(0, Number(row.heldTaken) || 0);
      const take = Math.min(free, want - taken);
      if (!(take > 0)) continue;
      // the row is still held and still has it: one atomic step
      const done = await Transaction.updateOne(
        {
          _id: row._id,
          held: true,
          "heldTakes.key": { $ne: opts.key },
          $expr: { $gte: [{ $subtract: ["$amount", { $ifNull: ["$heldTaken", 0] }] }, take] },
        },
        { $inc: { heldTaken: take }, $push: { heldTakes: { key: opts.key, amount: take, at: new Date() } } },
      );
      if (!done.modifiedCount) continue;
      await creditScope(await scopeOfRow(row), -take, { pending: true });
      taken += take;
    }
  }
  return { taken: Math.min(taken, want), short: Math.max(0, want - taken) };
};

// (2026-10) The seller panel's line per held earning: "held until <date>
// (return window)" / "held while a return is open" next to the plain
// settlement hold - so a seller sees when it gets paid and why.
export const withHoldNotes = async <T extends Record<string, unknown>>(rows: T[]): Promise<(T & { holdReason?: string })[]> => {
  const out: (T & { holdReason?: string })[] = [];
  for (const r of rows) {
    const row = r as unknown as ITransaction;
    if (!row.held || !row.returnGuard) {
      out.push(r);
      continue;
    }
    const id = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");
    const line = id(row.promoAdjust?.orderItem || row.orderItem);
    const open = await OrderReturn.exists({
      order: id(row.order),
      status: { $in: openReturnStatuses },
      ...(row.returnGuard === "parcel" ? { sellerKind: "pharmacy", seller: id(row.pharmacy) } : { line }),
    });
    out.push({ ...r, holdReason: open ? "returnOpen" : row.holdReason || undefined });
  }
  return out;
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
// pendingSummary: the user's personal wallet; pendingSummaryOf: any scope
// (a clinic's / hospital's own wallet, Lib/walletScope.ts).
export const pendingSummary = async (userId: unknown) =>
  pendingSummaryOf(userId ? personalScope(userId) : null);

export const pendingSummaryOf = async (scope: WalletScope | null) => {
  if (!scope || (!scope.user && !scope.centre))
    return { pending: 0, nextReleaseAt: null as Date | null, holdDays: await getPayoutHoldDays() };
  const centreWallet = scope.centre ? (await ensureCentreWallet(scope.centre))._id : null;
  const [wallet, next, holdDays] = await Promise.all([
    scopeBalance(scope),
    Transaction.findOne(centreWallet ? { centreWallet, held: true } : { ...personalRowsFilter(scope.user), held: true })
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
