import DoctorProfile from "../Models/DoctorProfile";
import { earliestBookable, fromMinuteOn } from "./bookingNotice";
import { isValidObjectId, Model } from "mongoose";
import DoctorShift from "../Models/DoctorShift";
import Reservation from "../Models/Reservation";
import Office from "../Models/Office";
import BizContact from "../Models/BizContact";
import BizClubRedemption from "../Models/BizClubRedemption";
import { DoctorSessionType } from "../Models/DoctorSession";
import InPersonSettings from "../Models/InPersonSettings";
import SipCallSettings from "../Models/SipCallSettings";
import TextChatSettings from "../Models/TextChatSettings";
import VideoCallSettings from "../Models/VideoCallSettings";
import VoiceCallSettings from "../Models/voiceCallSetrtings";
import PhoneConsultSettings from "../Models/DoctorPhoneConsultSettings";
import { getShiftSessionBounds } from "./shiftUtils";
import { blockedFrom, loadTimeOff, overlapsBlocked } from "./timeOff";
import { doctorHolidays } from "./publicHolidays";
import {
  addDaysYmd,
  fromTehranWallClock,
  tehranParts,
  tehranSaturdayDay,
  tehranYmd,
} from "./tehranTime";
import { getBookingHorizonDays } from "./appConfig";
import { calcTax, getVisitTaxPercent } from "./taxSettings";
import { bookingDiscountFor } from "./patientPro";
import { rewardAmount } from "./business/crmService/club";
import { deskPayAllowed } from "./payAtDesk";
import { InsuranceOption, InsurancePick, InsuranceQuote, quoteInsurance } from "./insuranceTariffs";

// The patient booking flow (2026-10 redesign, docs/booking-benchmark.md in
// the frontend): one source of truth for the slots a patient may pick and
// for the price they pay, used by the slot picker, the checkout quote and
// the booking itself, so what the page shows is what the API accepts.

export const sessionSettingsModels: Record<DoctorSessionType, Model<any>> = {
  inPerson: InPersonSettings,
  sipCall: SipCallSettings,
  textChat: TextChatSettings,
  videoCall: VideoCallSettings,
  voiceCall: VoiceCallSettings,
  phone: PhoneConsultSettings,
};

export type BookableSlot = { start: number; end: number; office: string };
export type BookableDay = { date: Date; ymd: string; bounds: BookableSlot[] };
// an official holiday inside the horizon: `closed` when the doctor takes no
// visits that day (Lib/publicHolidays.ts) - the picker greys its day
export type HorizonHoliday = { ymd: string; title: string; closed: boolean };

// the most days one request reads (the admin's horizon may be longer)
const MAX_DAYS = 90;

