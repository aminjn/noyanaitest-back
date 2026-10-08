import mongoose from "mongoose";
import AppError, { BadInputError, NotFoundError } from "./AppError";
import { addTehranDays, parseTehranDay, startOfTehranDay } from "./tehranTime";
import InsuranceContract, {
  ContractProviderKind,
  ContractSide,
  contractProviderKinds,
  contractProviderModels,
  IInsuranceContract,
} from "../Models/InsuranceContract";
import DoctorInsurance from "../Models/DoctorInsurance";
import Insurance from "../Models/Insurance";
import { notifyWithSms, smsDate } from "../Services/notificationSmsService";

// The insurer ↔ provider contract lifecycle (Models/InsuranceContract.ts).
// Every state change goes through here: one-way, guarded by the status it
// leaves (two clicks or two sides at once cannot both win), the read model
// kept in step, and both sides told (in-app + SMS).

type Id = mongoose.Types.ObjectId | string;
type Lean = Record<string, any>;

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));
const isId = (v: unknown) => mongoose.isValidObjectId(String(v ?? ""));

export const isContractProviderKind = (v: unknown): v is ContractProviderKind =>
  typeof v === "string" && (contractProviderKinds as readonly string[]).includes(v);

export const providerModelOf = (kind: ContractProviderKind) =>
  mongoose.model(contractProviderModels[kind]) as mongoose.Model<any>;

// a provider that is on the site (an off / suspended one takes no new
// contract and lends none, like the booking quote)
export const providerActiveField: Record<ContractProviderKind, string> = {
  doctor: "active",
  clinic: "active",
  hospital: "isActive",
  paraClinic: "active",
  pharmacy: "active",
};

// the provider's kind word + name, as the notifications and SMS say it
// (the kind word is translated with the text, Lib/i18n/translateNotification.ts)
const kindWord: Record<ContractProviderKind, string> = {
  doctor: "پزشک",
  clinic: "کلینیک",
  hospital: "بیمارستان",
  paraClinic: "پاراکلینیک",
  pharmacy: "داروخانه",
};

// the provider panel page where its insurers are managed
const providerPanelLink: Record<ContractProviderKind, string> = {
  doctor: "/doctorpanel/insurance",
  clinic: "/clinicpanel/profile",
  hospital: "/hospitalpanel/profile",
  paraClinic: "/paraClinicPanel/profile",
  pharmacy: "/pharmacypanel/profile",
};
const INSURER_PANEL_LINK = "/insurancepanel/network";

export const providerNameOf = (kind: ContractProviderKind, doc: Lean | null | undefined) =>
  kind === "doctor"
    ? [doc?.firstName, doc?.lastName].filter(Boolean).join(" ")
    : String(doc?.name || "");

const providerLabel = (kind: ContractProviderKind, doc: Lean | null | undefined) =>
  `${kindWord[kind]} ${providerNameOf(kind, doc)}`.trim();

// ------------------------------------------------------------ the rule

// An Active contract inside its validity: the only thing that counts as
// "accepts this insurer" anywhere on the site.
export const effectiveContractFilter = (now: Date = new Date()) => ({
  status: "Active",
  $and: [
    { $or: [{ validFrom: null }, { validFrom: { $lte: now } }] },
    { $or: [{ validUntil: null }, { validUntil: { $gt: now } }] },
    { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] },
  ],
});

export const isEffective = (c: Pick<IInsuranceContract, "status" | "validFrom" | "validUntil" | "endsAt">, now = new Date()) =>
  c.status === "Active" &&
  (!c.validFrom || +new Date(c.validFrom) <= +now) &&
  (!c.validUntil || +new Date(c.validUntil) > +now) &&
  (!c.endsAt || +new Date(c.endsAt) > +now);

export type EffectiveRow = { insurance: string; providerKind: ContractProviderKind; provider: string };

// the effective contracts matching `filter` (insurance / providerKind /
// provider), as plain ids
export const effectiveContracts = async (filter: Record<string, unknown>): Promise<EffectiveRow[]> => {
  const rows = await InsuranceContract.find({ ...filter, ...effectiveContractFilter() })
    .select("insurance providerKind provider")
    .lean<{ insurance?: unknown; providerKind?: ContractProviderKind; provider?: unknown }[]>();
  return rows
    .filter((r) => r.insurance && r.provider && r.providerKind)
    .map((r) => ({ insurance: String(r.insurance), providerKind: r.providerKind!, provider: String(r.provider) }));
};

