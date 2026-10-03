import mongoose from "mongoose";
import Transaction, { ITransaction } from "../../Models/Transaction";
import WithdrawalRequest from "../../Models/WithdrawalRequest";
import Wallet from "../../Models/Wallet";
import BizVoucher from "../../Models/BizVoucher";
import { accountFor, natural, ownerFilter } from "./coa";
import Reservation from "../../Models/Reservation";
import Order from "../../Models/Order";
import DoctorProfile from "../../Models/DoctorProfile";
import Clinic from "../../Models/Clinic";
import Hospital from "../../Models/Hospital";
import Pharmacy from "../../Models/Pharmacy";
import ParaClinic from "../../Models/Paraclinic";
import Insurance from "../../Models/Insurance";
import { BizOwnerKind } from "../../Models/BizAccount";
import { BizOwner } from "./coa";
import { postVoucher, PostLine } from "./voucher";
import { deductOrderLine } from "./inventory";

// Automatic vouchers (2026-10). Every money movement in Noyan already writes
// one Transaction row (wallet credit or debit), so the books are posted from
// that one ledger instead of from hooks scattered over the code: each row
// becomes a voucher in the provider's books (when a provider is involved)
// and one in the platform's books. A row is posted right after it is saved
// and again by the recovery sweep if that failed; the voucher ref
// ("tx:<id>") makes both safe. The sweep also writes up all history the
// first time it runs. See docs/business-suite.md section 4.

const PLATFORM: BizOwner = { kind: "platform" };
const ORG_FIELDS: [keyof ITransaction, BizOwnerKind][] = [
  ["doctor", "doctor"],
  ["pharmacy", "pharmacy"],
  ["clinic", "clinic"],
  ["paraClinic", "paraClinic"],
  ["hospital", "hospital"],
  ["insurance", "insurance"],
];
const LICENSE_FIELDS = [
  "license",
  "pharmacyLicense",
  "clinicLicense",
  "paraClinicLicense",
  "hospitalLicense",
  "insuranceLicense",
] as const;
const ORG_MODELS: [BizOwnerKind, mongoose.Model<any>][] = [
  ["doctor", DoctorProfile],
  ["pharmacy", Pharmacy],
  ["clinic", Clinic],
  ["paraClinic", ParaClinic],
  ["hospital", Hospital],
  ["insurance", Insurance],
];

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

const orgOfTx = (t: ITransaction): BizOwner | null => {
  for (const [field, kind] of ORG_FIELDS) if (t[field]) return { kind, id: idOf(t[field]) };
  return null;
};

// a user-level movement (withdrawal, admin adjustment) belongs to the org
// the user owns, if any
const ownerCache = new Map<string, BizOwner | null>();
const orgOfUser = async (userId: unknown): Promise<BizOwner | null> => {
  const key = idOf(userId);
  if (!key) return null;
  if (ownerCache.has(key)) return ownerCache.get(key)!;
  let found: BizOwner | null = null;
  for (const [kind, model] of ORG_MODELS) {
    const org = await model.findOne({ user: key }).select("_id").lean<{ _id: unknown }>();
    if (org) {
      found = { kind, id: idOf(org._id) };
      break;
    }
  }
  ownerCache.set(key, found);
  return found;
};

const line = (role: string, debit: number, credit: number, label?: string): PostLine => ({
  role,
  debit,
  credit,
  label,
});

// which income account an order line belongs to, and its own tax
const orderLineInfo = async (orderId: unknown, itemId: unknown) => {
  const order = await Order.findById(orderId).lean<Record<string, any>>();
  if (!order) return null;
  const id = idOf(itemId);
  for (const [model, role] of [
    ["products", "salesIncome"],
    ["productPackages", "salesIncome"],
    ["tests", "testIncome"],
    ["services", "serviceIncome"],
    ["servicePackages", "serviceIncome"],
  ] as const) {
    const l = (order[model] || []).find((x: any) => idOf(x._id) === id);
    if (l) return { role, tax: Math.max(0, Number(l.tax) || 0), shipment: false };
  }
  if ((order.shipments || []).some((s: any) => idOf(s._id) === id))
    return { role: "shippingIncome", tax: 0, shipment: true };
  return { role: "salesIncome", tax: 0, shipment: false };
};

