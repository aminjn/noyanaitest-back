import mongoose from "mongoose";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import DoctorProfile from "../Models/DoctorProfile";
import Pharmacy from "../Models/Pharmacy";
import ParaClinic from "../Models/Paraclinic";
import Insurance from "../Models/Insurance";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import WithdrawalRequest from "../Models/WithdrawalRequest";
import CentreWallet, { CentreWalletKind } from "../Models/CentreWallet";
import { ensureCentreWallet } from "./walletScope";

// One wallet per clinic / hospital (2026-10, Models/CentreWallet.ts). Until
// now an owner's centres all used the owner's one wallet. On start, once per
// owner (a marker in `bootmigrations` keeps a restart from moving anything
// twice):
//
//  exactly one centre, and no doctor / pharmacy / lab / insurer profile on
//  the account: the whole wallet - balance, settlement hold and every row -
//  becomes that centre's; the personal wallet starts empty.
//
//  several centres, or a centre next to one of those single profiles (whose
//  money stays on the personal wallet, unchanged): each row goes where its
//  source names it - a row with `clinic` / `hospital` to that centre; a
//  withdrawal or admin adjustment that names nothing to the first centre
//  (where the books already posted it), unless the account has one of the
//  single profiles (the books posted it there: it stays personal); every
//  other row stays personal. Each centre then receives what its rows add
//  up to (never below 0, never more than the wallet holds once the
//  personal rows' own net is kept), from the personal wallet, in centre
//  order.
//
// Money only moves from the personal wallet to the centre wallets, so the
// sum of all wallets is the same before and after; no voucher is written.
// What was attributed is logged and kept on the marker.

type Id = mongoose.Types.ObjectId;
type Centre = { kind: CentreWalletKind; id: Id; name?: string };
type Row = {
  _id: Id;
  amount: number;
  held?: boolean;
  clinic?: Id;
  hospital?: Id;
  doctor?: Id;
  pharmacy?: Id;
  paraClinic?: Id;
  insurance?: Id;
  withdrawal?: Id;
  adminAction?: string;
};

const MARKER = (user: unknown) => `centre-wallets:${String(user)}`;
const DONE = "centre-wallets:v1";

const dropOldPendingIndex = async () => {
  try {
    const indexes = (await WithdrawalRequest.collection.indexes()) as { name?: string }[];
    if (indexes.some((i) => i.name === "onePendingPerUser")) {
      await WithdrawalRequest.collection.dropIndex("onePendingPerUser");
      console.log("[centreWallets] withdrawalrequests: one-pending-per-user index replaced by one per wallet");
    }
  } catch {
    // no collection yet
  }
  await WithdrawalRequest.createIndexes().catch(() => undefined);
};

const hasSingleProfile = async (user: Id) => {
  for (const model of [DoctorProfile, Pharmacy, ParaClinic, Insurance] as mongoose.Model<any>[])
    if (await model.exists({ user })) return true;
  return false;
};

const namesOtherOrg = (r: Row) => !!(r.doctor || r.pharmacy || r.paraClinic || r.insurance);
const namesNothing = (r: Row) => !namesOtherOrg(r) && !r.clinic && !r.hospital;

export const migrateCentreWallets = async () => {
  await dropOldPendingIndex();
  const db = mongoose.connection.db;
  if (!db) return;
  const marks = db.collection<{ _id: string; [k: string]: unknown }>("bootmigrations");
  if (await marks.findOne({ _id: DONE })) return;

  const [clinics, hospitals] = await Promise.all([
    Clinic.find({ user: { $exists: true, $ne: null } }).sort({ _id: 1 }).select("user name").lean<{ _id: Id; user: Id; name?: string }[]>(),
    Hospital.find({ user: { $exists: true, $ne: null } }).sort({ _id: 1 }).select("user name").lean<{ _id: Id; user: Id; name?: string }[]>(),
  ]);
  // each owner's centres, clinics first then hospitals, oldest first - the
  // order the books used to pick "the" org of an account in
  const owners = new Map<string, Centre[]>();
  for (const c of clinics) owners.set(String(c.user), [...(owners.get(String(c.user)) || []), { kind: "clinic", id: c._id, name: c.name }]);
  for (const h of hospitals) owners.set(String(h.user), [...(owners.get(String(h.user)) || []), { kind: "hospital", id: h._id, name: h.name }]);

  let failed = 0;
  for (const [userKey, centres] of owners) {
    const user = new mongoose.Types.ObjectId(userKey);
    if (await marks.findOne({ _id: MARKER(user) })) continue;
    try {
      await migrateOwner(user, centres, marks);
    } catch (err) {
      failed++;
      console.log(`[centreWallets] owner ${userKey} failed:`, err);
    }
  }
  if (!failed) await marks.insertOne({ _id: DONE, at: new Date() });
};