// ------------------------------------------------------- the read model

// DoctorInsurance and the centres' `insurances` arrays mirror the
// effective contracts for the pages that populate them; nothing else
// writes them.
const applyAcceptance = async (kind: ContractProviderKind, provider: Id, insurance: Id, on: boolean) => {
  if (kind === "doctor") {
    if (on)
      await DoctorInsurance.updateOne(
        { doctor: provider, insurance },
        { $setOnInsert: { doctor: provider, insurance } },
        { upsert: true },
      ).catch((err) => {
        if (err?.code !== 11000) throw err;
      });
    else await DoctorInsurance.deleteMany({ doctor: provider, insurance });
    return;
  }
  const Model = providerModelOf(kind);
  const doc = await Model.findById(provider).select("insurances").lean<{ insurances?: unknown[] }>();
  if (!doc) return;
  const list = (Array.isArray(doc.insurances) ? doc.insurances : []).map((i) => String(i));
  const has = list.includes(String(insurance));
  if (on === has) return;
  const next = on ? [...list, String(insurance)] : list.filter((i) => i !== String(insurance));
  // $set (not $addToSet): a lab's «بیمه پایه» is derived on $set.insurances
  await Model.findOneAndUpdate({ _id: provider }, { $set: { insurances: next.map(oid) } });
};

const syncContract = async (c: Pick<IInsuranceContract, "_id" | "providerKind" | "provider" | "insurance" | "status" | "validFrom" | "validUntil" | "endsAt">) => {
  const on = isEffective(c);
  await applyAcceptance(c.providerKind, c.provider, c.insurance, on);
  await InsuranceContract.updateOne({ _id: c._id }, { $set: { applied: on } });
};

// ------------------------------------------------------------- parties

const loadParties = async (c: Pick<IInsuranceContract, "providerKind" | "provider" | "insurance">) => {
  const [provider, insurer] = await Promise.all([
    providerModelOf(c.providerKind)
      .findById(c.provider)
      .select("name firstName lastName user")
      .lean<Lean>(),
    Insurance.findById(c.insurance).select("name user").lean<Lean>(),
  ]);
  return {
    provider,
    insurer,
    providerLabel: providerLabel(c.providerKind, provider),
    insurerName: String(insurer?.name || ""),
    providerUser: provider?.user,
    insurerUser: insurer?.user,
  };
};

type Parties = Awaited<ReturnType<typeof loadParties>>;

const tellProvider = (c: Pick<IInsuranceContract, "providerKind">, p: Parties, run: (user: unknown, link: string) => void) => {
  if (p.providerUser) run(p.providerUser, providerPanelLink[c.providerKind]);
};
const tellInsurer = (p: Parties, run: (user: unknown, link: string) => void) => {
  if (p.insurerUser) run(p.insurerUser, INSURER_PANEL_LINK);
};

const ACTIVE_MESSAGE = "این قرارداد از این پس در نوبت‌دهی و صفحه‌های عمومی نویان به حساب می‌آید.";
const EXPIRED_REASON = "پایان مدت اعتبار قرارداد";

// ------------------------------------------------------------ validity

// "YYYY-MM-DD" (or a date) in Tehran: from its first instant / through
// its last day
export const parseValidity = (from: unknown, until: unknown) => {
  const validFrom = parseTehranDay(from);
  const untilDay = parseTehranDay(until);
  const validUntil = untilDay ? addTehranDays(untilDay, 1) : null;
  if (validFrom && validUntil && +validUntil <= +validFrom)
    throw new AppError("پایان اعتبار قرارداد باید بعد از شروع آن باشد", 400);
  if (validUntil && +validUntil <= Date.now())
    throw new AppError("پایان اعتبار قرارداد نمی‌تواند در گذشته باشد", 400);
  return { validFrom, validUntil };
};

const OPEN_EXISTS = "میان این بیمه و این ارائه‌دهنده قرارداد باز (در انتظار یا فعال) وجود دارد";

const createOpen = async (doc: Record<string, unknown>) => {
  try {
    return await InsuranceContract.create({ ...doc, status: "Pending", open: true });
  } catch (err: any) {
    if (err?.code === 11000) throw new AppError(OPEN_EXISTS, 409);
    throw err;
  }
};

// ---------------------------------------------------------- transitions

