import { pendingSummary } from "./payoutHold";
import moment from "moment-jalaali";
import { startOfTehranJalaliMonth } from "./tehranTime";
import { Request } from "express";
import Transaction from "../Models/Transaction";
import Wallet from "../Models/Wallet";
import Order from "../Models/Order";
import ParaClinicTest from "../Models/ParaClinicTest";

// The finance page of an organisation panel (2026-10): lab, clinic,
// hospital and insurer, in the shape the shared panel finance page reads
// (same as the doctor's and the pharmacy's). The wallet is the owner's;
// income is what the platform paid the organisation for its order lines,
// net of commission; license purchases are listed and summed.

export type OrgFinanceKind = "paraClinic" | "clinic" | "hospital" | "insurance";

const MONTHS = 6;
export const ORG_FINANCE_PAGE_SIZE = 20;

const licenseField: Record<OrgFinanceKind, string> = {
  paraClinic: "paraClinicLicense",
  clinic: "clinicLicense",
  hospital: "hospitalLicense",
  insurance: "insuranceLicense",
};

// a lab's tests in paid orders that nobody acted on yet
const labUpcoming = async (orgId: unknown) => {
  const ids = await ParaClinicTest.find({ paraClinic: orgId }).distinct("_id");
  if (!ids.length) return { total: 0, count: 0 };
  const rows = await Order.aggregate([
    { $match: { status: "paid", "tests.item": { $in: ids } } },
    { $unwind: "$tests" },
    { $match: { "tests.item": { $in: ids }, "tests.status": "pending" } },
    {
      $group: {
        _id: null,
        total: { $sum: { $multiply: ["$tests.price", "$tests.qty"] } },
        orders: { $addToSet: "$_id" },
      },
    },
  ]);
  return { total: rows[0]?.total || 0, count: rows[0]?.orders?.length || 0 };
};

export const buildOrgFinance = async (
  req: Request,
  kind: OrgFinanceKind,
  org: { _id: unknown; user?: unknown },
  page: number,
) => {
  const monthStart = startOfTehranJalaliMonth();
  const lastMonthStart = startOfTehranJalaliMonth(new Date(), -1);
  const monthStarts = Array.from({ length: MONTHS + 1 }, (_, i) =>
    startOfTehranJalaliMonth(new Date(), i - (MONTHS - 1)),
  );
  const ownerId = (org.user as { _id?: unknown } | undefined)?._id ?? org.user;
  const license = licenseField[kind];
  const payoutMatch = { [kind]: org._id, order: { $exists: true }, amount: { $gt: 0 } };
  const sumOf = async (match: Record<string, unknown>) =>
    (
      await Transaction.aggregate([
        { $match: match },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ])
    )[0]?.total || 0;

  const [wallet, thisMonth, lastMonth, allTime, licenseSpend, upcoming, monthly, items, total] =
    await Promise.all([
      ownerId ? Wallet.findOne({ user: ownerId }).select("balance").lean() : null,
      sumOf({ ...payoutMatch, createdAt: { $gte: monthStart } }),
      sumOf({ ...payoutMatch, createdAt: { $gte: lastMonthStart, $lt: monthStart } }),
      sumOf(payoutMatch),
      sumOf({ [kind]: org._id, [license]: { $exists: true } }),
      kind === "paraClinic" ? labUpcoming(org._id) : Promise.resolve({ total: 0, count: 0 }),
      Promise.all(
        monthStarts
          .slice(0, MONTHS)
          .map((start, i) => sumOf({ ...payoutMatch, createdAt: { $gte: start, $lt: monthStarts[i + 1] } })),
      ),
      Transaction.find({ [kind]: org._id })
        .sort({ createdAt: -1 })
        .skip((page - 1) * ORG_FINANCE_PAGE_SIZE)
        .limit(ORG_FINANCE_PAGE_SIZE)
        .populate([
          { path: "order", select: "submittedAt" },
          { path: license, select: "displayName" },
        ])
        .select(`amount grossAmount commission commissionPercent held availableAt createdAt order ${license}`)
        .lean(),
      Transaction.countDocuments({ [kind]: org._id }),
    ]);

  return {
    balance: (wallet as { balance?: number } | null)?.balance ?? 0,
    // settlement hold (Lib/payoutHold.ts)
    ...(await pendingSummary(ownerId)),
    // the owner moves the money to the bank; a team member only sees it
    canWithdraw: req.aclGrant === "FULL",
    income: { thisMonth, lastMonth, allTime },
    upcoming,
    licenseSpend: Math.abs(licenseSpend),
    months: monthly.map((sum: number, i: number) => ({ month: monthStarts[i], total: sum })),
    transactions: {
      // same field name the page reads for a license purchase
      items: (items as Record<string, unknown>[]).map((t) => {
        const { [license]: bought, ...rest } = t;
        return { ...rest, license: bought };
      }),
      total,
      page,
      limit: ORG_FINANCE_PAGE_SIZE,
    },
  };
};

export const financePage = (req: Request) => {
  const n = Number(req.query.page);
  return Number.isInteger(n) && n > 0 ? n : 1;
};
