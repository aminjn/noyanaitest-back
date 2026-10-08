import Reservation, { IReservation, IReservationInsurerLine } from "../../Models/Reservation";
import { IBizClaim } from "../../Models/BizClaim";
import { DEFAULT_DOCTOR_PERCENT } from "../../Models/CentreInsurerSplit";
import { BizOwner } from "./coa";
import { postDoc, reverseRef } from "./finance";
import { doctorShareOf } from "../centreInsurerSplit";

// Insurer deductions (کسورات) split pro-rata with the doctor (2026-10, owner
// decision, the common practice of Iranian clinics and hospitals): the
// doctor's share of a centre's insurer line (Lib/centreInsurerSplit.ts) is
// computed on what the insurer actually pays. When the insurer deducts from
// a claim line, the doctor's payable drops by doctorPercent × deduction
// (never below zero), posted once in both books when the deduction is
// recorded (Lib/business/claims.ts deductClaim - the insurer's review on
// Noyan, line by line, or the centre's own entry for an insurer outside
// Noyan, spread over the list's lines by their share):
//
//   centre   Dr 3305 doctors' share payable (the doctor)   Cr 7105 doctors' share
//   doctor   Dr visit income                               Cr 1411 receivable (the centre)
//
// The centre bears the rest, (100 - doctorPercent)% of it, through the
// deduction itself (Dr 7211 / Cr 1412). A line the doctor holds (no centre,
// no split) is untouched: the doctor's own list carries the whole deduction
// in their books, as before. A 100% line passes the whole deduction to the
// doctor - the same as if the doctor held it.
//
// Exactly once: each line's part is claimed on the reservation line
// (doctorDeductions[].ref, guarded by the running total doctorDeducted) and
// its vouchers have unique refs; reopening the list reverses them
// (undoClaimDoctorDeductions).

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

const personName = (p: unknown) => {
  const o = (p || {}) as { givenName?: string; lastName?: string; firstName?: string };
  return `${o.givenName || o.firstName || ""} ${o.lastName || ""}`.trim();
};

export type ItemDeduction = { index: number; deducted: number };

export type PostedDoctorDeduction = {
  reservation: string;
  line: number;
  ref: string;
  amount: number;
  doctor: string;
};

// the doctor's part of a deduction of `deducted` on a line, capped by what
// is still owed to them on it
export const doctorPartOf = (l: Pick<IReservationInsurerLine, "share" | "doctorPercent" | "doctorShare" | "doctorDeducted">, deducted: number) => {
  const pct = l.doctorPercent == null ? DEFAULT_DOCTOR_PERCENT : l.doctorPercent;
  const owed = (l.doctorShare ?? doctorShareOf(l.share, pct)) - (l.doctorDeducted || 0);
  return Math.max(0, Math.min(owed, Math.round(((Number(deducted) || 0) * pct) / 100)));
};

// A deduction of `amount` on the whole list (the centre's own entry) spread
// over its lines by their share; the last line takes the rounding.
export const proRataDeductions = (claim: Pick<IBizClaim, "items" | "claimed">, amount: number): ItemDeduction[] => {
  const total = (claim.items || []).reduce((s, i) => s + (i.share || 0), 0) || claim.claimed || 0;
  if (!(amount > 0) || !(total > 0)) return [];
  const out: ItemDeduction[] = [];
  let left = Math.round(amount);
  claim.items.forEach((item, index) => {
    if (!(item.share > 0)) return;
    out.push({ index, deducted: Math.min(item.share, Math.round((amount * item.share) / total)) });
  });
  const sum = out.reduce((s, d) => s + d.deducted, 0);
  left -= sum;
  // the rounding difference goes on the largest line that can take it
  if (left && out.length) {
    const target = [...out].sort((a, b) => claim.items[b.index].share - claim.items[a.index].share)[0];
    target.deducted = Math.max(0, Math.min(claim.items[target.index].share, target.deducted + left));
  }
  return out;
};

const undoOne = async (centre: BizOwner, p: PostedDoctorDeduction, why: string) => {
  await reverseRef(centre, p.ref, why).catch(() => undefined);
  await reverseRef({ kind: "doctor", id: p.doctor }, p.ref, why).catch(() => undefined);
  await Reservation.updateOne(
    { _id: p.reservation, [`insuranceQuote.lines.${p.line}.doctorDeductions.ref`]: p.ref },
    {
      $pull: { [`insuranceQuote.lines.${p.line}.doctorDeductions`]: { ref: p.ref } },
      $inc: { [`insuranceQuote.lines.${p.line}.doctorDeducted`]: -p.amount },
    },
  ).catch(() => undefined);
};