// a provider asks an insurer for a contract
export const requestContract = async (input: {
  kind: ContractProviderKind;
  provider: Id;
  insurance: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
  note?: string;
}) => {
  if (!isId(input.insurance)) throw new BadInputError();
  const insurer = await Insurance.findOne({ _id: input.insurance, active: true }).select("_id user").lean<Lean>();
  if (!insurer) throw new NotFoundError("بیمه");
  const { validFrom, validUntil } = parseValidity(input.validFrom, input.validUntil);
  const contract = await createOpen({
    insurance: insurer._id,
    providerKind: input.kind,
    provider: input.provider,
    providerModel: contractProviderModels[input.kind],
    initiatedBy: "provider",
    // an insurer with no panel account cannot answer: the admin does, from
    // the requests queue (Controllers/adminRequestsController.ts)
    reviewer: insurer.user ? "insurer" : "admin",
    validFrom,
    validUntil,
    ...(input.note ? { note: input.note } : {}),
  });
  const p = await loadParties(contract);
  tellInsurer(p, (user, link) =>
    notifyWithSms(
      "insuranceContractRequestInsurer",
      user as any,
      { provider: p.providerLabel },
      {
        notification: {
          title: `درخواست قرارداد از ${p.providerLabel}`,
          message: "برای تأیید یا رد، به صفحه‌ی شبکه‌ی درمانی پنل بیمه بروید.",
          link,
        },
      },
    ),
  );
  return contract;
};

// an insurer invites a provider
export const inviteProvider = async (input: {
  insurance: Id;
  kind: ContractProviderKind;
  provider: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
  note?: string;
}) => {
  if (!isId(input.provider)) throw new BadInputError();
  const provider = await providerModelOf(input.kind)
    .findOne({ _id: input.provider, [providerActiveField[input.kind]]: true })
    .select("_id")
    .lean<Lean>();
  if (!provider) throw new NotFoundError();
  const { validFrom, validUntil } = parseValidity(input.validFrom, input.validUntil);
  const contract = await createOpen({
    insurance: input.insurance,
    providerKind: input.kind,
    provider: provider._id,
    providerModel: contractProviderModels[input.kind],
    initiatedBy: "insurer",
    reviewer: "insurer",
    validFrom,
    validUntil,
    ...(input.note ? { note: input.note } : {}),
  });
  const p = await loadParties(contract);
  tellProvider(contract, p, (user, link) =>
    notifyWithSms(
      "insuranceContractInviteProvider",
      user as any,
      { insurer: p.insurerName },
      {
        notification: {
          title: `دعوت به قرارداد از ${p.insurerName}`,
          message: "برای پذیرفتن یا رد، به صفحه‌ی بیمه‌های پنل خود بروید.",
          link,
        },
      },
    ),
  );
  return contract;
};

// who may answer a pending contract: the side that did not ask (the admin
// answers a provider's request for an insurer with no panel)
const mayDecide = (c: Pick<IInsuranceContract, "initiatedBy" | "reviewer">, side: ContractSide) =>
  c.initiatedBy === "provider"
    ? side === "insurer" || (side === "admin" && c.reviewer === "admin")
    : c.initiatedBy === "insurer"
      ? side === "provider"
      : false;