type Plan = { owner: BizOwner; description: string; lines: PostLine[] }[];

// The vouchers one transaction row makes (an empty plan for a row that
// moves no money of anyone's books).
export const planTransaction = async (t: ITransaction): Promise<Plan> => {
  const amount = Number(t.amount) || 0;
  const abs = Math.abs(amount);
  if (!abs) return [];
  const org = orgOfTx(t);
  const plan: Plan = [];

  // money in through the gateway: the user's wallet grows
  if (t.gatewayPayment)
    return [{ owner: PLATFORM, description: "شارژ کیف پول از درگاه", lines: [line("bank", abs, 0), line("userWallets", 0, abs)] }];

  // withdrawals: the amount leaves the wallet now and the bank later
  if (t.withdrawal) {
    const provider = await orgOfUser(t.user);
    if (amount < 0) {
      plan.push({ owner: PLATFORM, description: "درخواست برداشت", lines: [line("userWallets", abs, 0), line("withdrawalsInTransit", 0, abs)] });
      if (provider) plan.push({ owner: provider, description: "درخواست برداشت از کیف پول نویان", lines: [line("withdrawalTransit", abs, 0), line("noyanWallet", 0, abs)] });
    } else {
      plan.push({ owner: PLATFORM, description: "برگشت درخواست برداشت", lines: [line("withdrawalsInTransit", abs, 0), line("userWallets", 0, abs)] });
      if (provider) plan.push({ owner: provider, description: "برگشت درخواست برداشت به کیف پول نویان", lines: [line("noyanWallet", abs, 0), line("withdrawalTransit", 0, abs)] });
    }
    return plan;
  }

  // a plan bought from the wallet
  if (LICENSE_FIELDS.some((f) => (t as any)[f]) && amount < 0) {
    plan.push({ owner: PLATFORM, description: "فروش اشتراک", lines: [line("userWallets", abs, 0), line("subscriptionIncome", 0, abs)] });
    if (org) plan.push({ owner: org, description: "خرید اشتراک نویان", lines: [line("subscriptionExpense", abs, 0), line("noyanWallet", 0, abs)] });
    return plan;
  }

  // campaign SMS paid from the wallet (negative) and the unsent part given
  // back (positive) - Lib/business/campaign.ts
  if ((t as any).smsCampaign) {
    if (amount < 0) {
      plan.push({ owner: PLATFORM, description: "فروش پیامک کمپین", lines: [line("userWallets", abs, 0), line("smsIncome", 0, abs)] });
      if (org) plan.push({ owner: org, description: "هزینه‌ی پیامک کمپین", lines: [line("smsExpense", abs, 0), line("noyanWallet", 0, abs)] });
    } else {
      plan.push({ owner: PLATFORM, description: "برگشت هزینه‌ی پیامک‌های ارسال‌نشده", lines: [line("smsIncome", abs, 0), line("userWallets", 0, abs)] });
      if (org) plan.push({ owner: org, description: "برگشت هزینه‌ی پیامک‌های ارسال‌نشده", lines: [line("noyanWallet", abs, 0), line("smsExpense", 0, abs)] });
    }
    return plan;
  }

  // the support team's own money moves
  if (t.adminAction === "adjustment") {
    const provider = await orgOfUser(t.user);
    if (amount > 0) {
      plan.push({ owner: PLATFORM, description: "اصلاح دستی کیف پول (افزایش)", lines: [line("otherExpense", abs, 0), line("userWallets", 0, abs)] });
      if (provider) plan.push({ owner: provider, description: "اصلاح کیف پول نویان (افزایش)", lines: [line("noyanWallet", abs, 0), line("otherIncome", 0, abs)] });
    } else {
      plan.push({ owner: PLATFORM, description: "اصلاح دستی کیف پول (کاهش)", lines: [line("userWallets", abs, 0), line("otherIncome", 0, abs)] });
      if (provider) plan.push({ owner: provider, description: "اصلاح کیف پول نویان (کاهش)", lines: [line("otherExpense", abs, 0), line("noyanWallet", 0, abs)] });
    }
    return plan;
  }
  if (t.adminAction === "payoutReversal") {
    plan.push({ owner: PLATFORM, description: "برگشت تسویه‌ی ارائه‌دهنده", lines: [line("userWallets", abs, 0), line("unearned", 0, abs)] });
    if (org) plan.push({ owner: org, description: "برگشت تسویه‌ی نوبت (اعتراض پذیرفته‌شده)", lines: [line("incomeReturns", abs, 0), line("noyanWallet", 0, abs)] });
    return plan;
  }

  // a provider's earning: a visit, or a fulfilled order line
  if (org && amount > 0 && (t.reservation || t.order)) {
    const commission = Math.max(0, Number(t.commission) || 0);
    const gross = Math.max(abs, Number(t.grossAmount) || abs + commission);
    let incomeRole = "visitIncome";
    let tax = 0;
    let description = "درآمد ویزیت";
    if (t.reservation) {
      const r = await Reservation.findById(t.reservation).select("tax").lean<{ tax?: number }>();
      tax = Math.max(0, Number(r?.tax) || 0);
    } else {
      const info = await orderLineInfo(t.order, t.orderItem);
      incomeRole = info?.role || "salesIncome";
      tax = info?.tax || 0;
      description = info?.shipment ? "درآمد ارسال سفارش" : "درآمد فروش";
    }
    // the shipping fee is paid straight to the pharmacy's wallet, with no
    // commission and no hold
    if (incomeRole === "shippingIncome") {
      plan.push({ owner: PLATFORM, description: "پرداخت هزینه‌ی ارسال به فروشنده", lines: [line("unearned", abs, 0), line("userWallets", 0, abs)] });
      plan.push({ owner: org, description, lines: [line("noyanWallet", abs, 0), line("shippingIncome", 0, abs)] });
      return plan;
    }
    const held = t.held === true || !!t.availableAt;
    plan.push({
      owner: PLATFORM,
      description: t.reservation ? "تسویه‌ی ویزیت با ارائه‌دهنده" : "تسویه‌ی فروش با فروشنده",
      lines: [
        line("unearned", gross + tax, 0),
        line(held ? "providerPending" : "userWallets", 0, abs),
        line("commissionIncome", 0, commission),
        line("vatPayable", 0, tax),
      ],
    });
    plan.push({
      owner: org,
      description,
      lines: [
        line(held ? "noyanPending" : "noyanWallet", abs, 0),
        line("platformFee", commission, 0),
        line(incomeRole, 0, gross),
      ],
    });
    return plan;
  }

  // the patient or buyer pays for a visit or an order from the wallet
  if ((t.reservation || t.order) && amount < 0)
    return [{ owner: PLATFORM, description: t.reservation ? "پرداخت نوبت از کیف پول" : "پرداخت سفارش از کیف پول", lines: [line("userWallets", abs, 0), line("unearned", 0, abs)] }];

  // and gets it back (cancellation, no-show of the doctor, support refund)
  if ((t.reservation || t.order) && amount > 0)
    return [{ owner: PLATFORM, description: t.reservation ? "بازپرداخت نوبت" : "بازپرداخت سفارش", lines: [line("unearned", abs, 0), line("userWallets", 0, abs)] }];

  return [];
};