const migrateOwner = async (
  user: Id,
  centres: Centre[],
  marks: mongoose.mongo.Collection<{ _id: string; [k: string]: unknown }>,
) => {
  const wallet = await Wallet.findOne({ user }).select("balance pending").lean();
  const single = await hasSingleProfile(user);
  const whole = centres.length === 1 && !single;
  const rows = await Transaction.find({ user, centreWallet: { $exists: false } })
    .select("amount held clinic hospital doctor pharmacy paraClinic insurance withdrawal adminAction")
    .lean<Row[]>();
  const key = (c: Centre) => `${c.kind}:${c.id}`;
  const byKey = new Map(centres.map((c) => [key(c), c]));
  const first = centres[0];

  // which centre each row belongs to (undefined: stays personal)
  const targetOf = (r: Row): Centre | undefined => {
    if (r.clinic && byKey.has(`clinic:${r.clinic}`)) return byKey.get(`clinic:${r.clinic}`);
    if (r.hospital && byKey.has(`hospital:${r.hospital}`)) return byKey.get(`hospital:${r.hospital}`);
    if (whole) return namesOtherOrg(r) || r.clinic || r.hospital ? undefined : first;
    if ((r.withdrawal || r.adminAction === "adjustment") && namesNothing(r) && !single) return first;
    return undefined;
  };
  const groups = new Map<string, { centre: Centre; rows: Row[]; balance: number; pending: number }>();
  for (const r of rows) {
    const c = targetOf(r);
    if (!c) continue;
    const g = groups.get(key(c)) || { centre: c, rows: [], balance: 0, pending: 0 };
    g.rows.push(r);
    if (r.held) g.pending += Number(r.amount) || 0;
    else g.balance += Number(r.amount) || 0;
    groups.set(key(c), g);
  }
  // nothing of a centre's on this account: nothing to do
  if (!groups.size && !(whole && ((wallet?.balance || 0) > 0 || (wallet?.pending || 0) > 0))) {
    await marks.insertOne({ _id: MARKER(user), at: new Date(), moved: [], note: "nothing attributed" });
    return;
  }

  // what moves: the whole wallet to the one centre, else each centre's own
  // rows, within what the wallet holds
  // (the personal rows' own net - the owner's top-ups and refunds - stays
  // on the personal wallet first; the centres share the rest)
  let personalBalance = 0;
  let personalPending = 0;
  for (const r of rows)
    if (!targetOf(r)) {
      if (r.held) personalPending += Number(r.amount) || 0;
      else personalBalance += Number(r.amount) || 0;
    }
  let leftBalance = Math.max(0, wallet?.balance || 0);
  let leftPending = Math.max(0, wallet?.pending || 0);
  if (!whole) {
    leftBalance = Math.max(0, leftBalance - Math.max(0, Math.round(personalBalance)));
    leftPending = Math.max(0, leftPending - Math.max(0, Math.round(personalPending)));
  }
  const plan: { kind: string; centre: string; name?: string; balance: number; pending: number; rows: number; rowsSum: number }[] = [];
  const order = whole ? [first] : centres;
  for (const c of order) {
    const g = groups.get(key(c));
    let b: number;
    let p: number;
    if (whole) {
      b = leftBalance;
      p = leftPending;
    } else {
      b = Math.min(Math.max(0, Math.round(g?.balance || 0)), leftBalance);
      p = Math.min(Math.max(0, Math.round(g?.pending || 0)), leftPending);
    }
    leftBalance -= b;
    leftPending -= p;
    plan.push({
      kind: c.kind,
      centre: String(c.id),
      name: c.name,
      balance: b,
      pending: p,
      rows: g?.rows.length || 0,
      rowsSum: Math.round((g?.balance || 0) + (g?.pending || 0)),
    });
  }
  // the claim: written before any money moves, so a restart never moves it
  // a second time (a crash right after it leaves the move undone and logged)
  await marks.insertOne({
    _id: MARKER(user),
    at: new Date(),
    before: { balance: wallet?.balance || 0, pending: wallet?.pending || 0 },
    whole,
    plan,
    done: false,
  });

  const toMove = plan.reduce((s, p) => ({ balance: s.balance + p.balance, pending: s.pending + p.pending }), { balance: 0, pending: 0 });
  if (toMove.balance > 0 || toMove.pending > 0) {
    const taken = await Wallet.findOneAndUpdate(
      { user, balance: { $gte: toMove.balance }, pending: { $gte: toMove.pending } },
      { $inc: { balance: -toMove.balance, pending: -toMove.pending } },
    );
    if (!taken) {
      // the wallet changed meanwhile: try again on the next start
      await marks.deleteOne({ _id: MARKER(user) });
      throw new Error("personal wallet changed during the move");
    }
    for (const p of plan) {
      if (!p.balance && !p.pending) continue;
      const w = await ensureCentreWallet({ kind: p.kind as CentreWalletKind, id: p.centre });
      await CentreWallet.updateOne({ _id: w._id }, { $inc: { balance: p.balance, pending: p.pending } });
    }
  }

  // the rows and the withdrawal requests follow their wallet
  for (const g of groups.values()) {
    const w = await ensureCentreWallet({ kind: g.centre.kind, id: g.centre.id });
    const ids = g.rows.map((r) => r._id);
    await Transaction.updateMany({ _id: { $in: ids }, centreWallet: { $exists: false } }, { $set: { centreWallet: w._id } });
    // a withdrawal / adjustment row that named no centre now names it (the
    // books post it to the centre, Lib/business/ledgerPoster.ts)
    const unnamed = g.rows.filter((r) => (r.withdrawal || r.adminAction === "adjustment") && namesNothing(r)).map((r) => r._id);
    if (unnamed.length) await Transaction.updateMany({ _id: { $in: unnamed } }, { $set: { [g.centre.kind]: g.centre.id } });
    const holds = g.rows.filter((r) => r.withdrawal).map((r) => r.withdrawal);
    if (holds.length)
      await WithdrawalRequest.updateMany(
        { _id: { $in: holds }, user, centreWallet: { $exists: false } },
        { $set: { centreWallet: w._id, centreKind: g.centre.kind, centre: g.centre.id } },
      );
  }
  await marks.updateOne({ _id: MARKER(user) }, { $set: { done: true, doneAt: new Date() } });
  console.log(
    `[centreWallets] owner ${user}: ${whole ? "one centre - whole wallet" : "attributed by source"}; ` +
      plan.map((p) => `${p.kind} ${p.centre} «${p.name || ""}» +${p.balance} balance +${p.pending} hold (${p.rows} rows, sum ${p.rowsSum})`).join("; "),
  );
};