export const decideContract = async (
  contractId: Id,
  scope: Record<string, unknown>,
  side: ContractSide,
  decision: "approve" | "reject",
  reason?: string,
) => {
  if (!isId(contractId)) throw new NotFoundError();
  const current = await InsuranceContract.findOne({ _id: contractId, ...scope }).lean<IInsuranceContract>();
  if (!current) throw new NotFoundError();
  if (current.status !== "Pending") throw new AppError("فقط قرارداد در انتظار را می‌توان تأیید یا رد کرد", 400);
  if (!mayDecide(current, side)) throw new AppError("پاسخ این درخواست با طرف دیگر قرارداد است", 403);
  if (decision === "reject" && String(reason || "").trim().length < 3)
    throw new AppError("دلیل را بنویسید (دست‌کم ۳ حرف)", 400);
  if (decision === "approve") {
    // an insurer switched off since cannot be accepted
    const live = await Insurance.exists({ _id: current.insurance, active: true });
    if (!live) throw new NotFoundError("بیمه");
  }
  const now = new Date();
  const next = await InsuranceContract.findOneAndUpdate(
    { _id: current._id, status: "Pending" },
    decision === "approve"
      ? { $set: { status: "Active", activatedAt: now, decidedAt: now, decidedBy: side } }
      : {
          $set: { status: "Rejected", decidedAt: now, decidedBy: side, rejectReason: String(reason).trim() },
          $unset: { open: 1 },
        },
    { new: true },
  ).lean<IInsuranceContract>();
  if (!next) throw new AppError("فقط قرارداد در انتظار را می‌توان تأیید یا رد کرد", 400);
  if (decision === "approve") await syncContract(next);
  const p = await loadParties(next);
  // the side that asked is told
  const toProvider = next.initiatedBy === "provider";
  if (decision === "approve") {
    if (toProvider)
      tellProvider(next, p, (user, link) =>
        notifyWithSms("insuranceContractActiveProvider", user as any, { insurer: p.insurerName }, {
          notification: { title: `قرارداد با ${p.insurerName} فعال شد`, message: ACTIVE_MESSAGE, link },
        }),
      );
    else
      tellInsurer(p, (user, link) =>
        notifyWithSms("insuranceContractActiveInsurer", user as any, { provider: p.providerLabel }, {
          notification: { title: `قرارداد با ${p.providerLabel} فعال شد`, message: ACTIVE_MESSAGE, link },
        }),
      );
  } else {
    const why = String(reason).trim();
    if (toProvider)
      tellProvider(next, p, (user, link) =>
        notifyWithSms("insuranceContractRejectedProvider", user as any, { insurer: p.insurerName, reason: why }, {
          notification: { title: `درخواست قرارداد با ${p.insurerName} رد شد`, message: `دلیل: ${why}`, link },
        }),
      );
    else
      tellInsurer(p, (user, link) =>
        notifyWithSms("insuranceContractRejectedInsurer", user as any, { provider: p.providerLabel, reason: why }, {
          notification: { title: `درخواست قرارداد با ${p.providerLabel} رد شد`, message: `دلیل: ${why}`, link },
        }),
      );
  }
  return next;
};

// the side that asked withdraws its pending request / invitation
export const cancelContract = async (contractId: Id, scope: Record<string, unknown>, side: "provider" | "insurer") => {
  if (!isId(contractId)) throw new NotFoundError();
  const next = await InsuranceContract.findOneAndUpdate(
    { _id: contractId, ...scope, status: "Pending", initiatedBy: side },
    { $set: { status: "Cancelled", decidedAt: new Date(), decidedBy: side }, $unset: { open: 1 } },
    { new: true },
  ).lean<IInsuranceContract>();
  if (!next) throw new AppError("فقط درخواستی را که خودتان فرستاده‌اید و هنوز در انتظار است می‌توان پس گرفت", 400);
  return next;
};

const endNotice = async (c: IInsuranceContract, by: ContractSide | "expiry", reason: string, at: Date) => {
  const p = await loadParties(c);
  const scheduled = +at > Date.now();
  // the last day it holds (a scheduled end is the next day's first instant)
  const date = smsDate(scheduled ? new Date(+at - 1) : at);
  const notify = (toProvider: boolean) => {
    const name = toProvider ? p.insurerName : p.providerLabel;
    const notification = {
      title: scheduled ? `قرارداد با ${name} پس از ${date} پایان می‌یابد` : `قرارداد با ${name} پایان یافت`,
      message: `دلیل: ${reason}`,
    };
    if (toProvider)
      tellProvider(c, p, (user, link) =>
        notifyWithSms("insuranceContractEndedProvider", user as any, { insurer: name, reason, date }, {
          notification: { ...notification, link },
        }),
      );
    else
      tellInsurer(p, (user, link) =>
        notifyWithSms("insuranceContractEndedInsurer", user as any, { provider: name, reason, date }, {
          notification: { ...notification, link },
        }),
      );
  };
  // the other side is told; an expiry or the admin tells both
  if (by !== "provider") notify(true);
  if (by !== "insurer") notify(false);
};

