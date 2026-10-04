import mongoose from "mongoose";
import { BizAssetEvent, BizAssetGroup, BizFixedAsset, IBizAssetEvent, IBizAssetGroup, IBizFixedAsset } from "../../Models/BizFixedAsset";
import BizAccount, { IBizAccount } from "../../Models/BizAccount";
import BizVoucher from "../../Models/BizVoucher";
import AppError from "../AppError";
import { accountFor, BizOwner, ensureChart, ownerFilter } from "./coa";
import { nextDocNumber, postVoucher, PostLine } from "./voucher";
import { computeRevaluation, depreciationForMonths, IRAN_DEP_PRESETS, wholeMonths } from "./accCore";
import { treasuryCredit } from "./treasury";

// Fixed assets (2026-10), a port of Nexxa's accounting/assets/* and the
// enterprise actions createFixedAsset, runDepreciation, disposeFixedAsset,
// revalueFixedAsset, createAssetMaintenance, transferAsset, asset groups -
// on the Noyan chart: the asset account of its group (2501 medical
// equipment, 2502 furniture, or one the owner opened under 25), 2522
// accumulated depreciation, 7213 depreciation expense, 7216 gain/loss on
// disposal, 5104 revaluation surplus, 7207 repair and maintenance.

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));
const ownerFields = (owner: BizOwner) =>
  owner.kind === "platform" || !owner.id ? { ownerKind: owner.kind } : { ownerKind: owner.kind, ownerId: oid(owner.id) };
const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ------------------------------------------------------------- groups

export const listGroups = (owner: BizOwner) => BizAssetGroup.find(ownerFilter(owner)).sort({ name: 1 }).lean<IBizAssetGroup[]>();

const assetAccountOf = async (owner: BizOwner, id?: unknown, role: "equipment" | "furniture" = "equipment") => {
  await ensureChart(owner);
  if (id && mongoose.isValidObjectId(String(id))) {
    const acc = await BizAccount.findOne({ ...ownerFilter(owner), _id: id, type: "asset", level: "detail", parentCode: "25" }).lean<IBizAccount>();
    if (acc && acc.role !== "accumulatedDepreciation") return acc;
    throw new AppError("حساب دارایی باید یکی از حساب‌های معین «دارایی‌های ثابت» باشد", 400);
  }
  return accountFor(owner, owner.kind === "platform" || owner.kind === "insurance" ? "furniture" : role).catch(() => accountFor(owner, "furniture"));
};

export const saveGroup = async (owner: BizOwner, d: { id?: string; name: string; usefulLifeYears?: number; method?: string; decliningRate?: number; account?: string }) => {
  const name = (d.name || "").trim().slice(0, 120);
  if (name.length < 2) throw new AppError("نام گروه دارایی را بنویسید", 400);
  const account = await assetAccountOf(owner, d.account);
  const set = {
    name,
    usefulLifeYears: Math.max(1, Math.round(num(d.usefulLifeYears, 5))),
    method: d.method === "declining" ? "declining" : "straight",
    decliningRate: Math.max(0, Math.min(100, num(d.decliningRate))),
    account: account._id,
  };
  if (d.id) {
    const doc = await BizAssetGroup.findOneAndUpdate({ ...ownerFilter(owner), _id: d.id }, { $set: set }, { new: true }).lean();
    if (!doc) throw new AppError("گروه دارایی پیدا نشد", 404);
    return doc;
  }
  return (await BizAssetGroup.create({ ...ownerFields(owner), ...set })).toObject();
};

// the Iranian presets as groups, once (an empty register's first step)
export const seedGroups = async (owner: BizOwner) => {
  const have = new Set((await listGroups(owner)).map((g) => g.name));
  for (const p of IRAN_DEP_PRESETS) {
    if (have.has(p.name)) continue;
    const account = await assetAccountOf(owner, undefined, p.role);
    await BizAssetGroup.create({ ...ownerFields(owner), name: p.name, usefulLifeYears: p.usefulLifeYears, method: p.method, decliningRate: p.decliningRate, account: account._id });
  }
  return listGroups(owner);
};

