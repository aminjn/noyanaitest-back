import mongoose from "mongoose";
import BizCostCenter, { IBizCostCenter } from "../../Models/BizCostCenter";
import BizVoucher from "../../Models/BizVoucher";
import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import { BizAllocation, IBizAllocation } from "../../Models/BizTreasury";
import AppError from "../AppError";
import { BizOwner, ownerFilter } from "./coa";
import { postVoucher, PostLine } from "./voucher";
import { createsCycle, distribute } from "./accCore";

// Cost centres as a tree and cost allocation (2026-10), after Nexxa's
// accounting/cost-centers (saveCostCenter / deleteCostCenter: a code from
// 50001, a parent with no loops, no delete with history or children) and
// accounting/cost-allocation (saveAllocation / runAllocation: a source
// centre's net expense, per account, moved to the target centres by
// percent in one voucher - every account's total unchanged).

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));
const ownerFields = (owner: BizOwner) =>
  owner.kind === "platform" || !owner.id ? { ownerKind: owner.kind } : { ownerKind: owner.kind, ownerId: oid(owner.id) };

export const saveCenter = async (
  owner: BizOwner,
  d: { id?: string; name: string; code?: string; parent?: string | null; description?: string; isActive?: boolean },
) => {
  const name = (d.name || "").trim().replace(/\s+/g, " ");
  if (name.length < 2) throw new AppError("نام مرکز هزینه را وارد کنید", 400);
  const all = await BizCostCenter.find(ownerFilter(owner)).lean<IBizCostCenter[]>();
  const parent = d.parent && mongoose.isValidObjectId(d.parent) ? all.find((c) => String(c._id) === d.parent) : undefined;
  if (d.parent && !parent) throw new AppError("مرکز هزینه پیدا نشد", 400);
  let code = (d.code || "").replace(/\D/g, "");
  if (code && all.some((c) => c.code === code && String(c._id) !== d.id)) throw new AppError("این کد مرکز هزینه تکراری است", 400);
  if (!code && !d.id) {
    let n = 50001 + all.length;
    while (all.some((c) => c.code === String(n))) n++;
    code = String(n);
  }
  if (d.id) {
    const doc = await BizCostCenter.findOne({ ...ownerFilter(owner), _id: d.id });
    if (!doc) throw new AppError("مرکز هزینه پیدا نشد", 404);
    const parents = new Map(all.map((c) => [String(c._id), c.parent ? String(c.parent) : null]));
    if (createsCycle(parents, String(doc._id), parent ? String(parent._id) : null)) throw new AppError("این والد حلقه می‌سازد", 400);
    doc.name = name;
    if (code) doc.code = code;
    doc.parent = parent ? parent._id : undefined;
    doc.description = d.description?.trim().slice(0, 300) || undefined;
    if (d.isActive !== undefined) doc.isActive = d.isActive;
    await doc.save().catch((err) => {
      if (err?.code === 11000) throw new AppError("مرکز هزینه‌ای با این نام هست", 400);
      throw err;
    });
    return doc.toObject();
  }
  const doc = await BizCostCenter.create({
    ...ownerFields(owner),
    name,
    code,
    parent: parent?._id,
    description: d.description?.trim().slice(0, 300) || undefined,
  }).catch((err) => {
    if (err?.code === 11000) throw new AppError("مرکز هزینه‌ای با این نام هست", 400);
    throw err;
  });
  return doc.toObject();
};

export const deleteCenter = async (owner: BizOwner, id: string) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError("مرکز هزینه پیدا نشد", 404);
  const c = await BizCostCenter.findOne({ ...ownerFilter(owner), _id: id }).lean<IBizCostCenter>();
  if (!c) throw new AppError("مرکز هزینه پیدا نشد", 404);
  if (await BizCostCenter.exists({ ...ownerFilter(owner), parent: c._id })) throw new AppError("این مرکز زیرمجموعه دارد و حذف نمی‌شود", 400);
  const used = await BizVoucher.exists({ ...ownerFilter(owner), $or: [{ center: c._id }, { "lines.center": c._id }] }).setOptions({ withDrafts: true });
  if (used) throw new AppError("این مرکز گردش دارد و حذف نمی‌شود؛ می‌توانید غیرفعالش کنید", 400);
  await BizCostCenter.deleteOne({ _id: c._id });
};

// ----------------------------------------------------------- allocation