// Every free slot of the doctor from today on, Tehran days, for one visit
// type (only the shifts that offer it) and optionally one office. The same
// rules as POST /booking/reserve: a shift of that weekday holding the visit
// type, no reservation overlapping it (a cancelled one frees it), no time
// off (nor an official holiday the doctor is closed on), and not sooner
// than the doctor's minimum notice (Lib/bookingNotice.ts; not set: today
// from the next hour on).
export const bookableDays = async ({
  doctorId,
  sessionType,
  office,
  days,
}: {
  doctorId: unknown;
  sessionType?: DoctorSessionType;
  office?: string;
  days?: number;
}): Promise<{ days: BookableDay[]; horizon: number; holidays: HorizonHoliday[] }> => {
  const horizon = Math.min(MAX_DAYS, Math.max(1, days || (await getBookingHorizonDays())));
  const firstYmd = tehranYmd();
  const lastYmd = addDaysYmd(firstYmd, horizon - 1);
  const from = fromTehranWallClock(firstYmd, 0);
  const to = fromTehranWallClock(addDaysYmd(lastYmd, 1), 0);
  const [shifts, reservations, timeOff, holidays, doc] = await Promise.all([
    DoctorShift.find({
      doctor: doctorId,
      ...(sessionType ? { sessionTypes: sessionType } : {}),
      ...(office && isValidObjectId(office) ? { office } : {}),
    }).lean(),
    Reservation.find({
      doctor: doctorId,
      status: { $ne: "cancelled" },
      date: { $gte: from, $lt: to },
    })
      .select("date start end")
      .lean(),
    loadTimeOff(doctorId, from, to),
    doctorHolidays(doctorId, firstYmd, lastYmd).catch(() => [] as HorizonHoliday[]),
    DoctorProfile.findById(doctorId).select("bookingNoticeMinutes").lean<{ bookingNoticeMinutes?: number | null }>(),
  ]);
  // the doctor's minimum notice (Lib/bookingNotice.ts)
  const earliest = earliestBookable(doc?.bookingNoticeMinutes);
  // only offices that still exist and are active take bookings
  const officeIds = [...new Set(shifts.map((s) => String(s.office)).filter(Boolean))];
  const activeOffices = new Set(
    (
      await Office.find({ _id: { $in: officeIds }, active: { $ne: false } })
        .select("_id")
        .lean()
    ).map((o) => String(o._id)),
  );
  const takenByDay = new Map<string, [number, number][]>();
  for (const r of reservations) {
    const key = tehranYmd(r.date);
    const list = takenByDay.get(key) ?? [];
    list.push([r.start, r.end]);
    takenByDay.set(key, list);
  }
  const out: BookableDay[] = [];
  for (let ymd = firstYmd; ymd <= lastYmd; ymd = addDaysYmd(ymd, 1)) {
    const day = fromTehranWallClock(ymd, 0);
    const blocked = blockedFrom(timeOff, day);
    if (blocked.wholeDay) continue;
    const weekday = tehranSaturdayDay(day);
    const taken = takenByDay.get(ymd) ?? [];
    const fromMinute = fromMinuteOn(earliest, ymd);
    if (fromMinute === Number.POSITIVE_INFINITY) continue;
    const seen = new Set<string>();
    const bounds: BookableSlot[] = [];
    for (const shift of shifts) {
      if (shift.day !== weekday || !activeOffices.has(String(shift.office))) continue;
      for (const [start, end] of getShiftSessionBounds(shift as never)) {
        if (start < fromMinute) continue;
        if (overlapsBlocked(blocked.ranges, start, end)) continue;
        if (taken.some(([a, b]) => !(b <= start || a >= end))) continue;
        const key = `${start}-${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bounds.push({ start, end, office: String(shift.office) });
      }
    }
    if (bounds.length) out.push({ date: day, ymd, bounds: bounds.sort((a, b) => a.start - b.start) });
  }
  return { days: out, horizon, holidays };
};

// ------------------------------------------------------------- club code

// A code of the doctor's own patient club (Lib/business/crmService/club.ts)
// used on an online booking: it must be this doctor's, issued, unexpired
// and the booker's own (their club membership is their account or phone).
// (2026-10) The cart checkout uses it for a pharmacy's or a lab's club too
// (Lib/cartOffers.ts): `ownerKind` names whose club.
export const findClubCode = async (
  code: string | undefined,
  doctorId: unknown,
  user: { _id: unknown; phone?: string },
  ownerKind: "doctor" | "pharmacy" | "paraClinic" = "doctor",
) => {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return { redemption: null, error: null as string | null };
  const r = await BizClubRedemption.findOne({
    ownerKind,
    ownerId: doctorId,
    code: clean,
  }).lean();
  if (!r) return { redemption: null, error: "این کد باشگاه پیدا نشد" };
  if (r.status !== "issued" || (r.expiresAt && r.expiresAt < new Date()))
    return { redemption: null, error: "این کد قبلاً استفاده یا لغو شده است" };
  const contact = await BizContact.findById(r.contact).select("user phone").lean();
  const phone = String(user.phone || "").replace(/\D/g, "").replace(/^98/, "0");
  const mine =
    !!contact &&
    (String((contact as { user?: unknown }).user || "") === String(user._id) ||
      (!!phone && (contact as { phone?: string }).phone === phone));
  if (!mine) return { redemption: null, error: "این کد مال بیمار دیگری است" };
  return { redemption: r, error: null as string | null };
};

// ------------------------------------------------------------- quote

export type BookingQuote = {
  price: number;
  hidePrice: boolean;
  clubDiscount: number;
  tax: number;
  taxPercent: number;
  proDiscount: number;
  proPotential: number;
  pro: boolean;
  // what the wallet pays now
  total: number;
  // paid at the visit instead (in-person only): no online discount
  deskTotal: number;
  payAtDesk: boolean;
  code: { applied: boolean; name?: string; error?: string } | null;
  // the insurances this doctor (or the office's centre) accepts for this
  // visit, with their plans and whether a tariff covers it
  insurances: InsuranceOption[];
  // (2026-10) the insurers' estimated shares for the insurances picked
  // (Lib/insuranceTariffs.ts): basic first, then supplementary. total and
  // deskTotal are already the patient's part; the insurer's review is final
  insurance: {
    lines: InsuranceQuote["lines"];
    insurerShare: number;
    // the visit net of the club discount, less the insurers' shares
    patientShare: number;
    notAccepted: InsuranceQuote["notAccepted"];
    saved: InsuranceQuote["saved"];
    estimate: true;
    error?: string;
  };
};

export const quoteBooking = async ({
  doctorId,
  sessionType,
  office,
  user,
  forRelative,
  code,
  insurances: picks = [],
  patient,
  at,
  exclude,
}: {
  doctorId: unknown;
  sessionType: DoctorSessionType;
  office?: string | null;
  user?: { _id: unknown; phone?: string } | null;
  forRelative?: boolean;
  code?: string;
  // the insurances the patient will use (Lib/insuranceTariffs.ts)
  insurances?: InsurancePick[];
  // the patient's identity (their saved insurances and yearly limits)
  patient?: unknown;
  // the visit's day (a tariff's validity and its month / year limits)
  at?: Date;
  // a reservation being re-quoted, left out of the limits
  exclude?: unknown;
}): Promise<(BookingQuote & { redemption: any }) | null> => {
  const settings = await sessionSettingsModels[sessionType]
    .findOne({ doctor: doctorId })
    .lean<{ price?: number; active?: boolean; hidePrice?: boolean; payAtDesk?: boolean; payAtDeskOff?: unknown[] }>();
  if (!settings || !settings.active || !settings.price) return null;
  const price = Math.max(0, Math.round(settings.price));
  const officeDoc =
    sessionType === "inPerson" && office && isValidObjectId(office)
      ? await Office.findById(office).select("clinic hospital")
      : null;
  const taxPercent = await getVisitTaxPercent(doctorId as never, officeDoc);
  const club = user && code ? await findClubCode(code, doctorId, user) : { redemption: null, error: null };
  const clubDiscount = club.redemption ? rewardAmount(club.redemption as never, price) : 0;
  const net = Math.max(0, price - clubDiscount);
  const tax = calcTax(net, taxPercent);
  // the insurers pay first, on the price net of the doctor's own (club)
  // discount; the patient pays the rest and the visit tax
  const ins = await quoteInsurance({
    doctorId: doctorId as never,
    sessionType,
    office: sessionType === "inPerson" ? office || null : null,
    net,
    picks,
    patient: (patient as never) || null,
    at: at || new Date(),
    exclude: (exclude as never) || null,
  });
  const patientNet = Math.max(0, net - ins.insurerShare);
  // the «پرو» discount is on what the patient pays
  const pro = user
    ? await bookingDiscountFor({
        userId: user._id,
        price: patientNet,
        sessionType,
        doctorId,
        forRelative: !!forRelative,
      })
    : { discount: 0, pro: false, potential: 0 };
  const proDiscount = Math.min(patientNet + tax, pro.discount);
  return {
    price,
    hidePrice: !!settings.hidePrice,
    clubDiscount,
    tax,
    taxPercent,
    proDiscount,
    proPotential: pro.potential,
    pro: pro.pro,
    total: Math.max(0, patientNet + tax - proDiscount),
    deskTotal: patientNet + tax,
    // in-person only, and only where the doctor takes it (Lib/payAtDesk.ts)
    payAtDesk: sessionType === "inPerson" && deskPayAllowed(settings, office),
    code: code
      ? club.redemption
        ? { applied: true, name: (club.redemption as { name?: string }).name }
        : { applied: false, error: club.error || undefined }
      : null,
    insurances: ins.options,
    insurance: {
      lines: ins.lines,
      insurerShare: ins.insurerShare,
      patientShare: patientNet,
      notAccepted: ins.notAccepted,
      saved: ins.saved,
      estimate: true,
      ...(ins.error ? { error: ins.error } : {}),
    },
    redemption: club.redemption,
  };
};

// the code goes back to the patient when their booking is cancelled
export const releaseClubCode = (reservationId: unknown) =>
  BizClubRedemption.updateOne(
    { reservation: reservationId, status: "used" },
    { $set: { status: "issued", discountAmount: 0 }, $unset: { reservation: 1, usedAt: 1 } },
  ).catch(() => undefined);