const source = (t: ITransaction) =>
  t.reservation
    ? { type: "reservation", id: idOf(t.reservation) }
    : t.order
      ? { type: "order", id: idOf(t.order) }
      : t.withdrawal
        ? { type: "withdrawal", id: idOf(t.withdrawal) }
        : undefined;

export const postTransaction = async (txId: unknown) => {
  const t = await Transaction.findById(txId).lean<ITransaction>();
  if (!t) return;
  try {
    const plan = await planTransaction(t);
    for (const v of plan)
      await postVoucher(v.owner, {
        ref: `tx:${t._id}`,
        date: t.createdAt,
        description: v.description,
        source: source(t),
        lines: v.lines,
      });
    await Transaction.updateOne({ _id: t._id }, { $set: { bizPostedAt: new Date() }, $unset: { bizError: 1 } });
  } catch (err) {
    console.log(`[business] posting transaction ${t._id} failed:`, err);
    await Transaction.updateOne(
      { _id: t._id },
      { $set: { bizPostedAt: new Date(), bizError: String((err as Error)?.message || err).slice(0, 300) } },
    );
    return;
  }
  // a pharmacy's sold line leaves its stock (Lib/business/inventory.ts);
  // idempotent, so the sweep may run it again. A failure here never blocks
  // the money's books.
  const org = orgOfTx(t);
  if (org?.kind === "pharmacy" && t.order && t.orderItem && Number(t.amount) > 0)
    await deductOrderLine(org, t.order, t.orderItem).catch((err) =>
      console.log(`[business] stock for transaction ${t._id} failed:`, err),
    );
};

