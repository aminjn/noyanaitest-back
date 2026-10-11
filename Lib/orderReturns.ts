import mongoose from "mongoose";
import Transaction, { ITransaction } from "../Models/Transaction";
import { IOrder } from "../Models/Order";
import {
  IOrderReturnShare,
  OrderReturnReason,
  orderReturnReasons,
  ReturnLineModel,
  sellerFaultReasons,
} from "../Models/OrderReturn";
import { getAppConfig } from "./appConfig";
import { keptLine, lineMoney, money, OrderMoneyLine } from "./orderLineMoney";

// The rules of a return (2026-10, Services/orderReturnService.ts), the pure
// part: which delivered lines a buyer may send back, for which reasons,
// and the returned units' share of a line's money. Benchmarked on
// Digikala's «مرجوعی» (a window after delivery, a reason and photos per
// item and quantity, "changed my mind" only for unopened goods), Snapp
// Pharmacy and Halodoc (medicines: prescription and cold-chain items come
// back only for the pharmacy's error - the Iranian pharmacy rule that a
// dispensed medicine is not taken back otherwise), Amazon (the seller pays
// the return shipping of its own error, the buyer otherwise).

export const RETURN_MODELS = ["products", "productPackages"] as const;
export const REFUND_MODELS = ["products", "productPackages", "tests"] as const;

export type ReturnLine = OrderMoneyLine & {
  _id: mongoose.Types.ObjectId;
  item: unknown;
  status: string;
  requiresPrescription?: boolean;
  returnHeldQty?: number;
  returned?: { qty: number; lineTotal: number; club: number; promo: number; insurer: number; tax: number; paid: number };
  returnsApplied?: unknown[];
  insuranceStatus?: string;
  insuranceClaim?: unknown;
  result?: { uploadedAt?: Date };
};

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

export const lineOf = (order: unknown, model: string, lineId: string): ReturnLine | null =>
  (((order as Record<string, ReturnLine[]> | null)?.[model] || []) as ReturnLine[]).find((l) => idOf(l?._id) === lineId) ||
  null;

// the catalog doc of a line and the field naming its seller org
export const LINE_SELLER: Record<ReturnLineModel, { model: string; field: string; org: "Pharmacy" | "ParaClinic"; kind: "pharmacy" | "paraClinic" }> = {
  products: { model: "ProductSeller", field: "seller", org: "Pharmacy", kind: "pharmacy" },
  productPackages: { model: "ProductPackage", field: "owner", org: "Pharmacy", kind: "pharmacy" },
  tests: { model: "ParaClinicTest", field: "paraClinic", org: "ParaClinic", kind: "paraClinic" },
};

export type LineSeller = { kind: "pharmacy" | "paraClinic"; id: string; user: string; name: string };

export const sellerOfLine = async (model: ReturnLineModel, itemId: unknown): Promise<LineSeller | null> => {
  const cfg = LINE_SELLER[model];
  if (!cfg || !mongoose.isValidObjectId(idOf(itemId))) return null;
  const doc = await mongoose.model(cfg.model).findById(idOf(itemId)).select(cfg.field).lean<Record<string, unknown>>();
  const orgId = idOf(doc?.[cfg.field]);
  if (!orgId) return null;
  const org = await mongoose.model(cfg.org).findById(orgId).select("name user").lean<{ _id: unknown; name?: string; user?: unknown }>();
  if (!org) return null;
  return { kind: cfg.kind, id: orgId, user: idOf(org.user), name: org.name || "" };
};

// the line's own earning row (the seller's, not the buyer's refund)
export const earningOfLine = (orderId: unknown, lineId: unknown, buyer: unknown) =>
  Transaction.findOne({
    order: orderId,
    orderItem: lineId,
    amount: { $gt: 0 },
    grossAmount: { $exists: true },
    user: { $ne: idOf(buyer) },
  }).lean<ITransaction>();

export type ReturnSettings = {
  windowDays: number;
  changedMindAllowed: boolean;
  nonReturnableCategories: Set<string>;
  debtLimit: number;
  responseHours: number;
  receiveDays: number;
};

