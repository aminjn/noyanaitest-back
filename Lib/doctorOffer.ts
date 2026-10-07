import mongoose from "mongoose";
import DoctorProfile from "../Models/DoctorProfile";
import DoctorShift from "../Models/DoctorShift";
import Office from "../Models/Office";
import InPersonSettings from "../Models/InPersonSettings";
import SipCallSettings from "../Models/SipCallSettings";
import TextChatSettings from "../Models/TextChatSettings";
import VideoCallSettings from "../Models/VideoCallSettings";
import VoiceCallSettings from "../Models/voiceCallSetrtings";

// What a doctor really offers (2026-10, doctor profile audit): ONE rule for
// every place that shows or filters a doctor's visit types - the shared card
// (home, speciality, search, disease / drug / symptom, map, clinic and
// hospital pages), the profile page, the /book visit-type filter, the
// automatic publish and the panel's setup checklist.
//
// A visit type is offered when the doctor switched it on with a price AND a
// weekly shift at an active office holds it - the same conditions the slot
// picker uses (Lib/bookingFlow.ts, Lib/nextSlot.ts). The card used to read
// the settings' `active` flag alone, the speciality page the shifts alone,
// and the search both but without price or office: one doctor showed three
// different sets of visit types, and a doctor with no office or shift at
// all was shown with a "book" button.
//
// `bookable` is what the card's booking action follows: a published,
// claimed (has an account), not suspended doctor who offers at least one
// visit type. An unclaimed directory profile or a doctor still setting up
// is shown with the same card, without the booking action (Paziresh24's
// «نوبت‌دهی اینترنتی ندارد», Doctolib's "not bookable online").

export const offerTypes = ["inPerson", "textChat", "voiceCall", "sipCall", "videoCall"] as const;
export type OfferType = (typeof offerTypes)[number];

const settingsModels: Record<OfferType, mongoose.Model<any>> = {
  inPerson: InPersonSettings,
  textChat: TextChatSettings,
  voiceCall: VoiceCallSettings,
  sipCall: SipCallSettings,
  videoCall: VideoCallSettings,
};

const toIds = (ids: unknown[]) =>
  [...new Set((Array.isArray(ids) ? ids : []).map((id) => String((id as { _id?: unknown })?._id ?? id)))]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

export type DoctorOffer = {
  // visit types switched on with a price
  priced: OfferType[];
  // ... that a shift at an active office holds: what patients can book
  sessionTypes: OfferType[];
  hasActiveOffice: boolean;
  hasShift: boolean;
};

// one query per collection for a whole page of doctors
export const doctorOffers = async (doctorIds: unknown[]): Promise<Map<string, DoctorOffer>> => {
  const ids = toIds(doctorIds);
  const out = new Map<string, DoctorOffer>();
  if (!ids.length) return out;
  const [offices, shifts, ...priced] = await Promise.all([
    Office.find({ doctor: { $in: ids }, active: true }).select("doctor").lean<{ _id: unknown; doctor: unknown }[]>(),
    DoctorShift.find({ doctor: { $in: ids } })
      .select("doctor office sessionTypes")
      .lean<{ doctor: unknown; office?: unknown; sessionTypes?: string[] }[]>(),
    ...offerTypes.map((type) =>
      settingsModels[type].find({ doctor: { $in: ids }, active: true, price: { $gt: 0 } }).distinct("doctor"),
    ),
  ]);
  const activeOffice = new Set(offices.map((o) => String(o._id)));
  for (const id of ids.map(String)) {
    const on = offerTypes.filter((_, i) => (priced[i] as unknown[]).some((d) => String(d) === id));
    const mine = shifts.filter((s) => String(s.doctor) === id);
    const covered = new Set(
      mine.filter((s) => activeOffice.has(String(s.office))).flatMap((s) => s.sessionTypes || []),
    );
    out.set(id, {
      priced: on,
      sessionTypes: on.filter((type) => covered.has(type)),
      hasActiveOffice: offices.some((o) => String(o.doctor) === id),
      hasShift: mine.length > 0,
    });
  }
  return out;
};

// the ids (of `doctorIds`, or of every doctor when omitted) that offer at
// least one of `types` - the /book visit-type filter
export const doctorsOffering = async (types: string[], doctorIds?: unknown[]): Promise<mongoose.Types.ObjectId[]> => {
  const wanted = offerTypes.filter((t) => types.includes(t));
  if (!wanted.length) return [];
  const scope = doctorIds ? { doctor: { $in: toIds(doctorIds) } } : {};
  const priced = await Promise.all(
    wanted.map((type) =>
      settingsModels[type].find({ ...scope, active: true, price: { $gt: 0 } }).distinct("doctor"),
    ),
  );
  const candidates = toIds(priced.flat());
  if (!candidates.length) return [];
  const offers = await doctorOffers(candidates);
  return candidates.filter((id) => offers.get(String(id))?.sessionTypes.some((t) => wanted.includes(t)));
};

type CardRow = {
  _id?: unknown;
  active?: boolean;
  claimed?: boolean;
  status?: string;
};

// writes `sessionTypes` and `bookable` on each doctor row - plain objects
// (lean / aggregate rows; a mongoose document goes through doctorCards,
// its toJSON would drop the keys); rows that are not doctors (null, an
// unmatched populate) are skipped
export const attachDoctorCards = async <T>(rows: T[]): Promise<T[]> => {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (r): r is T & CardRow => !!r && typeof r === "object" && !!(r as CardRow)._id,
  );
  if (!list.length) return rows;
  const offers = await doctorOffers(list.map((r) => r._id)).catch(() => new Map<string, DoctorOffer>());
  for (const row of list) {
    const offer = offers.get(String(row._id));
    const sessionTypes = offer?.sessionTypes || [];
    const bookable =
      row.active !== false && row.claimed !== false && row.status !== "suspended" && sessionTypes.length > 0;
    Object.assign(row, { sessionTypes, bookable });
  }
  return rows;
};

// a mongoose document drops unknown keys in toJSON: turn a list of documents
// into plain objects first, then attach
export const toCardRows = <T>(docs: T[]): Record<string, unknown>[] =>
  (Array.isArray(docs) ? docs : [])
    .filter(Boolean)
    .map((d) =>
      typeof (d as { toObject?: unknown }).toObject === "function"
        ? (d as unknown as { toObject: (o: object) => Record<string, unknown> }).toObject({ virtuals: true })
        : (d as unknown as Record<string, unknown>),
    );

export const doctorCards = async <T>(docs: T[]): Promise<Record<string, unknown>[]> =>
  attachDoctorCards(toCardRows(docs));