// a held earning that reached its date (Lib/payoutHold.ts)
export const postRelease = async (txId: unknown) => {
  const t = await Transaction.findById(txId).lean<ITransaction>();
  if (!t || t.held || !t.releasedAt) return;
  const org = orgOfTx(t);
  const abs = Math.abs(Number(t.amount) || 0);
  if (abs) {
    await postVoucher(PLATFORM, {
      ref: `tx:${t._id}:release`,
      date: t.releasedAt,
      description: "پایان دوره‌ی تسویه‌ی ارائه‌دهنده",
      source: source(t),
      lines: [line("providerPending", abs, 0), line("userWallets", 0, abs)],
    });
    if (org)
      await postVoucher(org, {
        ref: `tx:${t._id}:release`,
        date: t.releasedAt,
        description: "پایان دوره‌ی تسویه؛ قابل برداشت در کیف پول نویان",
        source: source(t),
        lines: [line("noyanWallet", abs, 0), line("noyanPending", 0, abs)],
      });
  }
  await Transaction.updateOne({ _id: t._id }, { $set: { bizReleasePostedAt: new Date() } });
};

// a withdrawal the support team paid to the bank
export const postWithdrawalPaid = async (requestId: unknown) => {
  const w = await WithdrawalRequest.findById(requestId).lean<Record<string, any>>();
  if (!w || w.status !== "paid") return;
  const abs = Math.abs(Number(w.amount) || 0);
  const date = w.decidedAt || new Date();
  if (abs) {
    await postVoucher(PLATFORM, {
      ref: `wd:${w._id}:paid`,
      date,
      description: "واریز برداشت به حساب بانکی کاربر",
      source: { type: "withdrawal", id: w._id },
      lines: [line("withdrawalsInTransit", abs, 0), line("bank", 0, abs)],
    });
    const provider = await orgOfUser(w.user);
    if (provider)
      await postVoucher(provider, {
        ref: `wd:${w._id}:paid`,
        date,
        description: "واریز برداشت از نویان به حساب بانکی",
        source: { type: "withdrawal", id: w._id },
        lines: [line("bank", abs, 0), line("withdrawalTransit", 0, abs)],
      });
  }
  await WithdrawalRequest.updateOne({ _id: w._id }, { $set: { bizPaidPostedAt: new Date() } });
};

// a role's balance in an owner's books
const roleBalance = async (owner: BizOwner, role: string) => {
  const acc = await accountFor(owner, role);
  const [row] = await BizVoucher.aggregate([
    { $match: ownerFilter(owner) },
    { $unwind: "$lines" },
    { $match: { "lines.code": acc.code } },
    { $group: { _id: null, d: { $sum: "$lines.debit" }, c: { $sum: "$lines.credit" } } },
  ]);
  return natural(acc.type, row?.d || 0, row?.c || 0);
};

