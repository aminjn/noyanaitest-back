import Reservation, { IReservation, IReservationInsurerLine } from "../../Models/Reservation";
import { BizOwner } from "./coa";
import { postDoc, reverseRef } from "./finance";

// The insurers' share of a visit paid online (2026-10, Lib/insuranceTariffs.ts):
// the patient paid only their part, so what the insurers owe is the
// doctor's receivable. It is booked when the visit takes place, the way a
// practice books a visit it will claim (docs/business-suite.md section 5):
//
//   visit done      Dr 1412 insurers (the insurer's تفصیلی)   Cr visit income
//   visit refunded  the same voucher reversed (while not on a sent list)
//
// and each line then waits for the doctor's list to that insurer
// (Lib/business/claims.ts claimCandidates: «res:<reservation>:<line>»).

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

export const insurerLineRef = (reservationId: unknown, index: number) => `resins:${idOf(reservationId)}:${index}`;

const personName = (p: unknown) => {
  const o = (p || {}) as { givenName?: string; lastName?: string };
  return `${o.givenName || ""} ${o.lastName || ""}`.trim();
};

// the insurers' share the patient did not pay online at booking (whatever
// became of the lines since: the wallet only ever held the patient's part)
export const onlineInsurerShare = (r: Pick<IReservation, "insuranceQuote" | "payAtDesk">) =>
  r.payAtDesk ? 0 : Math.max(0, Number(r.insuranceQuote?.insurerShare) || 0);

// Books every pending insurer line of a done visit in the doctor's books
// (idempotent: each line is claimed once, its voucher ref is unique).
export const bookInsurerReceivables = async (reservation: IReservation) => {
  const lines = reservation.insuranceQuote?.lines || [];
  if (reservation.payAtDesk || !lines.some((l) => l.status === "pending" && l.share > 0)) return;
  const fresh = await Reservation.findById(reservation._id)
    .select("doctor patient sessionType insuranceQuote payAtDesk")
    .populate({ path: "patient", select: "givenName lastName nationalId" })
    .lean<IReservation>();
  if (!fresh?.insuranceQuote) return;
  const owner: BizOwner = { kind: "doctor", id: idOf(fresh.doctor) };
  const patient = personName(fresh.patient);
  const income = fresh.sessionType === "inPerson" ? "visitIncome" : "onlineVisitIncome";
  for (const [i, l] of fresh.insuranceQuote.lines.entries()) {
    if (l.status !== "pending" || !(l.share > 0)) continue;
    const claimed = await Reservation.updateOne(
      { _id: fresh._id, [`insuranceQuote.lines.${i}.status`]: "pending" },
      { $set: { [`insuranceQuote.lines.${i}.status`]: "booked", [`insuranceQuote.lines.${i}.bookedAt`]: new Date() } },
    );
    if (!claimed.modifiedCount) continue;
    const label = `${l.name} · ${patient || "—"}`.slice(0, 300);
    try {
      await postDoc(owner, {
        ref: insurerLineRef(fresh._id, i),
        date: new Date(),
        description: "سهم بیمه‌ی ویزیت",
        lines: [
          { role: "insuranceReceivable", debit: l.share, credit: 0, label, party: { kind: "insurer", name: l.name } },
          { role: income, debit: 0, credit: l.share, label },
        ],
        source: { type: "reservation", id: fresh._id },
        party: { kind: "insurer", name: l.name },
      });
    } catch (err) {
      // the books failed: the line waits to be booked again
      await Reservation.updateOne(
        { _id: fresh._id },
        { $set: { [`insuranceQuote.lines.${i}.status`]: "pending" }, $unset: { [`insuranceQuote.lines.${i}.bookedAt`]: 1 } },
      ).catch(() => undefined);
      console.log(`[insurance] receivable of reservation ${fresh._id} line ${i} failed:`, err);
    }
  }
};

// The visit will not take place (cancelled, the doctor did not come, an
// error): its pending lines are dropped - nothing was booked.
export const cancelInsurerLines = async (reservationId: unknown) => {
  const r = await Reservation.findById(reservationId).select("insuranceQuote").lean<IReservation>();
  const lines = r?.insuranceQuote?.lines || [];
  const set: Record<string, string> = {};
  lines.forEach((l: IReservationInsurerLine, i: number) => {
    if (l.status === "pending") set[`insuranceQuote.lines.${i}.status`] = "cancelled";
  });
  if (Object.keys(set).length) await Reservation.updateOne({ _id: reservationId }, { $set: set }).catch(() => undefined);
};

// A done visit refunded after all (an admin's ruling): its booked lines not
// yet on a list are reversed; one already on a list stays there (the
// insurer's review deducts it). Returns how much was reversed.
export const reverseInsurerReceivables = async (reservationId: unknown, why = "برگشت سهم بیمه‌ی ویزیت") => {
  const r = await Reservation.findById(reservationId).select("doctor insuranceQuote").lean<IReservation>();
  await cancelInsurerLines(reservationId);
  const lines = r?.insuranceQuote?.lines || [];
  const owner: BizOwner = { kind: "doctor", id: idOf(r?.doctor) };
  let reversed = 0;
  for (const [i, l] of lines.entries()) {
    if (l.status !== "booked" || l.claim) continue;
    const done = await Reservation.updateOne(
      { _id: reservationId, [`insuranceQuote.lines.${i}.status`]: "booked", [`insuranceQuote.lines.${i}.claim`]: { $exists: false } },
      { $set: { [`insuranceQuote.lines.${i}.status`]: "reversed" } },
    );
    if (!done.modifiedCount) continue;
    await reverseRef(owner, insurerLineRef(reservationId, i), why);
    reversed += l.share;
  }
  return reversed;
};