// a group goes; its assets keep their parameters (Nexxa deleteAssetGroup)
export const deleteGroup = async (owner: BizOwner, id: string) => {
  const g = await BizAssetGroup.findOne({ ...ownerFilter(owner), _id: id }).lean();
  if (!g) throw new AppError("گروه دارایی پیدا نشد", 404);
  await BizFixedAsset.updateMany({ ...ownerFilter(owner), group: g._id }, { $unset: { group: 1 } });
  await BizAssetGroup.deleteOne({ _id: g._id });
};

// ------------------------------------------------------------- assets

export type AssetInput = {
  name: string;
  code?: string;
  category?: string;
  group?: string;
  account?: string;
  cost: number;
  salvageValue?: number;
  usefulLifeYears?: number;
  method?: string;
  decliningRate?: number;
  acquisitionDate?: Date;
  serial?: string;
  location?: string;
  custodian?: string;
  center?: string;
  // book the purchase: paid from a till / bank, owed to the vendor, or an
  // asset the practice already had (opening, with its depreciation so far)
  book?: "money" | "payable" | "opening" | "none";
  money?: string;
  vendor?: string;
  priorDepreciation?: number;
};

export const createAsset = async (owner: BizOwner, d: AssetInput, by?: unknown) => {
  const name = (d.name || "").trim().slice(0, 200);
  const cost = Math.max(0, Math.round(num(d.cost)));
  if (!name || cost <= 0) throw new AppError("نام دارایی و بهای آن را وارد کنید", 400);
  const group = d.group && mongoose.isValidObjectId(d.group) ? await BizAssetGroup.findOne({ ...ownerFilter(owner), _id: d.group }).lean<IBizAssetGroup>() : null;
  const account = await assetAccountOf(owner, d.account || group?.account);
  let code = (d.code || "").trim().slice(0, 30);
  if (code && (await BizFixedAsset.exists({ ...ownerFilter(owner), code }))) throw new AppError("این کد دارایی تکراری است", 400);
  if (!code) code = String(100 + (await nextDocNumber("asset", owner)));
  const prior = Math.max(0, Math.min(cost, Math.round(num(d.priorDepreciation))));
  const acquisitionDate = d.acquisitionDate && !Number.isNaN(d.acquisitionDate.getTime()) ? d.acquisitionDate : new Date();
  const method = (d.method || group?.method) === "declining" ? "declining" : "straight";
  const asset = await BizFixedAsset.create({
    ...ownerFields(owner),
    code,
    name,
    category: (d.category || group?.name || "").trim().slice(0, 120),
    group: group?._id,
    account: account._id,
    acquisitionDate,
    cost,
    salvageValue: Math.max(0, Math.round(num(d.salvageValue))),
    usefulLifeYears: Math.max(1, Math.round(num(d.usefulLifeYears, group?.usefulLifeYears ?? 5))),
    method,
    decliningRate: Math.max(0, num(d.decliningRate, group?.decliningRate ?? 0)),
    accumulatedDep: d.book === "opening" ? prior : 0,
    serial: d.serial?.trim().slice(0, 80) || undefined,
    location: d.location?.trim().slice(0, 200) || undefined,
    custodian: d.custodian?.trim().slice(0, 200) || undefined,
    center: d.center && mongoose.isValidObjectId(d.center) ? oid(d.center) : undefined,
    createdBy: by,
  });
  if (d.book && d.book !== "none") {
    try {
      const label = `خرید دارایی ${name}`;
      const lines: PostLine[] = [{ accountId: account._id, label, debit: cost }];
      if (d.book === "money") {
        const credit = await treasuryCredit(owner, d.money, cost, "خرید دارایی");
        lines.push({ ...credit, label });
      } else if (d.book === "payable") {
        lines.push({ role: "payable", party: d.vendor?.trim() ? { kind: "supplier", name: d.vendor.trim() } : undefined, label, credit: cost });
      } else {
        if (prior > 0) lines.push({ role: "accumulatedDepreciation", label: `استهلاک انباشته‌ی ${name}`, credit: prior });
        lines.push({ role: "openingBalance", label, credit: cost - prior });
      }
      const ref = `fa:${asset._id}`;
      await postVoucher(owner, {
        ref,
        kind: d.book === "opening" ? "opening" : "auto",
        date: acquisitionDate,
        description: d.book === "opening" ? "دارایی ثابت اول دوره" : "خرید دارایی ثابت",
        source: { type: "asset", id: asset._id },
        center: asset.center,
        lines,
        createdBy: by,
      });
      asset.voucherRef = ref;
      await asset.save();
    } catch (err) {
      await BizFixedAsset.deleteOne({ _id: asset._id });
      throw err;
    }
  }
  return asset.toObject();
};

