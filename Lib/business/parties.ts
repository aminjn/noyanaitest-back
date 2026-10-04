import mongoose from "mongoose";
import BizParty, { BizPartyKind, bizPartyKinds, IBizParty } from "../../Models/BizParty";
import BizVoucher from "../../Models/BizVoucher";
import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import BizSupplier, { IBizSupplier } from "../../Models/BizSupplier";
import AppError from "../AppError";
import { BizOwner, ownerFilter } from "./coa";

// The تفصیلی register (2026-10), after Nexxa's floating Tafsili
// (accounting/tafsili, statements, phonebook): any patient, supplier,
// insurer, team member, doctor, bank, project or free item the owner keeps
// a ledger for. Automatic vouchers find or create the party of a line by a
// key (an invoice's patient by national id / phone / name, an expense's
// vendor, a claim's insurer), so every receivable and payable already has
// its own balance; the owner adds the rest by hand.

// code ranges per kind, as Hamkaran / Sepidar keep the register
export const KIND_CODE_BASE: Record<BizPartyKind, number> = {
  patient: 10000,
  supplier: 15000,
  bank: 20000,
  person: 30000,
  project: 40000,
  insurer: 60000,
  doctor: 70000,
  custom: 90000,
};

// what a line names as its party: an id, or who it is
export type PartyInput = {
  kind: BizPartyKind;
  name: string;
  phone?: string;
  nationalId?: string;
  economicCode?: string;
  ref?: { type: string; id: unknown };
};
export type PartyRef = string | mongoose.Types.ObjectId | PartyInput;

const ownerFields = (owner: BizOwner) =>
  owner.kind === "platform" || !owner.id
    ? { ownerKind: owner.kind }
    : { ownerKind: owner.kind, ownerId: new mongoose.Types.ObjectId(String(owner.id)) };

const digits = (s?: string) => (s || "").replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/\D/g, "");

// the key an automatic voucher finds a party by
export const partyKeyOf = (p: PartyInput) => {
  if (p.ref?.id) return `${p.ref.type}:${String(p.ref.id)}`;
  const nid = digits(p.nationalId);
  if (nid) return `${p.kind}:nid:${nid}`;
  const phone = digits(p.phone).replace(/^0098|^98|^0/, "");
  if (phone.length >= 10) return `${p.kind}:tel:${phone}`;
  return `${p.kind}:nm:${p.name.trim().replace(/\s+/g, " ").toLowerCase()}`;
};

const nextCode = async (owner: BizOwner, kind: BizPartyKind) => {
  const base = KIND_CODE_BASE[kind] ?? 90000;
  const inKind = await BizParty.countDocuments({ ...ownerFilter(owner), kind });
  let n = base + inKind + 1;
  while (await BizParty.exists({ ...ownerFilter(owner), code: String(n) })) n++;
  return String(n);
};

// the id, or the party found / created from what the line says
export const resolveParty = async (owner: BizOwner, ref: PartyRef): Promise<IBizParty | null> => {
  if (!ref) return null;
  if (typeof ref === "string" || ref instanceof mongoose.Types.ObjectId) {
    if (!mongoose.isValidObjectId(String(ref))) return null;
    return BizParty.findOne({ ...ownerFilter(owner), _id: ref }).lean<IBizParty>();
  }
  return ensureParty(owner, ref);
};

export const ensureParty = async (owner: BizOwner, input: PartyInput): Promise<IBizParty | null> => {
  let p = input;
  // a supplier of the inventory module: its own name and economic code
  if (p.ref?.type === "supplier" && mongoose.isValidObjectId(String(p.ref.id))) {
    const sup = await BizSupplier.findById(p.ref.id).select("name phone economicCode").lean<IBizSupplier>();
    if (sup) p = { ...p, name: sup.name || p.name, phone: p.phone || sup.phone, economicCode: p.economicCode || sup.economicCode };
  }
  const name = (p.name || "").trim().slice(0, 200);
  if (!name || !bizPartyKinds.includes(p.kind)) return null;
  const key = partyKeyOf({ ...p, name });
  const hit = await BizParty.findOne({ ...ownerFilter(owner), key }).lean<IBizParty>();
  if (hit) return hit;
  for (let i = 0; i < 3; i++) {
    try {
      const doc = await BizParty.create({
        ...ownerFields(owner),
        code: await nextCode(owner, p.kind),
        kind: p.kind,
        name,
        phone: p.phone?.slice(0, 30) || undefined,
        nationalId: digits(p.nationalId).slice(0, 20) || undefined,
        economicCode: digits(p.economicCode).slice(0, 20) || undefined,
        ref: p.ref?.id && mongoose.isValidObjectId(String(p.ref.id)) ? { type: p.ref.type, id: new mongoose.Types.ObjectId(String(p.ref.id)) } : undefined,
        key,
      });
      return doc.toObject();
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      // the same key created concurrently, or a code taken: look again
      const again = await BizParty.findOne({ ...ownerFilter(owner), key }).lean<IBizParty>();
      if (again) return again;
    }
  }
  return null;
};