// either side ends an active contract, with a reason; a future end date
// keeps it active through that day (one-way: a scheduled end stays)
export const endContract = async (
  contractId: Id,
  scope: Record<string, unknown>,
  side: ContractSide,
  reason: unknown,
  endDate?: unknown,
) => {
  if (!isId(contractId)) throw new NotFoundError();
  const why = String(reason ?? "").trim();
  if (why.length < 3) throw new AppError("دلیل را بنویسید (دست‌کم ۳ حرف)", 400);
  const day = parseTehranDay(endDate);
  const today = startOfTehranDay();
  // through the chosen day; today or no date: now
  const endsAt = day && +day > +today ? addTehranDays(day, 1) : null;
  const current = await InsuranceContract.findOne({ _id: contractId, ...scope }).lean<IInsuranceContract>();
  if (!current) throw new NotFoundError();
  if (current.status !== "Active") throw new AppError("فقط قرارداد فعال را می‌توان پایان داد", 400);
  if (current.endsAt) throw new AppError("پایان این قرارداد از قبل ثبت شده است", 400);
  const now = new Date();
  const next = await InsuranceContract.findOneAndUpdate(
    { _id: current._id, status: "Active", endsAt: null },
    endsAt
      ? { $set: { endsAt, endedBy: side, endReason: why } }
      : { $set: { status: "Ended", endedAt: now, endedBy: side, endReason: why }, $unset: { open: 1 } },
    { new: true },
  ).lean<IInsuranceContract>();
  if (!next) throw new AppError("پایان این قرارداد از قبل ثبت شده است", 400);
  await syncContract(next);
  endNotice(next, side, why, endsAt || now).catch((err) => console.log("[insuranceContract] end notice failed:", err));
  return next;
};

// --------------------------------------------------------------- sweep

// Ends the contracts whose end date or validity passed, and applies the
// ones whose validity began. Runs every few minutes and at boot.
export const runContractSweep = async () => {
  const now = new Date();
  const due = await InsuranceContract.find({
    status: "Active",
    $or: [{ endsAt: { $ne: null, $lte: now } }, { validUntil: { $ne: null, $lte: now } }],
  }).lean<IInsuranceContract[]>();
  for (const c of due) {
    const expired = !c.endsAt;
    const at = c.endsAt && (!c.validUntil || +c.endsAt <= +c.validUntil) ? c.endsAt : c.validUntil || now;
    const next = await InsuranceContract.findOneAndUpdate(
      { _id: c._id, status: "Active" },
      {
        $set: {
          status: "Ended",
          endedAt: at,
          ...(expired ? { endedBy: "expiry", endReason: EXPIRED_REASON } : {}),
        },
        $unset: { open: 1 },
      },
      { new: true },
    ).lean<IInsuranceContract>();
    if (!next) continue;
    await syncContract(next);
    // a scheduled end was announced when it was set; an expiry is news
    if (expired) await endNotice(next, "expiry", EXPIRED_REASON, at).catch(() => undefined);
  }
  const starting = await InsuranceContract.find({ applied: { $ne: true }, ...effectiveContractFilter(now) }).lean<IInsuranceContract[]>();
  for (const c of starting) await syncContract(c);
};

export const startInsuranceContractJob = (intervalMs = 5 * 60_000) => {
  const run = () => runContractSweep().catch((err) => console.log("[insuranceContract] sweep failed:", err));
  run();
  setInterval(run, intervalMs).unref?.();
};

// ----------------------------------------------------------- migration

// On deploy (2026-10), every acceptance on the old one-sided lists becomes
// an Active contract, so nothing a patient sees changes. Idempotent: a pair
// that has any contract already (active, ended, rejected...) is left alone.
// Then the read model is made to match the contracts exactly: an entry
// whose contract ended is taken off, an effective contract missing from it
// is put back.
export const migrateInsuranceContracts = async () => {
  const pairs: { kind: ContractProviderKind; provider: unknown; insurance: unknown; at?: Date }[] = [];
  const own = await DoctorInsurance.find({}).select("doctor insurance").lean<{ _id: mongoose.Types.ObjectId; doctor?: unknown; insurance?: unknown }[]>();
  for (const r of own) if (isId(r.doctor) && isId(r.insurance)) pairs.push({ kind: "doctor", provider: r.doctor, insurance: r.insurance, at: r._id.getTimestamp() });
  for (const kind of ["clinic", "hospital", "paraClinic", "pharmacy"] as const) {
    const rows = await providerModelOf(kind)
      .find({ "insurances.0": { $exists: true } })
      .select("insurances")
      .lean<{ _id: unknown; insurances?: unknown[] }[]>();
    for (const r of rows)
      for (const i of Array.isArray(r.insurances) ? r.insurances : [])
        if (isId(i)) pairs.push({ kind, provider: r._id, insurance: i });
  }
  const insurers = new Set(
    (await Insurance.find({ _id: { $in: [...new Set(pairs.map((p) => String(p.insurance)))] } }).select("_id").lean<{ _id: unknown }[]>()).map((i) => String(i._id)),
  );
  let created = 0;
  for (const p of pairs) {
    // an id pointing at a deleted insurer is not a contract
    if (!insurers.has(String(p.insurance))) continue;
    const res = await InsuranceContract.updateOne(
      { insurance: oid(p.insurance), providerKind: p.kind, provider: oid(p.provider) },
      {
        $setOnInsert: {
          insurance: oid(p.insurance),
          providerKind: p.kind,
          provider: oid(p.provider),
          providerModel: contractProviderModels[p.kind],
          status: "Active",
          open: true,
          initiatedBy: "provider",
          reviewer: "insurer",
          source: "migration",
          decidedBy: "admin",
          activatedAt: p.at || new Date(),
          applied: true,
          validFrom: null,
          validUntil: null,
          endsAt: null,
        },
      },
      { upsert: true },
    ).catch((err) => {
      if (err?.code !== 11000) throw err;
      return null;
    });
    if (res?.upsertedCount) created += 1;
  }
  if (created) console.log(`[insuranceContract] ${created} accepted insurers became active contracts`);
  await reconcileAcceptance();
};