// details only - no voucher is written again (Nexxa updateFixedAsset)
export const updateAsset = async (owner: BizOwner, id: string, d: Partial<AssetInput>) => {
  const a = await BizFixedAsset.findOne({ ...ownerFilter(owner), _id: id });
  if (!a) throw new AppError("دارایی پیدا نشد", 404);
  if (d.name !== undefined) {
    if (!d.name.trim()) throw new AppError("نام دارایی و بهای آن را وارد کنید", 400);
    a.name = d.name.trim().slice(0, 200);
  }
  if (d.category !== undefined) a.category = d.category.trim().slice(0, 120);
  if (d.salvageValue !== undefined) a.salvageValue = Math.max(0, Math.round(num(d.salvageValue)));
  if (d.usefulLifeYears !== undefined) a.usefulLifeYears = Math.max(1, Math.round(num(d.usefulLifeYears, a.usefulLifeYears)));
  if (d.method !== undefined) a.method = d.method === "declining" ? "declining" : "straight";
  if (d.decliningRate !== undefined) a.decliningRate = Math.max(0, num(d.decliningRate));
  if (d.serial !== undefined) a.serial = d.serial.trim().slice(0, 80) || undefined;
  if (d.group !== undefined) a.group = d.group && mongoose.isValidObjectId(d.group) ? oid(d.group) : undefined;
  if (d.center !== undefined) a.center = d.center && mongoose.isValidObjectId(d.center) ? oid(d.center) : undefined;
  await a.save();
  return a.toObject();
};

// an asset with no depreciation posted can go, with its purchase voucher
// reversed; one already depreciated is disposed instead
export const deleteAsset = async (owner: BizOwner, id: string, by?: unknown) => {
  const a = await BizFixedAsset.findOne({ ...ownerFilter(owner), _id: id }).lean<IBizFixedAsset>();
  if (!a) throw new AppError("دارایی پیدا نشد", 404);
  if (a.lastDepDate || a.state === "disposed") throw new AppError("این دارایی استهلاک خورده است؛ به‌جای حذف، خروج آن را ثبت کنید", 400);
  if (a.voucherRef) {
    const v = await BizVoucher.findOne({ ...ownerFilter(owner), ref: a.voucherRef }).lean();
    if (v)
      await postVoucher(owner, {
        ref: `${a.voucherRef}:void`,
        date: new Date(),
        description: "حذف دارایی ثابت",
        source: { type: "asset", id: a._id },
        lines: v.lines.map((l) => ({ accountId: l.account, party: l.party, center: l.center, label: l.label, debit: l.credit, credit: l.debit })),
        createdBy: by,
      });
  }
  await BizAssetEvent.deleteMany({ ...ownerFilter(owner), asset: a._id, kind: { $ne: "revaluation" } });
  await BizFixedAsset.deleteOne({ _id: a._id });
};

const depOf = (a: IBizFixedAsset, months: number) =>
  depreciationForMonths(
    { cost: a.cost, salvageValue: a.salvageValue, usefulLifeYears: a.usefulLifeYears, method: a.method, decliningRate: a.decliningRate, accumulatedDep: a.accumulatedDep },
    months,
  );