export type PartyForm = {
  kind: BizPartyKind;
  name: string;
  code?: string;
  phone?: string;
  nationalId?: string;
  economicCode?: string;
  postalCode?: string;
  address?: string;
  note?: string;
  isActive?: boolean;
};

// a party typed on the تفصیلی page (Nexxa createTafsili): the code is the
// next free one of its kind's range unless one is given
export const createParty = async (owner: BizOwner, d: PartyForm) => {
  const name = (d.name || "").trim();
  if (name.length < 2) throw new AppError("نام تفصیلی را بنویسید", 400);
  const kind = bizPartyKinds.includes(d.kind) ? d.kind : "custom";
  let code = digits(d.code);
  if (code) {
    if (await BizParty.exists({ ...ownerFilter(owner), code })) throw new AppError("این کد تفصیلی قبلاً استفاده شده است", 400);
  } else code = await nextCode(owner, kind);
  const doc = await BizParty.create({
    ...ownerFields(owner),
    code,
    kind,
    name: name.slice(0, 200),
    phone: d.phone?.trim().slice(0, 30) || undefined,
    nationalId: digits(d.nationalId).slice(0, 20) || undefined,
    economicCode: digits(d.economicCode).slice(0, 20) || undefined,
    postalCode: digits(d.postalCode).slice(0, 12) || undefined,
    address: d.address?.trim().slice(0, 400) || undefined,
    note: d.note?.trim().slice(0, 500) || undefined,
  });
  return doc.toObject();
};

export const updateParty = async (owner: BizOwner, id: string, d: Partial<PartyForm>) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError("تفصیلی پیدا نشد", 404);
  const doc = await BizParty.findOne({ ...ownerFilter(owner), _id: id });
  if (!doc) throw new AppError("تفصیلی پیدا نشد", 404);
  if (d.name !== undefined) {
    if (d.name.trim().length < 2) throw new AppError("نام تفصیلی را بنویسید", 400);
    doc.name = d.name.trim().slice(0, 200);
  }
  if (d.phone !== undefined) doc.phone = d.phone.trim().slice(0, 30) || undefined;
  if (d.nationalId !== undefined) doc.nationalId = digits(d.nationalId).slice(0, 20) || undefined;
  if (d.economicCode !== undefined) doc.economicCode = digits(d.economicCode).slice(0, 20) || undefined;
  if (d.postalCode !== undefined) doc.postalCode = digits(d.postalCode).slice(0, 12) || undefined;
  if (d.address !== undefined) doc.address = d.address.trim().slice(0, 400) || undefined;
  if (d.note !== undefined) doc.note = d.note.trim().slice(0, 500) || undefined;
  if (d.isActive !== undefined) doc.isActive = d.isActive;
  await doc.save();
  return doc.toObject();
};

// a party with no lines goes; one with history stays (Nexxa deleteTafsili)
export const deleteParty = async (owner: BizOwner, id: string) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError("تفصیلی پیدا نشد", 404);
  const doc = await BizParty.findOne({ ...ownerFilter(owner), _id: id }).lean<IBizParty>();
  if (!doc) throw new AppError("تفصیلی پیدا نشد", 404);
  if (await BizVoucher.exists({ ...ownerFilter(owner), "lines.party": doc._id }).setOptions({ withDrafts: true }))
    throw new AppError("این تفصیلی گردش دارد و حذف نمی‌شود؛ می‌توانید غیرفعالش کنید", 400);
  await BizParty.deleteOne({ _id: doc._id });
};

const rx = (q: string) => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

