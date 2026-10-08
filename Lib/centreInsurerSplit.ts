import mongoose, { Model } from "mongoose";
import ClinicDoctor from "../Models/ClinicDoctor";
import HospitalDoctor from "../Models/HospitalDoctor";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import DoctorProfile from "../Models/DoctorProfile";
import Notification from "../Models/Notification";
import Reservation from "../Models/Reservation";
import { DEFAULT_DOCTOR_PERCENT, ICentreInsurerSplit } from "../Models/CentreInsurerSplit";
import AppError, { NotFoundError } from "./AppError";
import { BizOwner } from "./business/coa";

// The doctor's share of what insurers pay a clinic or hospital for the
// doctor's visits at its office (2026-10, Models/CentreInsurerSplit.ts).
// One-way moves, each guarded by the state it starts from:
//   the centre proposes a percentage   (agreed stays until answered)
//   the centre withdraws its proposal
//   the doctor accepts the percentage they were shown → it is agreed, for
//     visits booked from then on (the reservation snapshots it)
//   the doctor declines it             → the agreed one stays
// Like Doctolib's and Docplanner's practice groups, where the practice and
// the practitioner agree the fee split once and the software applies it,
// rather than the practice editing the doctor's income by itself.

export type CentreKind = "clinic" | "hospital";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const memberModel: Record<CentreKind, Model<any>> = { clinic: ClinicDoctor, hospital: HospitalDoctor };
const TITLE: Record<CentreKind, string> = { clinic: "کلینیک", hospital: "بیمارستان" };
const PANEL: Record<CentreKind, string> = { clinic: "/clinicpanel", hospital: "/hospitalpanel" };

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");
const oid = (v: unknown) => new mongoose.Types.ObjectId(idOf(v));

const clamp = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : DEFAULT_DOCTOR_PERCENT;
};

// the percentage in force on a membership (none = 100%)
export const agreedPercent = (split?: Partial<ICentreInsurerSplit> | null) =>
  split && split.doctorPercent != null ? clamp(split.doctorPercent) : DEFAULT_DOCTOR_PERCENT;

// the percentage in force for this doctor at this centre now - what a
// booking snapshots on its centre lines (no membership: 100%, the doctor's
// office no longer counts as the centre's anyway, Lib/centreMembership.ts)
export const doctorPercentFor = async (kind: CentreKind, centre: unknown, doctor: unknown) => {
  if (!mongoose.isValidObjectId(idOf(centre)) || !mongoose.isValidObjectId(idOf(doctor))) return DEFAULT_DOCTOR_PERCENT;
  const m = await memberModel[kind]
    .findOne({ [kind]: oid(centre), doctor: oid(doctor) })
    .select("insurerSplit")
    .lean<{ insurerSplit?: ICentreInsurerSplit }>();
  return agreedPercent(m?.insurerSplit);
};

// what the centre owes the doctor of one insurer line
export const doctorShareOf = (share: number, percent?: number | null) =>
  Math.max(0, Math.round(((Number(share) || 0) * (percent == null ? DEFAULT_DOCTOR_PERCENT : clamp(percent))) / 100));

const parsePercent = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new AppError("سهم پزشک باید عددی صحیح از ۰ تا ۱۰۰ باشد", 400);
  return n;
};

const doctorUser = async (doctor: unknown) =>
  (await DoctorProfile.findById(doctor).select("user firstName lastName").lean<{ user?: unknown; firstName?: string; lastName?: string }>()) || null;

const centreUser = async (kind: CentreKind, centre: unknown) => {
  const model = (kind === "clinic" ? Clinic : Hospital) as unknown as Model<{ user?: unknown; name?: string }>;
  return (await model.findById(centre).select("user name").lean<{ user?: unknown; name?: string }>()) || null;
};

const notify = (user: unknown, title: string, message: string, link: string) =>
  user
    ? Notification.create({ user, source: "System", title, message, link }).catch(() => undefined)
    : Promise.resolve(undefined);

const fill = (s: string, ...v: (string | number)[]) => v.reduce<string>((t, x, i) => t.split(`\${${i + 1}}`).join(String(x)), s);