export const getReturnSettings = async (): Promise<ReturnSettings> => {
  const c = await getAppConfig();
  const num = (v: unknown, d: number, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
  };
  return {
    windowDays: num(c.returnWindowDays, 7, 0, 60),
    changedMindAllowed: c.returnChangedMindAllowed !== false,
    nonReturnableCategories: new Set((c.returnNonReturnableCategories || []).map((x) => idOf(x)).filter(Boolean)),
    debtLimit: num(c.returnSellerDebtLimit, 5_000_000, 0, Number.MAX_SAFE_INTEGER),
    responseHours: num(c.returnSellerResponseHours, 48, 1, 720),
    receiveDays: num(c.returnReceiveDays, 10, 1, 60),
  };
};

// a product line's / package's catalog categories (a package: each product's)
const categoriesOf = async (model: string, itemId: unknown): Promise<string[]> => {
  if (model === "products") {
    const s = await mongoose
      .model("ProductSeller")
      .findById(idOf(itemId))
      .select("product")
      .populate({ path: "product", select: "category" })
      .lean<{ product?: { category?: unknown } }>();
    return s?.product?.category ? [idOf(s.product.category)] : [];
  }
  if (model === "productPackages") {
    const p = await mongoose.model("ProductPackage").findById(idOf(itemId)).select("products").lean<{ products?: unknown[] }>();
    const ids = (p?.products || []).map(idOf).filter((x) => mongoose.isValidObjectId(x));
    if (!ids.length) return [];
    const products = await mongoose.model("Product").find({ _id: { $in: ids } }).select("category").lean<{ category?: unknown }[]>();
    return products.map((x) => idOf(x.category)).filter(Boolean);
  }
  return [];
};