// One aggregated depreciation voucher for every active asset's months
// passed since its last run (Nexxa runDepreciation): the same month run
// twice is zero, never depreciated twice.
export const runDepreciation = async (owner: BizOwner, by?: unknown, until = new Date()) => {
  await ensureChart(owner);
  const assets = await BizFixedAsset.find({ ...ownerFilter(owner), state: "active" }).lean<IBizFixedAsset[]>();
  const updates: { id: mongoose.Types.ObjectId; dep: number; from: Date | undefined }[] = [];
  for (const a of assets) {
    const months = wholeMonths(a.lastDepDate ?? a.acquisitionDate, until);
    const dep = depOf(a, months);
    if (dep > 0) updates.push({ id: a._id, dep, from: a.lastDepDate });
  }
  const total = updates.reduce((s, u) => s + u.dep, 0);
  if (total <= 0) return { total: 0, assets: 0 };
  // claim every asset first: a run that loses the race on one skips it
  const claimed: typeof updates = [];
  for (const u of updates) {
    const r = await BizFixedAsset.updateOne(
      { _id: u.id, ...(u.from ? { lastDepDate: u.from } : { lastDepDate: { $exists: false } }) },
      { $inc: { accumulatedDep: u.dep }, $set: { lastDepDate: until } },
    );
    if (r.modifiedCount) claimed.push(u);
  }
  const sum = claimed.reduce((s, u) => s + u.dep, 0);
  if (sum <= 0) return { total: 0, assets: 0 };
  const seq = await nextDocNumber("dep", owner);
  try {
    await postVoucher(owner, {
      ref: `dep:${seq}`,
      date: until,
      description: "استهلاک دارایی‌های ثابت",
      source: { type: "depreciation", id: claimed[0].id },
      lines: [
        { role: "depreciation", label: "هزینه‌ی استهلاک دوره", debit: sum },
        { role: "accumulatedDepreciation", label: "استهلاک انباشته‌ی دوره", credit: sum },
      ],
      createdBy: by,
    });
  } catch (err) {
    for (const u of claimed) await BizFixedAsset.updateOne({ _id: u.id }, { $inc: { accumulatedDep: -u.dep }, $set: { lastDepDate: u.from }, ...(u.from ? {} : { $unset: { lastDepDate: 1 } }) });
    throw err;
  }
  return { total: sum, assets: claimed.length };
};

// the months to come of one asset (the schedule on its page)
export const schedule = (a: IBizFixedAsset, months = 24) => {
  const rows: { month: number; dep: number; accumulated: number; bookValue: number }[] = [];
  let state = { ...a };
  for (let i = 1; i <= months; i++) {
    const dep = depOf(state as IBizFixedAsset, 1);
    if (dep <= 0) break;
    state = { ...state, accumulatedDep: state.accumulatedDep + dep };
    rows.push({ month: i, dep, accumulated: state.accumulatedDep, bookValue: state.cost - state.accumulatedDep });
  }
  return rows;
};

