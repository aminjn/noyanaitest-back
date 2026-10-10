import mongoose, { isValidObjectId } from "mongoose";
import Insurance from "../Models/Insurance";
import InsuranceTariff, { IInsuranceTariff } from "../Models/InsuranceTariff";
import UserIdentity from "../Models/UserIdentity";
import Order from "../Models/Order";
import { effectiveContracts } from "./insuranceContracts";
import { insuranceValid } from "./patientInsurances";
import { shareOf } from "./insuranceTariffs";
import { jalaliMonthRange, jalaliYearRange, tehranJalali } from "./tehranTime";

// Supplementary insurance in the cart checkout (2026-10). Like Halodoc's
// and Vezeeta's "pay with insurance" at the pharmacy and lab: the buyer
// picks their supplementary insurer (the one on «بیمه‌های من» first), and
// for each line the seller decides:
//
//   direct     the pharmacy / lab holds an active contract with the insurer
//              (Models/InsuranceContract.ts) and the insurer has a drug /
//              lab rule for the item (Models/InsuranceTariff.ts target): the
//              insurer's share is taken off what the buyer pays and becomes
//              the seller's claim on its insurer list (Lib/business/claims.ts)
//   reimburse  anything else (no contract, no rule): the buyer pays in full
//              and claims the invoice from the insurer later - never a
//              guessed share
//
// Basic insurance (Tamin / Salamat) is not here: it goes through the
// e-prescription (Lib/rxPrescription.ts), which this never touches. The
// shares are estimates; the insurer's review of the list is final.

type Id = mongoose.Types.ObjectId | string;
const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");
const toman = (n: unknown) => Math.max(0, Math.round(Number(n) || 0));

export type CartInsuranceLine = {
  // "drug" for a pharmacy's products / packages, "lab" for a lab's tests;
  // a doctor's service line is never covered here
  target: "drug" | "lab" | null;
  ownerKind: string;
  ownerId: string;
  category?: string | null;
  rx: boolean;
  // what the insurer's rule applies to: the line's sale (after the
  // seller's own discounts)
  base: number;
};

export type CartInsurerOption = {
  _id: string;
  name: string;
  image?: string;
  // on the buyer's «بیمه‌های من» (unexpired)
  saved: boolean;
  plan?: string | null;
};

export type CartInsuranceQuote = {
  options: CartInsurerOption[];
  picked: { insurance: string; name: string; plan: string | null } | null;
  // per line: the insurer's share and its status, null = not covered at all
  shares: number[];
  statuses: ("pending" | "reimburse" | null)[];
  insurerShare: number;
  // some covered line is left for the buyer to claim
  reimburse: boolean;
  error?: string;
};

// the buyer's own saved supplementary card, if any
const savedSupplementary = async (userId: Id, at: Date) => {
  const idn = await UserIdentity.findOne({ user: userId })
    .select("insurances")
    .lean<{ insurances?: { insurance?: unknown; plan?: unknown; expiresAt?: Date | null }[] }>();
  return (Array.isArray(idn?.insurances) ? idn!.insurances! : [])
    .filter((i) => !!i?.insurance && insuranceValid(i as never, at))
    .map((i) => ({ insurance: idOf(i.insurance), plan: i.plan ? idOf(i.plan) : null }));
};

// the active supplementary insurers, the buyer's saved one first
export const cartInsurerOptions = async (userId: Id, at = new Date()): Promise<CartInsurerOption[]> => {
  const [insurers, saved] = await Promise.all([
    Insurance.find({ active: true, isBasic: { $ne: true } })
      .select("name image order")
      .sort({ order: 1, _id: 1 })
      .limit(100)
      .lean<{ _id: unknown; name?: string; image?: string }[]>(),
    savedSupplementary(userId, at),
  ]);
  const savedOf = new Map(saved.map((s) => [s.insurance, s.plan]));
  return insurers
    .map((i) => ({
      _id: idOf(i._id),
      name: i.name || "",
      image: i.image,
      saved: savedOf.has(idOf(i._id)),
      plan: savedOf.get(idOf(i._id)) ?? null,
    }))
    .sort((a, b) => Number(b.saved) - Number(a.saved));
};

const validOn = (t: Pick<IInsuranceTariff, "validFrom" | "validTo" | "active">, at: Date) =>
  t.active !== false && (!t.validFrom || t.validFrom <= at) && (!t.validTo || t.validTo >= at);

// the most specific drug / lab rule of the insurer for one line, or null
export const findItemTariff = (
  tariffs: IInsuranceTariff[],
  q: { target: "drug" | "lab"; plan: string | null; category?: string | null; rx: boolean; at: Date },
) => {
  let best: { t: IInsuranceTariff; s: number } | null = null;
  for (const t of tariffs) {
    if ((t.target || "visit") !== q.target || !validOn(t, q.at)) continue;
    let s = 0;
    if (t.plan) {
      if (!q.plan || idOf(t.plan) !== q.plan) continue;
      s += 4;
    }
    const cat = q.target === "drug" ? t.productCategory : t.testCategory;
    if (cat) {
      if (!q.category || idOf(cat) !== q.category) continue;
      s += 2;
    }
    if (q.target === "drug" && t.rxOnly) {
      if (!q.rx) continue;
      s += 1;
    }
    if (!best || s > best.s || (s === best.s && new Date(t.updatedAt || 0) > new Date(best.t.updatedAt || 0))) best = { t, s };
  }
  return best?.t || null;
};

