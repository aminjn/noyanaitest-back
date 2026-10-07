import Reservation, { IReservation, IReservationInsurerLine } from "../../Models/Reservation";
import { BizOwner } from "./coa";
import { postDoc, reverseRef } from "./finance";

// The insurers' share of a visit (2026-10, Lib/insuranceTariffs.ts): the
// patient paid only their part, so what the insurers owe is a receivable.
// It is booked when the visit takes place, the way a practice books a
// visit it will claim (docs/business-suite.md section 5), in the books of
// whoever holds the contract with that insurer (line.holder):
//
//  the doctor (their own panel lists the insurer) - as before:
//    doctor   Dr 1412 insurers (the insurer's تفصیلی)   Cr visit income
//
//  a clinic or hospital, for a visit at its office, when only the centre
//  lists the insurer: the centre sends the list and is paid, and passes
//  the share on to the doctor in full - the same split as every centre
//  visit on Noyan today, where the doctor is the seller of record and is
//  paid the whole visit (less Noyan's commission on the part paid online;
//  the insurer's part never passes through Noyan, so there is none on it):
//    centre   Dr 1412 insurers                Cr 6101 visit income
//             Dr 7105 doctors' share          Cr 3305 doctors' share payable (the doctor)
//    doctor   Dr 1411 receivable (the centre) Cr visit income
//
//  visit refunded   the same vouchers reversed (lines not on a list yet)
//
// Paid at the desk, nothing is booked unless the doctor confirmed the
// patient paid their part there («پرداخت دریافت شد», deskPaidAt) and kept
// the insurer share on Noyan (deskInsurer). Each line then waits for its
// holder's list to that insurer (Lib/business/claims.ts claimCandidates:
// «res:<reservation>:<line>»).

const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

// a line's voucher ref; a line booked again after a reversal has its round
export const insurerLineRef = (reservationId: unknown, index: number, round = 0) =>
  `resins:${idOf(reservationId)}:${index}${round > 0 ? `:r${round}` : ""}`;

const personName = (p: unknown) => {
  const o = (p || {}) as { givenName?: string; lastName?: string; firstName?: string };
  return `${o.givenName || o.firstName || ""} ${o.lastName || ""}`.trim();
};

const centreOwner = (l: Pick<IReservationInsurerLine, "holder" | "centreKind" | "centre">): BizOwner | null =>
  l.holder === "centre" && l.centre && (l.centreKind === "clinic" || l.centreKind === "hospital")
    ? { kind: l.centreKind, id: idOf(l.centre) }
    : null;

// the insurers' share the patient did not pay online at booking (whatever
// became of the lines since: the wallet only ever held the patient's part)
export const onlineInsurerShare = (r: Pick<IReservation, "insuranceQuote" | "payAtDesk">) =>
  r.payAtDesk ? 0 : Math.max(0, Number(r.insuranceQuote?.insurerShare) || 0);

// may this reservation's lines be booked: paid online, or paid at the desk
// and confirmed by the doctor with the insurer share kept on Noyan
const bookable = (r: Pick<IReservation, "payAtDesk" | "deskPaidAt" | "deskInsurer">) =>
  !r.payAtDesk || (!!r.deskPaidAt && r.deskInsurer !== false);

const postLine = async (fresh: IReservation, l: IReservationInsurerLine, i: number) => {
  const doctorOwner: BizOwner = { kind: "doctor", id: idOf(fresh.doctor) };
  const patient = personName(fresh.patient);
  const income = fresh.sessionType === "inPerson" ? "visitIncome" : "onlineVisitIncome";
  const ref = insurerLineRef(fresh._id, i, l.round || 0);
  const label = `${l.name} · ${patient || "—"}`.slice(0, 300);
  const centre = centreOwner(l);
  if (!centre) {
    await postDoc(doctorOwner, {
      ref,
      date: new Date(),
      description: "سهم بیمه‌ی ویزیت",
      lines: [
        { role: "insuranceReceivable", debit: l.share, credit: 0, label, party: { kind: "insurer", name: l.name } },
        { role: income, debit: 0, credit: l.share, label },
      ],
      source: { type: "reservation", id: fresh._id },
      party: { kind: "insurer", name: l.name },
    });
    return;
  }
  const doctorName = personName(fresh.doctor) || "—";
  const centreName = l.centreName || "—";
  await postDoc(centre, {
    ref,
    date: new Date(),
    description: "سهم بیمه‌ی ویزیت پزشک در مرکز",
    lines: [
      { role: "insuranceReceivable", debit: l.share, credit: 0, label, party: { kind: "insurer", name: l.name } },
      { role: "visitIncome", debit: 0, credit: l.share, label },
      { role: "doctorsShareExpense", debit: l.share, credit: 0, label: `${doctorName} · ${label}`.slice(0, 300) },
      { role: "doctorsSharePayable", debit: 0, credit: l.share, label: `${doctorName} · ${label}`.slice(0, 300), party: { kind: "doctor", name: doctorName } },
    ],
    source: { type: "reservation", id: fresh._id },
  });
  try {
    await postDoc(doctorOwner, {
      ref,
      date: new Date(),
      description: "سهم بیمه‌ی ویزیت (طلب از مرکز)",
      lines: [
        { role: "receivable", debit: l.share, credit: 0, label: `${centreName} · ${label}`.slice(0, 300), party: { kind: "custom", name: centreName } },
        { role: income, debit: 0, credit: l.share, label },
      ],
      source: { type: "reservation", id: fresh._id },
      party: { kind: "custom", name: centreName },
    });
  } catch (err) {
    // the centre's voucher stands alone otherwise: undo it, the line retries
    await reverseRef(centre, ref, "برگشت سهم بیمه‌ی ویزیت").catch(() => undefined);
    throw err;
  }
};