// Sale or scrap (Nexxa disposeFixedAsset): the depreciation still due up to
// the date, then cost and accumulated depreciation out, proceeds in, the
// difference a gain or loss.
export const disposeAsset = async (owner: BizOwner, id: string, d: { date?: Date; proceeds?: number; money?: string; note?: string }, by?: unknown) => {
  const a = await BizFixedAsset.findOne({ ...ownerFilter(owner), _id: id, state: "active" }).lean<IBizFixedAsset>();
  if (!a) throw new AppError("دارایی فعال پیدا نشد", 404);
  const date = d.date && !Number.isNaN(d.date.getTime()) ? d.date : new Date();
  const proceeds = Math.max(0, Math.round(num(d.proceeds)));
  const claim = await BizFixedAsset.updateOne({ _id: a._id, state: "active" }, { $set: { state: "disposed" } });
  if (!claim.modifiedCount) throw new AppError("دارایی فعال پیدا نشد", 404);
  try {
    const pending = depOf(a, wholeMonths(a.lastDepDate ?? a.acquisitionDate, date));
    if (pending > 0)
      await postVoucher(owner, {
        ref: `fa:${a._id}:dep-disposal`,
        date,
        description: "استهلاک تا تاریخ خروج دارایی",
        source: { type: "asset", id: a._id },
        lines: [
          { role: "depreciation", label: `استهلاک معوق ${a.name} تا تاریخ خروج`, debit: pending },
          { role: "accumulatedDepreciation", label: `استهلاک انباشته‌ی ${a.name}`, credit: pending },
        ],
        createdBy: by,
      });
    const accum = a.accumulatedDep + pending;
    const net = a.cost - accum - proceeds;
    const lines: PostLine[] = [
      { role: "accumulatedDepreciation", label: `حذف استهلاک انباشته‌ی ${a.name}`, debit: accum },
      { accountId: a.account, label: `حذف بهای دارایی ${a.name}`, credit: a.cost },
    ];
    if (proceeds > 0) lines.push({ ...(await treasuryDebit(owner, d.money)), label: `عواید فروش ${a.name}`, debit: proceeds });
    if (net > 0) lines.push({ role: "assetDisposal", label: `زیان خروج ${a.name}`, debit: net });
    else if (net < 0) lines.push({ role: "assetDisposal", label: `سود خروج ${a.name}`, credit: -net });
    await postVoucher(owner, {
      ref: `fa:${a._id}:disposal`,
      date,
      description: proceeds > 0 ? "فروش دارایی ثابت" : "اسقاط دارایی ثابت",
      source: { type: "asset", id: a._id },
      lines,
      createdBy: by,
    });
    await BizFixedAsset.updateOne(
      { _id: a._id },
      { $set: { accumulatedDep: accum, lastDepDate: date, disposalDate: date, disposalProceeds: proceeds, disposalNote: d.note?.slice(0, 500) } },
    );
  } catch (err) {
    await BizFixedAsset.updateOne({ _id: a._id }, { $set: { state: "active" } });
    throw err;
  }
  return BizFixedAsset.findById(a._id).lean();
};

// the till/bank line on the debit side (proceeds)
const treasuryDebit = async (owner: BizOwner, money?: string): Promise<PostLine> => {
  const credit = await treasuryCredit(owner, money, 0, "", true);
  return { accountId: credit.accountId };
};

