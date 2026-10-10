import mongoose from "mongoose";
import Order, { IOrder } from "../../Models/Order";
import { BizOwner } from "./coa";
import { defaultIncomeRole, postDoc, reverseRef } from "./finance";

// The supplementary insurer's share of a cart order line (2026-10,
// Lib/cartInsurance.ts) in the seller's own books - the same way a
// practice books the insurer's share of a visit
// (Lib/business/reservationInsurance.ts): the buyer never paid it, so once
// the line is fulfilled it is the pharmacy's / lab's receivable from the
// insurer, which the seller then puts on its insurer list
// (Lib/business/claims.ts «ord:<order>:<line>»), and the insurer reviews
// and pays in its panel (Lib/business/insurerClaims.ts):
//
//   fulfilled   seller   Dr 1412 insurers (the insurer's تفصیلی)   Cr sales / test income
//   reversed    the same voucher reversed (a line not on a list yet)
//
// Each line moves pending -> booked once (claimed atomically on its
// insuranceStatus); a line cancelled before is "cancelled", nothing booked.

export const ORDER_INSURANCE_MODELS = ["products", "productPackages", "tests"] as const;
export type OrderInsuranceModel = (typeof ORDER_INSURANCE_MODELS)[number];

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

export const orderInsurerRef = (orderId: unknown, lineId: unknown) => `ordins:${idOf(orderId)}:${idOf(lineId)}`;

type Line = { _id: unknown; insurerShare?: number; insuranceStatus?: string; insuranceClaim?: unknown; qty?: number };

const lineOf = (order: IOrder | null, model: string, lineId: string) =>
  ((order as unknown as Record<string, Line[]> | null)?.[model] || []).find((l) => idOf(l._id) === lineId) || null;

export const bookOrderInsurerLine = async (
  orderId: unknown,
  model: string,
  lineId: string,
  owner: BizOwner,
) => {
  if (!(ORDER_INSURANCE_MODELS as readonly string[]).includes(model)) return;
  const claimed = await Order.findOneAndUpdate(
    {
      _id: orderId,
      [model]: { $elemMatch: { _id: new mongoose.Types.ObjectId(lineId), insuranceStatus: "pending", insurerShare: { $gt: 0 } } },
    },
    { $set: { [`${model}.$.insuranceStatus`]: "booked" } },
    { new: true },
  )
    .populate({ path: "user", select: "identity", populate: { path: "identity", select: "givenName lastName" } })
    .lean<IOrder>();
  if (!claimed) return;
  const line = lineOf(claimed, model, lineId);
  const share = Math.max(0, Math.round(Number(line?.insurerShare) || 0));
  const insurer = claimed.insurance?.name || "—";
  const idn = (claimed.user as unknown as { identity?: { givenName?: string; lastName?: string } })?.identity;
  const patient = `${idn?.givenName || ""} ${idn?.lastName || ""}`.trim();
  const label = `${insurer} · ${patient || "—"}`.slice(0, 300);
  try {
    await postDoc(owner, {
      ref: orderInsurerRef(orderId, lineId),
      date: new Date(),
      description: "سهم بیمه‌ی تکمیلی سفارش",
      lines: [
        { role: "insuranceReceivable", debit: share, credit: 0, label, party: { kind: "insurer", name: insurer } },
        { role: defaultIncomeRole(owner.kind), debit: 0, credit: share, label },
      ],
      source: { type: "order", id: orderId },
      party: { kind: "insurer", name: insurer },
    });
  } catch (err) {
    // the books failed: the line waits to be booked again
    await Order.updateOne(
      { _id: orderId, [`${model}._id`]: new mongoose.Types.ObjectId(lineId) },
      { $set: { [`${model}.$.insuranceStatus`]: "pending" } },
    ).catch(() => undefined);
    throw err;
  }
};

// A cancelled line: an estimate never booked is dropped; one booked and not
// on a list yet is reversed.
export const dropOrderInsurerLine = async (orderId: unknown, model: string, lineId: string, owner: BizOwner | null) => {
  if (!(ORDER_INSURANCE_MODELS as readonly string[]).includes(model)) return;
  const id = new mongoose.Types.ObjectId(lineId);
  await Order.updateOne(
    { _id: orderId, [model]: { $elemMatch: { _id: id, insuranceStatus: "pending" } } },
    { $set: { [`${model}.$.insuranceStatus`]: "cancelled" } },
  );
  if (!owner) return;
  const reversed = await Order.updateOne(
    { _id: orderId, [model]: { $elemMatch: { _id: id, insuranceStatus: "booked", insuranceClaim: { $exists: false } } } },
    { $set: { [`${model}.$.insuranceStatus`]: "reversed" } },
  );
  if (reversed.modifiedCount) await reverseRef(owner, orderInsurerRef(orderId, lineId), "برگشت سهم بیمه‌ی تکمیلی سفارش");
};

// ------------------------------------------------------------ claim lists

export type OrderInsurerLine = {
  order: mongoose.Types.ObjectId;
  orderLine: mongoose.Types.ObjectId;
  model: OrderInsuranceModel;
  date: Date;
  patient: string;
  service: string;
  total: number;
  share: number;
  name: string;
};