// Passes the doctors' part of `deductions` (claim item index -> amount
// deducted) of a centre's list to their books. `refBase` is unique to this
// deduction. All or nothing: a failure undoes what it posted and throws.
export const passDeductionsToDoctors = async (
  centre: BizOwner,
  claim: Pick<IBizClaim, "_id" | "items" | "number" | "insurer">,
  deductions: ItemDeduction[],
  refBase: string,
  date: Date,
  by?: unknown,
): Promise<PostedDoctorDeduction[]> => {
  if (centre.kind !== "clinic" && centre.kind !== "hospital") return [];
  const posted: PostedDoctorDeduction[] = [];
  try {
    for (const d of deductions) {
      const item = claim.items[d.index];
      if (!item?.reservation || typeof item.line !== "number" || !(d.deducted > 0)) continue;
      const r = await Reservation.findById(item.reservation)
        .select("doctor patient sessionType insuranceQuote")
        .populate([
          { path: "patient", select: "givenName lastName" },
          { path: "doctor", select: "firstName lastName" },
        ])
        .lean<IReservation>();
      const l = r?.insuranceQuote?.lines?.[item.line];
      if (!r || !l || l.holder !== "centre" || l.centreKind !== centre.kind || idOf(l.centre) !== String(centre.id)) continue;
      if (l.status !== "booked") continue;
      const amount = doctorPartOf(l, d.deducted);
      if (!(amount > 0)) continue;
      const ref = `${refBase}:${idOf(r._id)}:${item.line}`;
      const doctorId = idOf(r.doctor);
      const already = l.doctorDeducted || 0;
      // claim it on the line: once per ref, and only on the total read
      // above (a concurrent deduction of the same line retries cleanly)
      const claimed = await Reservation.updateOne(
        {
          _id: r._id,
          [`insuranceQuote.lines.${item.line}.doctorDeductions.ref`]: { $ne: ref },
          [`insuranceQuote.lines.${item.line}.doctorDeducted`]: already > 0 ? already : { $in: [null, 0] },
        },
        {
          $push: {
            [`insuranceQuote.lines.${item.line}.doctorDeductions`]: { ref, claim: claim._id, amount, at: date },
          },
          $inc: { [`insuranceQuote.lines.${item.line}.doctorDeducted`]: amount },
        },
      );
      if (!claimed.modifiedCount) throw new Error(`doctor deduction of ${idOf(r._id)}:${item.line} changed meanwhile`);
      const entry: PostedDoctorDeduction = { reservation: idOf(r._id), line: item.line, ref, amount, doctor: doctorId };
      posted.push(entry);
      const doctorName = personName(r.doctor) || "—";
      const centreName = l.centreName || "—";
      const pct = l.doctorPercent == null ? DEFAULT_DOCTOR_PERCENT : l.doctorPercent;
      const label = `${l.name} · ${personName(r.patient) || "—"} · #${claim.number} · ${pct}%`.slice(0, 300);
      await postDoc(centre, {
        ref,
        date,
        description: "کسر سهم پزشک بابت کسورات بیمه",
        lines: [
          { role: "doctorsSharePayable", debit: amount, credit: 0, label: `${doctorName} · ${label}`.slice(0, 300), party: { kind: "doctor", name: doctorName } },
          { role: "doctorsShareExpense", debit: 0, credit: amount, label: `${doctorName} · ${label}`.slice(0, 300) },
        ],
        source: { type: "claim", id: claim._id },
        createdBy: by,
      });
      await postDoc({ kind: "doctor", id: doctorId }, {
        ref,
        date,
        description: "کسر سهم بیمه‌ی ویزیت بابت کسورات بیمه",
        lines: [
          { role: r.sessionType === "inPerson" ? "visitIncome" : "onlineVisitIncome", debit: amount, credit: 0, label },
          { role: "receivable", debit: 0, credit: amount, label: `${centreName} · ${label}`.slice(0, 300), party: { kind: "custom", name: centreName } },
        ],
        source: { type: "reservation", id: r._id },
        party: { kind: "custom", name: centreName },
      });
    }
  } catch (err) {
    for (const p of posted) await undoOne(centre, p, "برگشت کسر سهم پزشک");
    throw err;
  }
  return posted;
};

// Undo of a set of posted doctor deductions (the deduction after them failed).
export const undoDoctorDeductions = async (centre: BizOwner, posted: PostedDoctorDeduction[]) => {
  for (const p of posted) await undoOne(centre, p, "برگشت کسر سهم پزشک");
};

// Reopening a list (Lib/business/claims.ts reopenClaim): every doctor's part
// of its deductions is reversed in both books and taken off the lines.
export const undoClaimDoctorDeductions = async (centre: BizOwner, claimId: unknown) => {
  if (centre.kind !== "clinic" && centre.kind !== "hospital") return 0;
  const rows = await Reservation.find({ "insuranceQuote.lines.doctorDeductions.claim": claimId })
    .select("doctor insuranceQuote.lines")
    .lean<IReservation[]>();
  let undone = 0;
  for (const r of rows)
    for (const [i, l] of (r.insuranceQuote?.lines || []).entries())
      for (const d of l.doctorDeductions || [])
        if (String(d.claim) === String(claimId)) {
          await undoOne(centre, { reservation: idOf(r._id), line: i, ref: d.ref, amount: d.amount, doctor: idOf(r.doctor) }, "بازگشایی لیست بیمه");
          undone += d.amount;
        }
  return undone;
};