// Revaluation (Nexxa revalueFixedAsset, IAS 16 proportional): cost and
// accumulated depreciation scaled to the fair value; the surplus to 5104,
// a decrease beyond earlier surplus to the disposal gain/loss account.
export const revalueAsset = async (owner: BizOwner, id: string, d: { fairValue: number; date?: Date; note?: string }, by?: unknown) => {
  const a = await BizFixedAsset.findOne({ ...ownerFilter(owner), _id: id, state: "active" }).lean<IBizFixedAsset>();
  if (!a) throw new AppError("دارایی فعال پیدا نشد", 404);
  const fair = Math.round(num(d.fairValue));
  if (fair < 0) throw new AppError("ارزش منصفانه را وارد کنید", 400);
  const r = computeRevaluation({ cost: a.cost, accumulatedDep: a.accumulatedDep }, fair, a.revaluationSurplus);
  const lines: PostLine[] = [];
  if (r.costDelta > 0) lines.push({ accountId: a.account, label: `تجدید ارزیابی ${a.name} — افزایش بها`, debit: r.costDelta });
  else if (r.costDelta < 0) lines.push({ accountId: a.account, label: `تجدید ارزیابی ${a.name} — کاهش بها`, credit: -r.costDelta });
  if (r.accumDelta > 0) lines.push({ role: "accumulatedDepreciation", label: `تجدید ارزیابی ${a.name} — استهلاک انباشته`, credit: r.accumDelta });
  else if (r.accumDelta < 0) lines.push({ role: "accumulatedDepreciation", label: `تجدید ارزیابی ${a.name} — استهلاک انباشته`, debit: -r.accumDelta });
  if (r.equityUp > 0) lines.push({ role: "revaluationSurplus", label: `مازاد تجدید ارزیابی ${a.name}`, credit: r.equityUp });
  if (r.equityDown > 0) lines.push({ role: "revaluationSurplus", label: `برگشت مازاد تجدید ارزیابی ${a.name}`, debit: r.equityDown });
  if (r.expense > 0) lines.push({ role: "assetDisposal", label: `کاهش ارزش ${a.name}`, debit: r.expense });
  if (lines.length < 2) throw new AppError("ارزش منصفانه با ارزش دفتری برابر است", 400);
  const date = d.date && !Number.isNaN(d.date.getTime()) ? d.date : new Date();
  const seq = await nextDocNumber("fa-rvl", owner);
  const ref = `fa:${a._id}:rvl:${seq}`;
  await postVoucher(owner, { ref, date, description: "تجدید ارزیابی دارایی ثابت", source: { type: "asset", id: a._id }, lines, createdBy: by });
  await BizFixedAsset.updateOne(
    { _id: a._id },
    { $set: { cost: r.newCost, accumulatedDep: r.newAccum, revaluedAt: date }, $inc: { revaluationSurplus: r.equityPortion } },
  );
  await BizAssetEvent.create({
    ...ownerFields(owner),
    asset: a._id,
    kind: "revaluation",
    date,
    oldCost: a.cost,
    oldAccum: a.accumulatedDep,
    oldNbv: r.oldNbv,
    fairValue: r.newCost - r.newAccum,
    surplus: r.surplus,
    equityPortion: r.equityPortion,
    voucherRef: ref,
    note: d.note?.slice(0, 500),
  });
  return BizFixedAsset.findById(a._id).lean();
};

// a revaluation undone: its voucher reversed, cost and accumulated back
export const undoRevaluation = async (owner: BizOwner, eventId: string, by?: unknown) => {
  const e = await BizAssetEvent.findOne({ ...ownerFilter(owner), _id: eventId, kind: "revaluation" }).lean<IBizAssetEvent>();
  if (!e) throw new AppError("تجدید ارزیابی پیدا نشد", 404);
  const later = await BizAssetEvent.exists({ ...ownerFilter(owner), asset: e.asset, kind: "revaluation", date: { $gt: e.date } });
  if (later) throw new AppError("ابتدا تجدید ارزیابی‌های بعدی را برگردانید", 400);
  const v = e.voucherRef ? await BizVoucher.findOne({ ...ownerFilter(owner), ref: e.voucherRef }).lean() : null;
  if (v)
    await postVoucher(owner, {
      ref: `${e.voucherRef}:void`,
      date: new Date(),
      description: "برگشت تجدید ارزیابی دارایی",
      source: { type: "asset", id: e.asset },
      lines: v.lines.map((l) => ({ accountId: l.account, label: l.label, debit: l.credit, credit: l.debit })),
      createdBy: by,
    });
  await BizFixedAsset.updateOne(
    { _id: e.asset },
    { $set: { cost: e.oldCost, accumulatedDep: e.oldAccum }, $inc: { revaluationSurplus: -(e.equityPortion || 0) } },
  );
  await BizAssetEvent.deleteOne({ _id: e._id });
};

// moved to another room or person (Nexxa transferAsset), no voucher
export const transferAsset = async (owner: BizOwner, id: string, d: { location?: string; custodian?: string; date?: Date; note?: string }) => {
  const a = await BizFixedAsset.findOne({ ...ownerFilter(owner), _id: id, state: "active" });
  if (!a) throw new AppError("دارایی فعال پیدا نشد", 404);
  const toLocation = d.location?.trim().slice(0, 200) || a.location;
  const toCustodian = d.custodian?.trim().slice(0, 200) || a.custodian;
  if (toLocation === a.location && toCustodian === a.custodian) throw new AppError("محل یا متصدی تازه‌ای وارد نشده است", 400);
  await BizAssetEvent.create({
    ...ownerFields(owner),
    asset: a._id,
    kind: "transfer",
    date: d.date && !Number.isNaN(d.date.getTime()) ? d.date : new Date(),
    fromLocation: a.location,
    toLocation,
    fromCustodian: a.custodian,
    toCustodian,
    note: d.note?.slice(0, 500),
  });
  a.location = toLocation;
  a.custodian = toCustodian;
  await a.save();
  return a.toObject();
};