// the catalog fields that name an order line's seller and item
const catalog: Record<OrderInsuranceModel, { model: string; owner: string; kind: string; title: (d: any) => string }> = {
  products: { model: "ProductSeller", owner: "seller", kind: "pharmacy", title: (d) => d?.product?.name || "کالا" },
  productPackages: { model: "ProductPackage", owner: "owner", kind: "pharmacy", title: (d) => d?.name || "بسته‌ی کالا" },
  tests: { model: "ParaClinicTest", owner: "paraClinic", kind: "paraClinic", title: (d) => d?.test?.name || "آزمایش" },
};

// A pharmacy's or a lab's booked insurer shares on orders, not on a list
// yet (or on `claimId`): the claim candidates «ord:<order>:<line>».
export const orderInsurerLines = async (
  owner: BizOwner,
  q: { name?: string; from?: Date | null; to?: Date | null; ids?: { order: string; line: string }[]; claimId?: unknown },
): Promise<OrderInsurerLine[]> => {
  if (!owner.id || (owner.kind !== "pharmacy" && owner.kind !== "paraClinic")) return [];
  const models = ORDER_INSURANCE_MODELS.filter((m) => catalog[m].kind === owner.kind);
  const out: OrderInsurerLine[] = [];
  for (const model of models) {
    const c = catalog[model];
    const items = await mongoose
      .model(c.model)
      .find({ [c.owner]: owner.id })
      .select("_id")
      .lean<{ _id: mongoose.Types.ObjectId }[]>();
    if (!items.length) continue;
    const filter: Record<string, unknown> = {
      status: "paid",
      [model]: { $elemMatch: { item: { $in: items.map((i) => i._id) }, insuranceStatus: "booked" } },
    };
    if (q.ids) filter._id = { $in: q.ids.map((i) => new mongoose.Types.ObjectId(i.order)) };
    if (q.from || q.to) filter.paidAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    if (q.name) filter["insurance.name"] = q.name;
    const mine = new Set(items.map((i) => String(i._id)));
    const want = q.ids ? new Set(q.ids.map((i) => `${i.order}:${i.line}`)) : null;
    const rows = await Order.find(filter)
      .sort({ paidAt: 1 })
      .limit(1000)
      .select(`paidAt submittedAt insurance user ${model}`)
      .populate({ path: "user", select: "identity", populate: { path: "identity", select: "givenName lastName" } })
      .populate(
        model === "products"
          ? { path: `${model}.item`, select: "product", populate: { path: "product", select: "name" } }
          : model === "tests"
            ? { path: `${model}.item`, select: "test", populate: { path: "test", select: "name" } }
            : { path: `${model}.item`, select: "name" },
      )
      .lean<IOrder[]>();
    for (const o of rows) {
      const idn = (o.user as unknown as { identity?: { givenName?: string; lastName?: string } })?.identity;
      for (const l of ((o as unknown as Record<string, (Line & { item?: unknown; price?: number })[]>)[model] || [])) {
        if (l.insuranceStatus !== "booked" || !(Number(l.insurerShare) > 0) || !mine.has(idOf(l.item))) continue;
        if (l.insuranceClaim && !(q.claimId && idOf(l.insuranceClaim) === idOf(q.claimId))) continue;
        if (want && !want.has(`${idOf(o._id)}:${idOf(l._id)}`)) continue;
        out.push({
          order: o._id as unknown as mongoose.Types.ObjectId,
          orderLine: l._id as mongoose.Types.ObjectId,
          model,
          date: o.paidAt || o.submittedAt,
          patient: `${idn?.givenName || ""} ${idn?.lastName || ""}`.trim(),
          service: c.title(l.item),
          total: Math.round((Number(l.price) || 0) * (Number(l.qty) || 1)),
          share: Math.round(Number(l.insurerShare) || 0),
          name: o.insurance?.name || "",
        });
      }
    }
  }
  return out;
};

// the lines of a list point back at it (or are let go)
export const markOrderInsurerLines = async (claimId: unknown, items: { order?: unknown; orderLine?: unknown }[]) => {
  for (const it of items) {
    if (!it.order || !it.orderLine) continue;
    for (const model of ORDER_INSURANCE_MODELS)
      await Order.updateOne(
        { _id: it.order, [`${model}._id`]: it.orderLine },
        { $set: { [`${model}.$.insuranceClaim`]: claimId } },
      );
  }
};

export const releaseOrderInsurerLines = async (claimId: unknown, keep: { order?: unknown; orderLine?: unknown }[] = []) => {
  const kept = new Set(keep.filter((k) => k.orderLine).map((k) => idOf(k.orderLine)));
  for (const model of ORDER_INSURANCE_MODELS) {
    const rows = await Order.find({ [`${model}.insuranceClaim`]: claimId }).select(model).lean<IOrder[]>();
    for (const o of rows)
      for (const l of ((o as unknown as Record<string, Line[]>)[model] || []))
        if (idOf(l.insuranceClaim) === idOf(claimId) && !kept.has(idOf(l._id)))
          await Order.updateOne({ _id: o._id, [`${model}._id`]: l._id }, { $unset: { [`${model}.$.insuranceClaim`]: 1 } });
  }
};