// Books every pending insurer line of a done visit in its holder's books
// (idempotent: each line is claimed once, its voucher ref is unique).
export const bookInsurerReceivables = async (reservation: Pick<IReservation, "_id">) => {
  const fresh = await Reservation.findById(reservation._id)
    .select("doctor patient sessionType insuranceQuote payAtDesk deskPaidAt deskInsurer")
    .populate([
      { path: "patient", select: "givenName lastName nationalId" },
      { path: "doctor", select: "firstName lastName" },
    ])
    .lean<IReservation>();
  if (!fresh?.insuranceQuote || !bookable(fresh)) return;
  for (const [i, l] of fresh.insuranceQuote.lines.entries()) {
    if (l.status !== "pending" || !(l.share > 0)) continue;
    const claimed = await Reservation.updateOne(
      { _id: fresh._id, [`insuranceQuote.lines.${i}.status`]: "pending" },
      { $set: { [`insuranceQuote.lines.${i}.status`]: "booked", [`insuranceQuote.lines.${i}.bookedAt`]: new Date() } },
    );
    if (!claimed.modifiedCount) continue;
    try {
      await postLine(fresh, l, i);
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
// yet on a list are reversed in every book they were posted to; one already
// on a list stays there (the insurer's review deducts it). Returns how much
// was reversed.
export const reverseInsurerReceivables = async (reservationId: unknown, why = "برگشت سهم بیمه‌ی ویزیت") => {
  const r = await Reservation.findById(reservationId).select("doctor insuranceQuote").lean<IReservation>();
  await cancelInsurerLines(reservationId);
  const lines = r?.insuranceQuote?.lines || [];
  const doctorOwner: BizOwner = { kind: "doctor", id: idOf(r?.doctor) };
  let reversed = 0;
  for (const [i, l] of lines.entries()) {
    if (l.status !== "booked" || l.claim) continue;
    const done = await Reservation.updateOne(
      { _id: reservationId, [`insuranceQuote.lines.${i}.status`]: "booked", [`insuranceQuote.lines.${i}.claim`]: { $exists: false } },
      { $set: { [`insuranceQuote.lines.${i}.status`]: "reversed" } },
    );
    if (!done.modifiedCount) continue;
    const ref = insurerLineRef(reservationId, i, l.round || 0);
    const centre = centreOwner(l);
    if (centre) await reverseRef(centre, ref, why);
    await reverseRef(doctorOwner, ref, why);
    reversed += l.share;
  }
  return reversed;
};

// An admin ruled a visit that had been counted as not done (a no-show, an
// error, a cancellation) as done after all: its dropped lines come back and
// are booked; a line reversed earlier is booked again in a new round.
// Idempotent: a line already booked, or on a list, is left alone. Returns
// what was booked.
export const restoreInsurerLines = async (reservationId: unknown) => {
  const r = await Reservation.findById(reservationId).select("insuranceQuote payAtDesk deskPaidAt deskInsurer").lean<IReservation>();
  const lines = r?.insuranceQuote?.lines || [];
  if (!r || !lines.length) return 0;
  for (const [i, l] of lines.entries()) {
    if (!(l.share > 0) || l.claim || !["cancelled", "reversed"].includes(l.status)) continue;
    // paid at the desk without the doctor's confirmation: the estimate only
    const back = bookable(r) ? "pending" : "desk";
    await Reservation.updateOne(
      { _id: reservationId, [`insuranceQuote.lines.${i}.status`]: l.status },
      {
        $set: {
          [`insuranceQuote.lines.${i}.status`]: back,
          ...(l.status === "reversed" ? { [`insuranceQuote.lines.${i}.round`]: (l.round || 0) + 1 } : {}),
        },
        $unset: { [`insuranceQuote.lines.${i}.bookedAt`]: 1 },
      },
    );
  }
  await bookInsurerReceivables({ _id: reservationId } as never);
  const after = await Reservation.findById(reservationId).select("insuranceQuote.lines").lean<IReservation>();
  return (after?.insuranceQuote?.lines || []).filter((l) => l.status === "booked").reduce((s, l) => s + l.share, 0);
};

// «پرداخت دریافت شد»: the doctor confirmed the patient paid their part at
// the desk. With `insurer` the estimated insurer lines become receivables
// like those of a visit paid online - booked now when the visit is already
// done, else when it is (Services/reservationProgressService.ts).
export const confirmDeskPayment = async (reservationId: unknown, by: unknown, insurer: boolean) => {
  const r = await Reservation.findOneAndUpdate(
    { _id: reservationId, deskPaidAt: { $exists: false } },
    { $set: { deskPaidAt: new Date(), deskPaidBy: by, deskInsurer: insurer } },
    { new: true },
  )
    .select("status insuranceQuote")
    .lean<IReservation>();
  if (!r) return null;
  if (insurer) {
    const set: Record<string, string> = {};
    (r.insuranceQuote?.lines || []).forEach((l, i) => {
      if (l.status === "desk" && l.share > 0) set[`insuranceQuote.lines.${i}.status`] = "pending";
    });
    if (Object.keys(set).length) await Reservation.updateOne({ _id: reservationId }, { $set: set });
    if (r.status === "completed") await bookInsurerReceivables({ _id: reservationId } as never);
  }
  return Reservation.findById(reservationId).select("deskPaidAt deskInsurer insuranceQuote status").lean();
};