// a repair or service, with its expense booked if paid (Nexxa
// createAssetMaintenance: Dr 7207 / Cr the till)
export const addMaintenance = async (
  owner: BizOwner,
  id: string,
  d: { date?: Date; kind?: string; cost?: number; vendor?: string; note?: string; nextDueDate?: Date | null; book?: boolean; money?: string },
  by?: unknown,
) => {
  const a = await BizFixedAsset.findOne({ ...ownerFilter(owner), _id: id }).lean<IBizFixedAsset>();
  if (!a) throw new AppError("دارایی پیدا نشد", 404);
  const cost = Math.max(0, Math.round(num(d.cost)));
  const date = d.date && !Number.isNaN(d.date.getTime()) ? d.date : new Date();
  const e = await BizAssetEvent.create({
    ...ownerFields(owner),
    asset: a._id,
    kind: "maintenance",
    date,
    maintenanceKind: ["repair", "service", "inspection", "upgrade"].includes(String(d.kind)) ? d.kind : "repair",
    cost,
    vendor: d.vendor?.trim().slice(0, 200) || undefined,
    note: d.note?.slice(0, 500),
    nextDueDate: d.nextDueDate || undefined,
  });
  if (d.book && cost > 0) {
    try {
      const credit = await treasuryCredit(owner, d.money, cost, "تعمیر دارایی");
      const ref = `fa:mnt:${e._id}`;
      await postVoucher(owner, {
        ref,
        date,
        description: "تعمیر و نگهداری دارایی",
        source: { type: "asset", id: a._id },
        center: a.center,
        lines: [
          { role: "maintenance", label: `تعمیر و نگهداری ${a.name}`, debit: cost },
          { ...credit, label: `پرداخت تعمیر ${a.name}` },
        ],
        createdBy: by,
      });
      await BizAssetEvent.updateOne({ _id: e._id }, { $set: { voucherRef: ref, money: d.money && mongoose.isValidObjectId(d.money) ? oid(d.money) : undefined } });
    } catch (err) {
      await BizAssetEvent.deleteOne({ _id: e._id });
      throw err;
    }
  }
  return BizAssetEvent.findById(e._id).lean();
};

// a maintenance record goes with its expense voucher reversed
export const deleteEvent = async (owner: BizOwner, eventId: string, by?: unknown) => {
  const e = await BizAssetEvent.findOne({ ...ownerFilter(owner), _id: eventId }).lean<IBizAssetEvent>();
  if (!e) throw new AppError("رکورد پیدا نشد", 404);
  if (e.kind === "revaluation") return undoRevaluation(owner, eventId, by);
  if (e.voucherRef) {
    const v = await BizVoucher.findOne({ ...ownerFilter(owner), ref: e.voucherRef }).lean();
    if (v)
      await postVoucher(owner, {
        ref: `${e.voucherRef}:void`,
        date: new Date(),
        description: "حذف هزینه‌ی تعمیر دارایی",
        source: { type: "asset", id: e.asset },
        lines: v.lines.map((l) => ({ accountId: l.account, label: l.label, debit: l.credit, credit: l.debit })),
        createdBy: by,
      });
  }
  await BizAssetEvent.deleteOne({ _id: e._id });
};