// Once the history is posted: money that reached a wallet without a
// Transaction row (old data, a direct fix in the database) would leave the
// books short of the real balance. One opening voucher per book brings
// "balance with Noyan" / "in settlement" (providers) and "user wallets" /
// "providers in settlement" (platform) to what the wallets really hold.
const OPENING_MARKER = "business-opening-balances";
export const reconcileOpeningBalances = async () => {
  const db = mongoose.connection.db;
  if (!db) return;
  const marks = db.collection<{ _id: string; at: Date }>("bootmigrations");
  if (await marks.findOne({ _id: OPENING_MARKER })) return;
  const first = await BizVoucher.findOne({}).sort({ date: 1 }).select("date").lean();
  const date = new Date((first?.date || new Date()).getTime() - 1000);
  const wallets = await Wallet.find({ $or: [{ balance: { $ne: 0 } }, { pending: { $ne: 0 } }] }).lean();
  const plug = (lines: PostLine[], role: string, diff: number) => {
    // diff > 0: the asset (provider) is short in the books
    if (Math.abs(diff) < 0.5) return;
    lines.push(diff > 0 ? line(role, diff, 0) : line(role, 0, -diff));
  };
  let totalBalance = 0;
  let totalPending = 0;
  for (const w of wallets) {
    totalBalance += w.balance || 0;
    totalPending += w.pending || 0;
    const provider = await orgOfUser(w.user);
    if (!provider) continue;
    const lines: PostLine[] = [];
    plug(lines, "noyanWallet", (w.balance || 0) - (await roleBalance(provider, "noyanWallet")));
    plug(lines, "noyanPending", (w.pending || 0) - (await roleBalance(provider, "noyanPending")));
    const net = lines.reduce((s2, l) => s2 + (l.debit || 0) - (l.credit || 0), 0);
    if (!lines.length) continue;
    lines.push(net > 0 ? line("openingBalance", 0, net) : line("openingBalance", -net, 0));
    await postVoucher(provider, { ref: "opening:wallet", kind: "opening", date, description: "تراز افتتاحیه‌ی کیف پول نویان", lines });
  }
  // liabilities: a positive diff means the books owe less than the wallets hold
  const lines: PostLine[] = [];
  const dW = totalBalance - (await roleBalance(PLATFORM, "userWallets"));
  const dP = totalPending - (await roleBalance(PLATFORM, "providerPending"));
  if (Math.abs(dW) >= 0.5) lines.push(dW > 0 ? line("userWallets", 0, dW) : line("userWallets", -dW, 0));
  if (Math.abs(dP) >= 0.5) lines.push(dP > 0 ? line("providerPending", 0, dP) : line("providerPending", -dP, 0));
  const net = lines.reduce((s2, l) => s2 + (l.credit || 0) - (l.debit || 0), 0);
  if (lines.length) {
    lines.push(net > 0 ? line("openingBalance", net, 0) : line("openingBalance", 0, -net));
    await postVoucher(PLATFORM, { ref: "opening:wallets", kind: "opening", date, description: "تراز افتتاحیه‌ی کیف پول کاربران", lines });
  }
  await marks.insertOne({ _id: OPENING_MARKER, at: new Date() });
  console.log("[business] opening balances reconciled");
};

const BATCH = 500;

// Everything not yet in the books, oldest first: what a failed immediate
// post missed, and on the first run the whole history.
export const runLedgerSweep = async () => {
  const txs = await Transaction.find({ bizPostedAt: { $exists: false } })
    .sort({ createdAt: 1, _id: 1 })
    .limit(BATCH)
    .select("_id")
    .lean();
  for (const t of txs) await postTransaction(t._id);
  const releases = await Transaction.find({
    held: false,
    releasedAt: { $exists: true },
    bizPostedAt: { $exists: true },
    bizReleasePostedAt: { $exists: false },
  })
    .limit(BATCH)
    .select("_id")
    .lean();
  for (const t of releases) await postRelease(t._id);
  const paid = await WithdrawalRequest.find({ status: "paid", bizPaidPostedAt: { $exists: false } })
    .limit(BATCH)
    .select("_id")
    .lean();
  for (const w of paid) await postWithdrawalPaid(w._id);
  return txs.length + releases.length + paid.length;
};

export const startLedgerJob = (intervalMs = 10 * 60 * 1000) => {
  const run = async () => {
    try {
      // keep going while there is a backlog (first run on old data)
      let done = false;
      for (let i = 0; i < 20 && !done; i++) done = (await runLedgerSweep()) < BATCH;
      // the history is in: bring the books to the real wallet balances once
      if (done) await reconcileOpeningBalances();
    } catch (err) {
      console.log("[business] ledger sweep failed:", err);
    }
  };
  setTimeout(run, 20 * 1000).unref?.();
  setInterval(run, intervalMs).unref?.();
};