// what this buyer already used of a rule's month / year limit with this
// insurer on cart orders (lines not cancelled)
const orderUsageOf = async (userId: Id, insurance: string, period: "month" | "year", at: Date) => {
  const j = tehranJalali(at);
  const range = period === "month" ? jalaliMonthRange(j.jy, j.jm) : jalaliYearRange(j.jy);
  const rows = await Order.find({
    user: userId,
    status: "paid",
    "insurance.insurance": insurance,
    paidAt: { $gte: range.start, $lt: range.end },
  })
    .select("products productPackages tests")
    .lean<Record<string, { insurerShare?: number; status?: string }[]>[]>();
  let count = 0;
  let amount = 0;
  for (const o of rows)
    for (const model of ["products", "productPackages", "tests"])
      for (const l of Array.isArray(o[model]) ? o[model] : [])
        if ((l.insurerShare || 0) > 0 && l.status !== "cancelled") {
          count += 1;
          amount += l.insurerShare || 0;
        }
  return { count, amount };
};

// The insurer's share of each line for the insurer the buyer picked (or
// none: only the options).
export const quoteCartInsurance = async ({
  userId,
  lines,
  pick,
  at = new Date(),
}: {
  userId: Id;
  lines: CartInsuranceLine[];
  pick?: { insurance: string; plan?: string | null } | null;
  at?: Date;
}): Promise<CartInsuranceQuote> => {
  const options = await cartInsurerOptions(userId, at);
  const none: CartInsuranceQuote = {
    options,
    picked: null,
    shares: lines.map(() => 0),
    statuses: lines.map(() => null),
    insurerShare: 0,
    reimburse: false,
  };
  if (!pick?.insurance) return none;
  const opt = isValidObjectId(pick.insurance) ? options.find((o) => o._id === pick.insurance) : undefined;
  // a basic insurer, an inactive one or a made-up id: not here
  if (!opt) return { ...none, error: "این بیمه‌ی تکمیلی در دسترس نیست" };
  const plan = pick.plan && isValidObjectId(pick.plan) ? pick.plan : opt.plan || null;
  const covered = lines.filter((l) => l.target);
  // the contracts of the sellers in the cart with this insurer
  const sellers = [...new Set(covered.map((l) => `${l.ownerKind}:${l.ownerId}`))];
  const contracted = new Set<string>();
  for (const key of sellers) {
    const [kind, id] = key.split(":");
    if (kind !== "pharmacy" && kind !== "paraClinic") continue;
    if ((await effectiveContracts({ insurance: opt._id, providerKind: kind, provider: id })).length) contracted.add(key);
  }
  const tariffs = await InsuranceTariff.find({ insurance: opt._id, active: true, target: { $in: ["drug", "lab"] } }).lean<IInsuranceTariff[]>();
  const shares = lines.map(() => 0);
  const statuses: CartInsuranceQuote["statuses"] = lines.map(() => null);
  // the rule's month / year limits, read once per rule
  const used = new Map<string, { count: number; amount: number }>();
  const spent = new Map<string, { count: number; amount: number }>();
  for (const [i, l] of lines.entries()) {
    if (!l.target) continue;
    const rule = contracted.has(`${l.ownerKind}:${l.ownerId}`)
      ? findItemTariff(tariffs, { target: l.target, plan, category: l.category || null, rx: l.rx, at })
      : null;
    let share = rule ? shareOf(rule, l.base) : 0;
    if (rule && share > 0 && rule.limitPeriod !== "none" && (rule.limitCount > 0 || rule.limitAmount > 0)) {
      const key = String(rule._id);
      if (!used.has(key)) used.set(key, await orderUsageOf(userId, opt._id, rule.limitPeriod, at));
      const u = used.get(key)!;
      const s = spent.get(key) || { count: 0, amount: 0 };
      if (rule.limitCount > 0 && u.count + s.count >= rule.limitCount) share = 0;
      if (rule.limitAmount > 0) share = Math.min(share, Math.max(0, rule.limitAmount - u.amount - s.amount));
      if (share > 0) spent.set(key, { count: s.count + 1, amount: s.amount + share });
    }
    share = Math.min(toman(share), toman(l.base));
    shares[i] = share;
    statuses[i] = share > 0 ? "pending" : "reimburse";
  }
  return {
    options,
    picked: { insurance: opt._id, name: opt.name, plan },
    shares,
    statuses,
    insurerShare: shares.reduce((s, x) => s + x, 0),
    reimburse: statuses.some((s) => s === "reimburse"),
  };
};