// POST/PATCH by the centre: propose the doctor's percentage. The same as the
// agreed one clears an open proposal (nothing to ask).
export const proposeSplit = async (
  kind: CentreKind,
  centre: { _id: unknown; name?: string },
  memberId: string,
  value: unknown,
  by?: unknown,
) => {
  const percent = parsePercent(value);
  const model = memberModel[kind];
  const m = await model.findOne({ _id: memberId, [kind]: centre._id }).select("doctor insurerSplit").lean<{ doctor: unknown; insurerSplit?: ICentreInsurerSplit }>();
  if (!m) throw new NotFoundError();
  const agreed = agreedPercent(m.insurerSplit);
  if (percent === agreed) {
    await model.updateOne({ _id: memberId }, { $unset: { "insurerSplit.proposal": 1 } });
    return model.findById(memberId).select("insurerSplit").lean();
  }
  if (m.insurerSplit?.proposal?.doctorPercent === percent) return model.findById(memberId).select("insurerSplit").lean();
  await model.updateOne(
    { _id: memberId },
    m.insurerSplit
      ? { $set: { "insurerSplit.proposal": { doctorPercent: percent, at: new Date(), by } }, $unset: { "insurerSplit.declined": 1 } }
      : { $set: { insurerSplit: { doctorPercent: agreed, proposal: { doctorPercent: percent, at: new Date(), by } } } },
  );
  const doc = await doctorUser(m.doctor);
  const name = centre.name ? `${TITLE[kind]} ${centre.name}` : TITLE[kind];
  await notify(
    doc?.user,
    fill("پیشنهاد تازه‌ی سهم بیمه از ${1}", name),
    fill(
      "${1} پیشنهاد کرده سهم شما از پرداخت بیمه‌ها برای ویزیت‌هایتان در این مرکز ${2}٪ باشد. تا وقتی نپذیرید، سهم فعلی ${3}٪ برقرار است.",
      name,
      percent,
      agreed,
    ),
    `/doctorpanel/${kind}`,
  );
  return model.findById(memberId).select("insurerSplit").lean();
};

// DELETE by the centre: its proposal not answered yet is taken back
export const withdrawSplitProposal = async (kind: CentreKind, centre: { _id: unknown }, memberId: string) => {
  const model = memberModel[kind];
  const res = await model.updateOne(
    { _id: memberId, [kind]: centre._id, "insurerSplit.proposal": { $exists: true } },
    { $unset: { "insurerSplit.proposal": 1 } },
  );
  if (!res.matchedCount && !(await model.exists({ _id: memberId, [kind]: centre._id }))) throw new NotFoundError();
  return model.findById(memberId).select("insurerSplit").lean();
};

// POST by the doctor: accept or decline the percentage they were shown. A
// proposal changed meanwhile is not accepted in its place.
export const answerSplitProposal = async (
  kind: CentreKind,
  doctor: unknown,
  memberId: string,
  accept: boolean,
  shown: unknown,
) => {
  const percent = parsePercent(shown);
  const model = memberModel[kind];
  const m = await model.findOne({ _id: memberId, doctor }).select(`${kind} insurerSplit`).lean<Record<string, unknown> & { insurerSplit?: ICentreInsurerSplit }>();
  if (!m) throw new NotFoundError();
  const proposal = m.insurerSplit?.proposal;
  if (!proposal) throw new AppError("پیشنهادی برای سهم بیمه در انتظار پاسخ شما نیست", 400);
  if (proposal.doctorPercent !== percent) throw new AppError("پیشنهاد سهم بیمه تغییر کرده است؛ صفحه را دوباره باز کنید", 409);
  const before = agreedPercent(m.insurerSplit);
  const now = new Date();
  const guard = { _id: memberId, doctor, "insurerSplit.proposal.doctorPercent": percent, "insurerSplit.proposal.at": proposal.at };
  // the first change keeps the percentage agreed before it, when there was one
  const history = !m.insurerSplit?.history?.length && m.insurerSplit?.agreedAt ? [{ doctorPercent: before, from: m.insurerSplit.agreedAt }] : [];
  const res = await model.updateOne(
    guard,
    accept
      ? {
          $set: { "insurerSplit.doctorPercent": percent, "insurerSplit.agreedAt": now },
          $unset: { "insurerSplit.proposal": 1, "insurerSplit.declined": 1 },
          $push: { "insurerSplit.history": { $each: [...history, { doctorPercent: percent, from: now }], $slice: -50 } },
        }
      : { $set: { "insurerSplit.declined": { doctorPercent: percent, at: now } }, $unset: { "insurerSplit.proposal": 1 } },
  );
  if (!res.modifiedCount) throw new AppError("پیشنهاد سهم بیمه تغییر کرده است؛ صفحه را دوباره باز کنید", 409);
  const [doc, centre] = await Promise.all([doctorUser(doctor), centreUser(kind, m[kind])]);
  const doctorName = `${doc?.firstName || ""} ${doc?.lastName || ""}`.trim() || "—";
  await notify(
    centre?.user,
    accept ? "سهم بیمه‌ی پزشک پذیرفته شد" : "پزشک سهم بیمه‌ی پیشنهادی را نپذیرفت",
    accept
      ? fill("${1} سهم ${2}٪ از پرداخت بیمه‌ها را پذیرفت؛ برای نوبت‌های تازه اعمال می‌شود.", doctorName, percent)
      : fill("${1} سهم ${2}٪ را نپذیرفت؛ همان ${3}٪ قبلی برقرار است.", doctorName, percent, before),
    `${PANEL[kind]}/doctor`,
  );
  return model.findById(memberId).select("insurerSplit").lean();
};