export const listAssets = async (owner: BizOwner, q: { state?: string; group?: string; q?: string }) => {
  const filter: Record<string, unknown> = { ...ownerFilter(owner) };
  if (q.state === "active" || q.state === "disposed") filter.state = q.state;
  if (q.group && mongoose.isValidObjectId(q.group)) filter.group = oid(q.group);
  if (q.q?.trim()) {
    const r = new RegExp(q.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: r }, { code: r }, { serial: r }, { location: r }];
  }
  const items = await BizFixedAsset.find(filter).sort({ code: 1 }).limit(1000).lean<IBizFixedAsset[]>();
  const now = new Date();
  return items.map((a) => ({
    ...a,
    bookValue: a.cost - a.accumulatedDep,
    // what a run today would add (the depreciation page)
    due: a.state === "active" ? depOf(a, wholeMonths(a.lastDepDate ?? a.acquisitionDate, now)) : 0,
  }));
};

export const getAsset = async (owner: BizOwner, id: string) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError("دارایی پیدا نشد", 404);
  const a = await BizFixedAsset.findOne({ ...ownerFilter(owner), _id: id }).lean<IBizFixedAsset>();
  if (!a) throw new AppError("دارایی پیدا نشد", 404);
  const events = await BizAssetEvent.find({ ...ownerFilter(owner), asset: a._id }).sort({ date: -1 }).lean<IBizAssetEvent[]>();
  return { asset: { ...a, bookValue: a.cost - a.accumulatedDep }, events, schedule: a.state === "active" ? schedule(a) : [] };
};

// the events of every asset by kind (the transfers / maintenance /
// revaluations pages)
export const listEvents = async (owner: BizOwner, kind: "transfer" | "maintenance" | "revaluation") => {
  const events = await BizAssetEvent.find({ ...ownerFilter(owner), kind }).sort({ date: -1 }).limit(500).lean<IBizAssetEvent[]>();
  const names = new Map(
    (await BizFixedAsset.find({ _id: { $in: events.map((e) => e.asset) } }).select("code name").lean<IBizFixedAsset[]>()).map((a) => [String(a._id), a]),
  );
  return events.map((e) => ({ ...e, assetName: names.get(String(e.asset))?.name || "", assetCode: names.get(String(e.asset))?.code || "" }));
};

// the asset report: totals by group (cost, accumulated, book value) and
// the maintenance falling due
export const assetReport = async (owner: BizOwner) => {
  const [assets, groups, due] = await Promise.all([
    BizFixedAsset.find(ownerFilter(owner)).lean<IBizFixedAsset[]>(),
    listGroups(owner),
    BizAssetEvent.find({ ...ownerFilter(owner), kind: "maintenance", nextDueDate: { $lte: new Date(Date.now() + 30 * 864e5) } })
      .sort({ nextDueDate: 1 })
      .limit(100)
      .lean<IBizAssetEvent[]>(),
  ]);
  const gName = new Map(groups.map((g) => [String(g._id), g.name]));
  const byGroup = new Map<string, { name: string; count: number; cost: number; accumulated: number; bookValue: number; disposed: number }>();
  for (const a of assets) {
    const key = a.group ? String(a.group) : "";
    const cur = byGroup.get(key) || { name: gName.get(key) || a.category || "", count: 0, cost: 0, accumulated: 0, bookValue: 0, disposed: 0 };
    if (a.state === "disposed") cur.disposed++;
    else {
      cur.count++;
      cur.cost += a.cost;
      cur.accumulated += a.accumulatedDep;
      cur.bookValue += a.cost - a.accumulatedDep;
    }
    byGroup.set(key, cur);
  }
  const names = new Map(assets.map((a) => [String(a._id), a.name]));
  return {
    groups: [...byGroup.values()],
    totals: {
      count: assets.filter((a) => a.state === "active").length,
      cost: assets.filter((a) => a.state === "active").reduce((s, a) => s + a.cost, 0),
      accumulated: assets.filter((a) => a.state === "active").reduce((s, a) => s + a.accumulatedDep, 0),
    },
    due: due.map((e) => ({ ...e, assetName: names.get(String(e.asset)) || "" })),
  };
};