// the register (or the phonebook: the same rows with their phones)
export const listParties = async (owner: BizOwner, q: { kind?: string; q?: string; page: number; limit: number; active?: boolean }) => {
  const filter: Record<string, unknown> = { ...ownerFilter(owner) };
  if (q.kind && bizPartyKinds.includes(q.kind as BizPartyKind)) filter.kind = q.kind;
  if (q.active) filter.isActive = { $ne: false };
  if (q.q?.trim()) {
    const r = rx(q.q.trim());
    filter.$or = [{ name: r }, { code: r }, { phone: r }, { nationalId: r }];
  }
  const [items, total, counts] = await Promise.all([
    BizParty.find(filter).sort({ kind: 1, code: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean<IBizParty[]>(),
    BizParty.countDocuments(filter),
    BizParty.aggregate([{ $match: ownerFilter(owner) }, { $group: { _id: "$kind", n: { $sum: 1 } } }]),
  ]);
  return { items, total, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) };
};

// Every party's opening, period turnover and closing over a range
// (Nexxa statements: «گردش و مانده‌ی اشخاص»), optionally of one account.
export const partyBalances = async (
  owner: BizOwner,
  q: { from: Date | null; to: Date | null; kind?: string; account?: string; q?: string; status?: "debit" | "credit" | "settled" },
) => {
  const match: Record<string, unknown> = { ...ownerFilter(owner), phase: { $nin: ["final", "open"] } };
  if (q.to) match.date = { $lte: q.to };
  const lineMatch: Record<string, unknown> = { "lines.party": { $exists: true } };
  if (q.account && mongoose.isValidObjectId(q.account)) lineMatch["lines.account"] = new mongoose.Types.ObjectId(q.account);
  const rows = await BizVoucher.aggregate([
    { $match: match },
    { $unwind: "$lines" },
    { $match: lineMatch },
    {
      $group: {
        _id: "$lines.party",
        bD: { $sum: { $cond: [{ $lt: ["$date", q.from || new Date(0)] }, "$lines.debit", 0] } },
        bC: { $sum: { $cond: [{ $lt: ["$date", q.from || new Date(0)] }, "$lines.credit", 0] } },
        pD: { $sum: { $cond: [{ $gte: ["$date", q.from || new Date(0)] }, "$lines.debit", 0] } },
        pC: { $sum: { $cond: [{ $gte: ["$date", q.from || new Date(0)] }, "$lines.credit", 0] } },
        n: { $sum: { $cond: [{ $gte: ["$date", q.from || new Date(0)] }, 1, 0] } },
      },
    },
  ]);
  const pf: Record<string, unknown> = { ...ownerFilter(owner), _id: { $in: rows.map((r) => r._id) } };
  if (q.kind && bizPartyKinds.includes(q.kind as BizPartyKind)) pf.kind = q.kind;
  if (q.q?.trim()) pf.$or = [{ name: rx(q.q.trim()) }, { code: rx(q.q.trim()) }];
  const parties = new Map((await BizParty.find(pf).lean<IBizParty[]>()).map((p) => [String(p._id), p]));
  let out = rows
    .filter((r) => parties.has(String(r._id)))
    .map((r) => {
      const p = parties.get(String(r._id))!;
      const opening = r.bD - r.bC;
      const closing = opening + r.pD - r.pC;
      return { _id: String(p._id), code: p.code, name: p.name, kind: p.kind, phone: p.phone, opening, periodD: r.pD, periodC: r.pC, closing, count: r.n };
    })
    .filter((r) => r.count > 0 || Math.abs(r.closing) > 0.5 || Math.abs(r.opening) > 0.5);
  if (q.status === "debit") out = out.filter((r) => r.closing > 0.5);
  else if (q.status === "credit") out = out.filter((r) => r.closing < -0.5);
  else if (q.status === "settled") out = out.filter((r) => Math.abs(r.closing) < 0.5);
  out.sort((a, b) => Math.abs(b.closing) - Math.abs(a.closing));
  return {
    rows: out,
    totalDebit: out.reduce((s, r) => s + Math.max(0, r.closing), 0),
    totalCredit: out.reduce((s, r) => s + Math.max(0, -r.closing), 0),
  };
};

// the parties of a set of lines, for display
export const partyNames = async (ids: unknown[]) => {
  const valid = [...new Set(ids.filter(Boolean).map(String))].filter((i) => mongoose.isValidObjectId(i));
  if (!valid.length) return new Map<string, { _id: string; code: string; name: string; kind: string }>();
  const rows = await BizParty.find({ _id: { $in: valid } }).select("code name kind").lean<IBizParty[]>();
  return new Map(rows.map((r) => [String(r._id), { _id: String(r._id), code: r.code, name: r.name, kind: r.kind }]));
};

// Nexxa applyDefaultTafsiliLinks / autoLinkTafsili: which party kinds each
// detail account takes, from its role (only accounts not set yet)
const ROLE_KINDS: Record<string, BizPartyKind[]> = {
  receivable: ["patient", "person", "custom"],
  insuranceReceivable: ["insurer"],
  payable: ["supplier", "person", "doctor", "custom"],
  chequesReceivable: ["patient", "insurer", "person", "custom"],
  chequesPayable: ["supplier", "person", "doctor", "custom"],
  employeeAdvances: ["person"],
  salaryPayable: ["person", "doctor"],
  prepaid: ["supplier", "custom"],
};
export const autoLinkTafsili = async (owner: BizOwner) => {
  const accounts = await BizAccount.find({ ...ownerFilter(owner), level: "detail" }).lean<IBizAccount[]>();
  let n = 0;
  for (const a of accounts) {
    if (a.tafsiliKinds?.length) continue;
    const kinds = ROLE_KINDS[a.role || ""];
    if (!kinds) continue;
    await BizAccount.updateOne({ _id: a._id }, { $set: { tafsiliKinds: kinds } });
    n++;
  }
  return n;
};