export type ReturnOption = {
  model: (typeof RETURN_MODELS)[number];
  line: string;
  item: string;
  qty: number;
  // units still free to return (not returned, not held by an open request)
  available: number;
  returnedQty: number;
  deliveredAt: Date | null;
  until: Date | null;
  // why the line can not be returned at all (none: it can)
  blocked: "notDelivered" | "windowClosed" | "allReturned" | "noWindow" | null;
  // prescription-only or a non-returnable category: only the seller's error
  restricted: "rx" | "category" | null;
  reasons: OrderReturnReason[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

// What the buyer may return from this order, line by line.
export const returnOptionsOf = async (order: IOrder, now = new Date()): Promise<ReturnOption[]> => {
  const settings = await getReturnSettings();
  const out: ReturnOption[] = [];
  if (order.status !== "paid") return out;
  for (const model of RETURN_MODELS)
    for (const line of ((order as unknown as Record<string, ReturnLine[]>)[model] || []) as ReturnLine[]) {
      if (!line?._id || line.status !== "fulfilled") continue;
      // delivered = settled: the earning row is written on delivery (Tapsi:
      // when prepared and handed to the courier; Tipax: when confirmed)
      const earning = await earningOfLine(order._id, line._id, order.user);
      const deliveredAt = earning?.createdAt ? new Date(earning.createdAt) : null;
      const until = deliveredAt && settings.windowDays > 0 ? new Date(deliveredAt.getTime() + settings.windowDays * DAY_MS) : null;
      const returnedQty = money(line.returned?.qty);
      // returnHeldQty counts the units of open requests and the units
      // already returned (Services/orderReturnService.ts claimUnits)
      const available = Math.max(0, (Number(line.qty) || 0) - money(line.returnHeldQty));
      const cats = await categoriesOf(model, line.item);
      const restricted = line.requiresPrescription
        ? "rx"
        : cats.some((c) => settings.nonReturnableCategories.has(c))
          ? "category"
          : null;
      const reasons = orderReturnReasons.filter(
        (r) => sellerFaultReasons.includes(r) || (r === "changedMind" && settings.changedMindAllowed && !restricted),
      );
      out.push({
        model,
        line: idOf(line._id),
        item: idOf(line.item),
        qty: Number(line.qty) || 0,
        available,
        returnedQty,
        deliveredAt,
        until,
        blocked: !deliveredAt
          ? "notDelivered"
          : settings.windowDays <= 0
            ? "noWindow"
            : until && until < now
              ? "windowClosed"
              : available <= 0
                ? "allReturned"
                : null,
        restricted,
        reasons,
      });
    }
  return out;
};

// ------------------------------------------------------------ the share

const part = (whole: number, q: number, of: number) => (of <= 0 ? 0 : q >= of ? whole : Math.round((whole * q) / of));

// The returned units' share of the line and of the seller's earning on it:
// what is left of each (the line less the units already returned; the
// earning, its discount adjustments, less the reversals already made),
// split over the units left - all of it for the last ones, so a line
// returned in parts adds up to the toman.
export const shareOfReturn = async (
  order: Pick<IOrder, "_id" | "promo" | "user">,
  line: ReturnLine,
  qty: number,
): Promise<IOrderReturnShare> => {
  const kept = keptLine(line);
  const left = Math.max(0, Number(kept.qty) || 0);
  const q = Math.min(qty, left);
  const club = part(money(kept.clubDiscount), q, left);
  const promo = part(money(kept.promoDiscount), q, left);
  const insurer = part(money(kept.insurerShare), q, left);
  const tax = part(money(kept.tax), q, left);
  const m = lineMoney(order, { qty: q, price: line.price, clubDiscount: club, promoDiscount: promo, insurerShare: insurer, tax });
  const share: IOrderReturnShare = {
    lineTotal: m.lineTotal,
    club,
    promo,
    insurer,
    tax,
    paid: m.paid + tax,
    sellerGross: 0,
    sellerCommission: 0,
    sellerTax: 0,
    sellerAmount: 0,
    subsidy: 0,
  };
  const earning = await earningOfLine(order._id, line._id, order.user);
  if (!earning) return share;
  const [adjs, reversals] = await Promise.all([
    Transaction.find({ "promoAdjust.orderItem": line._id }).select("user amount grossAmount commission tax subsidyBack").lean<ITransaction[]>(),
    Transaction.find({ returnLine: line._id, returnPart: "reversal" }).select("grossAmount commission tax subsidyBack").lean<ITransaction[]>(),
  ]);
  const sellerAdjs = adjs.filter((a) => idOf(a.user) !== idOf(order.user) && Number(a.amount) > 0);
  const sum = (rows: ITransaction[], k: "grossAmount" | "commission" | "tax" | "subsidyBack") =>
    rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const legacy = typeof earning.tax !== "number";
  const gross = money(earning.grossAmount) + sum(sellerAdjs, "grossAmount") - sum(reversals, "grossAmount");
  const commission = money(earning.commission) + sum(sellerAdjs, "commission") - sum(reversals, "commission");
  const sellerTax = legacy ? 0 : Math.max(0, Number(earning.tax) || 0) + sum(sellerAdjs, "tax") - sum(reversals, "tax");
  const subsidy = money(earning.platformSubsidy) - sum(adjs, "subsidyBack") - sum(reversals, "subsidyBack");
  share.sellerGross = part(Math.max(0, gross), q, left);
  share.sellerCommission = Math.min(share.sellerGross, part(Math.max(0, commission), q, left));
  share.sellerTax = part(Math.max(0, sellerTax), q, left);
  share.subsidy = Math.min(share.sellerGross + share.sellerTax, part(Math.max(0, subsidy), q, left));
  share.sellerAmount = share.sellerGross - share.sellerCommission + share.sellerTax;
  share.earning = earning._id as unknown as mongoose.Types.ObjectId;
  // what the buyer paid for these units is what the platform settled for
  // them (the seller's sale and VAT, less the platform's own discount), so
  // the refund and the reversal meet to the toman in the books. A legacy
  // earning (the platform held the VAT) adds the line's VAT.
  share.paid = share.sellerGross + share.sellerTax - share.subsidy + (legacy ? tax : 0);
  return share;
};

export const isSellerFault = (reason: string) => (sellerFaultReasons as readonly string[]).includes(reason);