// ----------------------------------------------------------- the finance

// doctor: the doctor's share as booked; deducted: its part of the insurers'
// deductions (کسورات, Lib/business/doctorShareDeductions.ts) - the doctor
// is owed doctor - deducted
type SumRow = { insurer: number; doctor: number; deducted: number; count: number };
const zero = (): SumRow => ({ insurer: 0, doctor: 0, deducted: 0, count: 0 });

export type SplitSummaryRow = {
  // the other side: a centre (for a doctor) or a doctor (for a centre)
  kind: "clinic" | "hospital" | "doctor";
  id: string;
  name: string;
  member: boolean;
  memberId?: string;
  doctorPercent: number;
  proposal?: { doctorPercent: number; at: Date } | null;
  // insurer lines booked (the visit took place): what the insurers owe the
  // centre, and the doctor's part of it - the payable / receivable
  booked: SumRow;
  // lines of visits not held yet (paid online): an estimate at the
  // percentage snapshotted on each
  upcoming: SumRow;
};

// «سهم پزشک از بیمه»: for a doctor, what each centre owes them of the
// insurers' payments (and its percentage); for a centre, what it owes each
// doctor. Read from the reservations' centre lines, the same figures both
// books were posted with.
export const centreSplitSummary = async (owner: BizOwner) => {
  if (owner.kind !== "doctor" && owner.kind !== "clinic" && owner.kind !== "hospital") return { rows: [], totals: { booked: zero(), upcoming: zero() } };
  if (!mongoose.isValidObjectId(String(owner.id))) return { rows: [], totals: { booked: zero(), upcoming: zero() } };
  const me = oid(owner.id);
  const asDoctor = owner.kind === "doctor";
  const lineMatch: Record<string, unknown> = {
    "insuranceQuote.lines.holder": "centre",
    "insuranceQuote.lines.share": { $gt: 0 },
    "insuranceQuote.lines.status": { $in: ["booked", "pending"] },
    ...(asDoctor ? {} : { "insuranceQuote.lines.centre": me, "insuranceQuote.lines.centreKind": owner.kind }),
  };
  const sums = await Reservation.aggregate<{ _id: { kind?: string; id: unknown; status: string }; name?: string; insurer: number; doctor: number; deducted: number; count: number }>([
    { $match: asDoctor ? { doctor: me, "insuranceQuote.lines.holder": "centre" } : { "insuranceQuote.lines": { $elemMatch: { centre: me, centreKind: owner.kind } } } },
    { $unwind: "$insuranceQuote.lines" },
    { $match: lineMatch },
    {
      $project: {
        kind: asDoctor ? "$insuranceQuote.lines.centreKind" : "doctor",
        id: asDoctor ? "$insuranceQuote.lines.centre" : "$doctor",
        name: "$insuranceQuote.lines.centreName",
        status: "$insuranceQuote.lines.status",
        share: "$insuranceQuote.lines.share",
        doctorShare: {
          $ifNull: [
            "$insuranceQuote.lines.doctorShare",
            { $floor: { $add: [{ $divide: [{ $multiply: ["$insuranceQuote.lines.share", { $ifNull: ["$insuranceQuote.lines.doctorPercent", DEFAULT_DOCTOR_PERCENT] }] }, 100] }, 0.5] } },
          ],
        },
        deducted: { $ifNull: ["$insuranceQuote.lines.doctorDeducted", 0] },
      },
    },
    { $group: { _id: { kind: "$kind", id: "$id", status: "$status" }, name: { $last: "$name" }, insurer: { $sum: "$share" }, doctor: { $sum: "$doctorShare" }, deducted: { $sum: "$deducted" }, count: { $sum: 1 } } },
  ]);

  const rows = new Map<string, SplitSummaryRow>();
  const keyOf = (kind: string, id: unknown) => `${kind}:${idOf(id)}`;
  const put = (r: Omit<SplitSummaryRow, "booked" | "upcoming">) => {
    const k = keyOf(r.kind, r.id);
    if (!rows.has(k)) rows.set(k, { ...r, booked: zero(), upcoming: zero() });
    return rows.get(k)!;
  };

  if (asDoctor) {
    const [clinics, hospitals] = await Promise.all([
      ClinicDoctor.find({ doctor: me }).populate({ path: "clinic", select: "name" }).select("clinic insurerSplit").lean(),
      HospitalDoctor.find({ doctor: me }).populate({ path: "hospital", select: "name" }).select("hospital insurerSplit").lean(),
    ]);
    for (const [kind, list] of [["clinic", clinics], ["hospital", hospitals]] as const)
      for (const m of list as unknown as (Record<string, { _id: unknown; name?: string } | undefined> & { _id: unknown; insurerSplit?: ICentreInsurerSplit })[]) {
        const c = m[kind];
        if (!c?._id) continue;
        put({
          kind,
          id: idOf(c._id),
          name: c.name || "—",
          member: true,
          memberId: idOf(m._id),
          doctorPercent: agreedPercent(m.insurerSplit),
          proposal: m.insurerSplit?.proposal ? { doctorPercent: m.insurerSplit.proposal.doctorPercent, at: m.insurerSplit.proposal.at } : null,
        });
      }
  } else {
    const kind = owner.kind as CentreKind;
    const members = await memberModel[kind]
      .find({ [kind]: me })
      .populate({ path: "doctor", select: "firstName lastName" })
      .select("doctor insurerSplit")
      .lean<{ _id: unknown; doctor?: { _id: unknown; firstName?: string; lastName?: string }; insurerSplit?: ICentreInsurerSplit }[]>();
    for (const m of members) {
      if (!m.doctor?._id) continue;
      put({
        kind: "doctor",
        id: idOf(m.doctor._id),
        name: `${m.doctor.firstName || ""} ${m.doctor.lastName || ""}`.trim() || "—",
        member: true,
        memberId: idOf(m._id),
        doctorPercent: agreedPercent(m.insurerSplit),
        proposal: m.insurerSplit?.proposal ? { doctorPercent: m.insurerSplit.proposal.doctorPercent, at: m.insurerSplit.proposal.at } : null,
      });
    }
  }

  // a former member (or a centre the doctor left) still owes / is owed
  const missing = sums.filter((s) => s._id.id && !rows.has(keyOf(String(s._id.kind || ""), s._id.id)));
  const missingDoctors = asDoctor
    ? new Map<string, string>()
    : new Map(
        (
          await DoctorProfile.find({ _id: { $in: [...new Set(missing.map((s) => idOf(s._id.id)))] } })
            .select("firstName lastName")
            .lean<{ _id: unknown; firstName?: string; lastName?: string }[]>()
        ).map((d) => [idOf(d._id), `${d.firstName || ""} ${d.lastName || ""}`.trim()]),
      );
  for (const s of sums) {
    if (!s._id.id || (s._id.kind !== "clinic" && s._id.kind !== "hospital" && s._id.kind !== "doctor")) continue;
    const k = keyOf(s._id.kind, s._id.id);
    const row =
      rows.get(k) ||
      put({
        kind: s._id.kind,
        id: idOf(s._id.id),
        name: (asDoctor ? s.name : missingDoctors.get(idOf(s._id.id))) || "—",
        member: false,
        doctorPercent: DEFAULT_DOCTOR_PERCENT,
        proposal: null,
      });
    const slot = s._id.status === "booked" ? row.booked : row.upcoming;
    slot.insurer += s.insurer || 0;
    slot.doctor += s.doctor || 0;
    slot.deducted += s.deducted || 0;
    slot.count += s.count || 0;
  }
  const list = [...rows.values()].sort((a, b) => b.booked.doctor - a.booked.doctor || a.name.localeCompare(b.name));
  const total = (pick: (r: SplitSummaryRow) => SumRow) =>
    list.reduce(
      (t, r) => ({
        insurer: t.insurer + pick(r).insurer,
        doctor: t.doctor + pick(r).doctor,
        deducted: t.deducted + pick(r).deducted,
        count: t.count + pick(r).count,
      }),
      zero(),
    );
  return { rows: list, totals: { booked: total((r) => r.booked), upcoming: total((r) => r.upcoming) } };
};