export const listAllocations = (owner: BizOwner) => BizAllocation.find(ownerFilter(owner)).sort({ createdAt: -1 }).lean<IBizAllocation[]>();

export const saveAllocation = async (owner: BizOwner, d: { id?: string; title: string; source: string; lines: { target: string; percent: number }[] }) => {
  const title = (d.title || "").trim().slice(0, 120);
  if (!title || !mongoose.isValidObjectId(d.source)) throw new AppError("عنوان، مرکز مبدأ و دست‌کم یک مقصد را وارد کنید", 400);
  const centers = new Set((await BizCostCenter.find(ownerFilter(owner)).select("_id").lean()).map((c) => String(c._id)));
  if (!centers.has(d.source)) throw new AppError("مرکز هزینه پیدا نشد", 400);
  const lines = (Array.isArray(d.lines) ? d.lines : [])
    .filter((l) => l && centers.has(String(l.target)) && String(l.target) !== d.source && Number(l.percent) > 0)
    .map((l) => ({ target: oid(l.target), percent: Math.min(100, Number(l.percent)) }));
  if (!lines.length) throw new AppError("عنوان، مرکز مبدأ و دست‌کم یک مقصد را وارد کنید", 400);
  if (d.id) {
    const doc = await BizAllocation.findOneAndUpdate({ ...ownerFilter(owner), _id: d.id }, { $set: { title, source: oid(d.source), lines } }, { new: true }).lean();
    if (!doc) throw new AppError("قانون تسهیم پیدا نشد", 404);
    return doc;
  }
  return (await BizAllocation.create({ ...ownerFields(owner), title, source: oid(d.source), lines })).toObject();
};

export const deleteAllocation = async (owner: BizOwner, id: string) => {
  const r = await BizAllocation.deleteOne({ ...ownerFilter(owner), _id: id });
  if (!r.deletedCount) throw new AppError("قانون تسهیم پیدا نشد", 404);
};

// runs a rule for a period (Nexxa runAllocation): only a net debit
// (expense) is moved; one voucher per rule and period
export const runAllocation = async (owner: BizOwner, id: string, from: Date, to: Date, by?: unknown) => {
  const alloc = await BizAllocation.findOne({ ...ownerFilter(owner), _id: id }).lean<IBizAllocation>();
  if (!alloc || !alloc.lines.length) throw new AppError("قانون تسهیم پیدا نشد", 404);
  const expenseCodes = (await BizAccount.find({ ...ownerFilter(owner), type: "expense", level: "detail" }).select("code").lean<IBizAccount[]>()).map((a) => a.code);
  const rows = await BizVoucher.aggregate([
    { $match: { ...ownerFilter(owner), phase: { $exists: false }, date: { $gte: from, $lte: to } } },
    { $unwind: "$lines" },
    { $match: { "lines.code": { $in: expenseCodes } } },
    { $match: { $expr: { $eq: [{ $ifNull: ["$lines.center", "$center"] }, alloc.source] } } },
    { $group: { _id: "$lines.account", net: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } },
  ]);
  const centers = new Map((await BizCostCenter.find(ownerFilter(owner)).lean<IBizCostCenter[]>()).map((c) => [String(c._id), c.name]));
  const percents = alloc.lines.map((l) => l.percent);
  const lines: PostLine[] = [];
  for (const r of rows) {
    const net = Math.round(r.net);
    if (net <= 0) continue;
    lines.push({ accountId: r._id, center: alloc.source, label: `تسهیم از ${centers.get(String(alloc.source)) || ""}`.trim(), credit: net });
    const parts = distribute(net, percents);
    alloc.lines.forEach((l, i) => {
      if (parts[i] > 0) lines.push({ accountId: r._id, center: l.target, label: `تسهیم به ${centers.get(String(l.target)) || ""}`.trim(), debit: parts[i] });
    });
  }
  if (lines.length < 2) throw new AppError("در این دوره هزینه‌ای برای تسهیم نیست", 400);
  const key = `${from.toISOString().slice(0, 10)}:${to.toISOString().slice(0, 10)}`;
  const v = await postVoucher(owner, {
    ref: `alloc:${alloc._id}:${key}`,
    date: to,
    description: `تسهیم هزینه — ${alloc.title}`,
    source: { type: "allocation", id: alloc._id },
    lines,
    createdBy: by,
  });
  await BizAllocation.updateOne({ _id: alloc._id }, { $set: { lastRunAt: new Date() } });
  return v;
};