// the read model = the effective contracts, exactly
export const reconcileAcceptance = async () => {
  const effective = await effectiveContracts({});
  const want = new Set(effective.map((r) => `${r.providerKind}:${r.provider}:${r.insurance}`));
  let removed = 0;
  let added = 0;
  const own = await DoctorInsurance.find({}).select("doctor insurance").lean<{ doctor?: unknown; insurance?: unknown }[]>();
  const have = new Set<string>();
  for (const r of own) {
    const key = `doctor:${String(r.doctor)}:${String(r.insurance)}`;
    have.add(key);
    if (!want.has(key)) {
      await applyAcceptance("doctor", String(r.doctor), String(r.insurance), false);
      removed += 1;
    }
  }
  for (const kind of ["clinic", "hospital", "paraClinic", "pharmacy"] as const) {
    const rows = await providerModelOf(kind)
      .find({ "insurances.0": { $exists: true } })
      .select("insurances")
      .lean<{ _id: unknown; insurances?: unknown[] }[]>();
    for (const r of rows)
      for (const i of Array.isArray(r.insurances) ? r.insurances : []) {
        const key = `${kind}:${String(r._id)}:${String(i)}`;
        have.add(key);
        if (!want.has(key)) {
          await applyAcceptance(kind, String(r._id), String(i), false);
          removed += 1;
        }
      }
  }
  for (const r of effective) {
    if (have.has(`${r.providerKind}:${r.provider}:${r.insurance}`)) continue;
    await applyAcceptance(r.providerKind, r.provider, r.insurance, true);
    added += 1;
  }
  await InsuranceContract.updateMany({ status: { $ne: "Active" }, applied: true }, { $set: { applied: false } });
  if (removed || added) console.log(`[insuranceContract] read model reconciled: +${added} -${removed}`);
};

// ------------------------------------------------------------- helpers

// a doctor / centre is deleted: its contracts go with it
export const dropProviderContracts = async (kind: ContractProviderKind, provider: Id) => {
  await InsuranceContract.deleteMany({ providerKind: kind, provider });
};

// an insurer gets a panel account (become-insurer approval linked it): the
// providers' requests waiting on the admin now wait on the insurer
export const handContractsToInsurer = async (insurance: Id) => {
  await InsuranceContract.updateMany(
    { insurance, status: "Pending", initiatedBy: "provider", reviewer: "admin" },
    { $set: { reviewer: "insurer" } },
  );
};

// an addition request approved by the admin (the doctor proposed this
// insurer): an active contract the admin made
export const adminActivateContract = async (kind: ContractProviderKind, provider: Id, insurance: Id) => {
  const existing = await InsuranceContract.findOne({ insurance, providerKind: kind, provider, open: true }).lean<IInsuranceContract>();
  if (existing?.status === "Active") return existing;
  const now = new Date();
  const next = existing
    ? await InsuranceContract.findOneAndUpdate(
        { _id: existing._id, status: "Pending" },
        { $set: { status: "Active", activatedAt: now, decidedAt: now, decidedBy: "admin" } },
        { new: true },
      ).lean<IInsuranceContract>()
    : (
        await InsuranceContract.create({
          insurance,
          providerKind: kind,
          provider,
          providerModel: contractProviderModels[kind],
          status: "Active",
          open: true,
          initiatedBy: "provider",
          reviewer: "admin",
          source: "addition",
          decidedAt: now,
          decidedBy: "admin",
          activatedAt: now,
        })
      ).toObject();
  if (next) await syncContract(next as IInsuranceContract);
  return next;
};
