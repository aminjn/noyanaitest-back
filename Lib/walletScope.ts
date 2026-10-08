import mongoose from "mongoose";
import Wallet from "../Models/Wallet";
import CentreWallet, { CentreWalletKind } from "../Models/CentreWallet";
import { isMultiCentreKind } from "./activeCentre";

// Which wallet a money movement uses (2026-10, one wallet per centre,
// Models/CentreWallet.ts). Every flow that moves a clinic's or a hospital's
// money - its plan, its SMS, its withdrawals, an admin correction, an
// earning credited to it - goes through a scope:
//
//   { user }                          the user's personal wallet (patients,
//                                     doctors, pharmacies, labs, insurers -
//                                     unchanged)
//   { user, centre: { kind, id } }    that clinic's / hospital's wallet;
//                                     `user` is the owner (who is notified)
//
// A Transaction row that moved a centre wallet carries `centreWallet` (and
// its `clinic` / `hospital`); every other row moved the personal wallet.

type Id = mongoose.Types.ObjectId | string;

export type CentreRef = { kind: CentreWalletKind; id: Id };
export type WalletScope = { user: Id; centre?: CentreRef | null };

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

export const personalScope = (user: unknown): WalletScope => ({ user: idOf(user) });

export const centreScope = (kind: CentreWalletKind, centre: { _id: unknown; user?: unknown }): WalletScope => ({
  user: idOf(centre.user),
  centre: { kind, id: idOf(centre._id) },
});

// a Noyan Business owner ({ kind, id }) -> its scope: a clinic or hospital
// has its own wallet, every other kind uses the owner's personal one
export const scopeOfOwner = (owner: { kind: string; id?: unknown }, user: unknown): WalletScope =>
  isMultiCentreKind(owner.kind) && owner.id
    ? { user: idOf(user), centre: { kind: owner.kind, id: idOf(owner.id) } }
    : personalScope(user);

// the centre wallet's document, created on first use
export const ensureCentreWallet = async (ref: CentreRef) =>
  CentreWallet.findOneAndUpdate(
    { kind: ref.kind, centre: ref.id },
    { $setOnInsert: { kind: ref.kind, centre: ref.id } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

// what a scope holds now (0 / 0 for a wallet never used)
export const scopeBalance = async (scope: WalletScope): Promise<{ balance: number; pending: number }> => {
  const w = scope.centre
    ? await CentreWallet.findOne({ kind: scope.centre.kind, centre: scope.centre.id }).select("balance pending").lean()
    : scope.user
      ? await Wallet.findOne({ user: scope.user }).select("balance pending").lean()
      : null;
  return { balance: Math.max(0, w?.balance || 0), pending: Math.max(0, w?.pending || 0) };
};

// The fields a Transaction row of this scope carries: the centre wallet and
// its centre; nothing for the personal wallet. Creates the centre wallet.
export const scopeTxFields = async (scope: WalletScope): Promise<Record<string, unknown>> => {
  if (!scope.centre) return {};
  const w = await ensureCentreWallet(scope.centre);
  return { centreWallet: w._id, [scope.centre.kind]: scope.centre.id };
};

// Takes `amount` out of the scope's balance in one atomic step, only if the
// balance covers it. False: not enough money, nothing moved.
export const debitScope = async (scope: WalletScope, amount: number): Promise<boolean> => {
  if (!(amount > 0)) return true;
  if (scope.centre) {
    await ensureCentreWallet(scope.centre);
    const done = await CentreWallet.findOneAndUpdate(
      { kind: scope.centre.kind, centre: scope.centre.id, balance: { $gte: amount } },
      { $inc: { balance: -amount } },
    );
    return !!done;
  }
  await Wallet.updateOne({ user: scope.user }, { $setOnInsert: { user: scope.user } }, { upsert: true });
  const done = await Wallet.findOneAndUpdate(
    { user: scope.user, balance: { $gte: amount } },
    { $inc: { balance: -amount } },
  );
  return !!done;
};

// Adds to the balance (or, with `pending`, to the settlement hold).
export const creditScope = async (scope: WalletScope, amount: number, { pending = false } = {}) => {
  if (!amount) return;
  const inc = pending ? { pending: amount } : { balance: amount };
  if (scope.centre) {
    await ensureCentreWallet(scope.centre);
    await CentreWallet.updateOne({ kind: scope.centre.kind, centre: scope.centre.id }, { $inc: inc });
    return;
  }
  await Wallet.updateOne({ user: scope.user }, { $inc: inc }, { upsert: true });
};

// Moves a held amount from pending into balance (pending never below 0).
export const releaseScope = async (scope: WalletScope, amount: number) => {
  if (!(amount > 0)) return;
  const { pending } = await scopeBalance(scope);
  const fromPending = Math.min(amount, pending);
  if (scope.centre) {
    await ensureCentreWallet(scope.centre);
    await CentreWallet.updateOne(
      { kind: scope.centre.kind, centre: scope.centre.id },
      { $inc: { balance: amount, pending: -fromPending } },
    );
    return;
  }
  await Wallet.updateOne({ user: scope.user }, { $inc: { balance: amount, pending: -fromPending } }, { upsert: true });
};

// The scope a stored row moved: its centre wallet, else the user's own.
export const scopeOfRow = async (row: {
  user?: unknown;
  centreWallet?: unknown;
}): Promise<WalletScope> => {
  if (!row.centreWallet) return personalScope(row.user);
  const w = await CentreWallet.findById(idOf(row.centreWallet)).select("kind centre").lean();
  if (!w) return personalScope(row.user);
  return { user: idOf(row.user), centre: { kind: w.kind, id: idOf(w.centre) } };
};

// A centre's spending (its plan, its SMS) comes from the centre's own
// wallet only (owner's decision, 2026-10): the owner funds it first with
// a transfer from the personal wallet (POST /<centre>/wallet/fund).
// Returns the scope that paid, or null when it does not cover the amount.
export const debitSpending = async (scope: WalletScope, amount: number): Promise<WalletScope | null> =>
  (await debitScope(scope, amount)) ? scope : null;

// what a scope can spend: its own balance
export const spendableBalance = async (scope: WalletScope) => (await scopeBalance(scope)).balance;

// The personal wallet's own rows: everything of the user that did not move
// a centre wallet.
export const personalRowsFilter = (user: unknown) => ({ user: idOf(user), centreWallet: { $exists: false } });
