import mongoose from "mongoose";
import DoctorProfile from "../Models/DoctorProfile";
import DoctorShift from "../Models/DoctorShift";
import DoctorTimeOff from "../Models/DoctorTimeOff";
import Office from "../Models/Office";
import Reservation from "../Models/Reservation";
import { DoctorSessionType } from "../Models/DoctorSession";
import { getShiftSessionBounds } from "./shiftUtils";
import { blockedFrom, overlapsBlocked } from "./timeOff";
import { addDaysYmd, fromTehranWallClock, tehranParts, tehranSaturdayDay, tehranYmd } from "./tehranTime";
import { getBookingHorizonDays } from "./appConfig";
import { sessionSettingsModels } from "./bookingFlow";

// «اولین نوبت» on the doctor cards of the search and speciality lists
// (2026-10, Doctolib / Zocdoc "next available"): each doctor's next free
// slot, its day, time and visit type, for a whole page of doctors in one
// go - one query per collection, not one request per card. The rules are
// the slot picker's (Lib/bookingFlow.ts bookableDays): a shift of that
// weekday holding a visit type the doctor has on (with a price), at an
// active office, no booking overlapping it, no time off, today only from
// the next hour on.

export type NextSlot = {
  ymd: string;
  date: Date;
  start: number;
  end: number;
  office: string;
  sessionType: DoctorSessionType;
};

// in person first, then the online types in the market's habit order
// (Components/Booking/Flow/bookingFlow.ts visitTypeOrder)
const typeOrder: DoctorSessionType[] = ["inPerson", "textChat", "voiceCall", "sipCall", "videoCall"];

export const nextFreeSlots = async (
  doctorIds: unknown[],
  { sessionTypes }: { sessionTypes?: string[] } = {},
): Promise<Map<string, NextSlot>> => {
  const out = new Map<string, NextSlot>();
  const ids = [...new Set(doctorIds.map(String))]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!ids.length) return out;
  const wanted = typeOrder.filter((t) => !sessionTypes?.length || sessionTypes.includes(t));
  if (!wanted.length) return out;
  const horizon = Math.min(60, Math.max(1, await getBookingHorizonDays()));
  const firstYmd = tehranYmd();
  const lastYmd = addDaysYmd(firstYmd, horizon - 1);
  const from = fromTehranWallClock(firstYmd, 0);
  const to = fromTehranWallClock(addDaysYmd(lastYmd, 1), 0);
  const [bookable, shifts, reservations, timeOff, ...settings] = await Promise.all([
    DoctorProfile.find({
      _id: { $in: ids },
      active: true,
      claimed: { $ne: false },
      status: { $ne: "suspended" },
    }).distinct("_id"),
    DoctorShift.find({ doctor: { $in: ids }, sessionTypes: { $in: wanted } })
      .select("doctor day start end duration gap sessionTypes office")
      .lean(),
    Reservation.find({ doctor: { $in: ids }, status: { $ne: "cancelled" }, date: { $gte: from, $lt: to } })
      .select("doctor date start end")
      .lean(),
    DoctorTimeOff.find({ doctor: { $in: ids }, from: { $lt: to }, to: { $gte: from } })
      .select("doctor from to startMin endMin")
      .lean(),
    ...wanted.map((t) =>
      sessionSettingsModels[t]
        .find({ doctor: { $in: ids }, active: true, price: { $gt: 0 } })
        .distinct("doctor"),
    ),
  ]);
  const okDoctor = new Set(bookable.map(String));
  // the visit types each doctor really takes
  const typesOf = new Map<string, Set<string>>();
  wanted.forEach((t, i) => {
    for (const d of settings[i] as unknown[]) {
      const key = String(d);
      if (!typesOf.has(key)) typesOf.set(key, new Set());
      typesOf.get(key)?.add(t);
    }
  });
  const officeIds = [...new Set(shifts.map((s) => String(s.office)).filter(Boolean))];
  const activeOffices = new Set(
    (await Office.find({ _id: { $in: officeIds }, active: { $ne: false } }).distinct("_id")).map(String),
  );
  const group = <T extends { doctor?: unknown }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const r of rows) {
      const key = String(r.doctor);
      if (!map.has(key)) map.set(key, []);
      map.get(key)?.push(r);
    }
    return map;
  };
  const shiftsBy = group(shifts as { doctor?: unknown }[]) as Map<string, typeof shifts>;
  const reservationsBy = group(reservations as { doctor?: unknown }[]) as Map<string, typeof reservations>;
  const timeOffBy = group(timeOff as { doctor?: unknown }[]) as Map<string, typeof timeOff>;
  const now = tehranParts();

  for (const id of ids.map(String)) {
    const types = typesOf.get(id);
    if (!okDoctor.has(id) || !types?.size) continue;
    const myShifts = (shiftsBy.get(id) || []).filter((s) => activeOffices.has(String(s.office)));
    if (!myShifts.length) continue;
    const taken = new Map<string, [number, number][]>();
    for (const r of reservationsBy.get(id) || []) {
      const key = tehranYmd(r.date);
      if (!taken.has(key)) taken.set(key, []);
      taken.get(key)?.push([r.start, r.end]);
    }
    const myTimeOff = timeOffBy.get(id) || [];
    for (let ymd = firstYmd; ymd <= lastYmd && !out.has(id); ymd = addDaysYmd(ymd, 1)) {
      const day = fromTehranWallClock(ymd, 0);
      const blocked = blockedFrom(myTimeOff, day);
      if (blocked.wholeDay) continue;
      const weekday = tehranSaturdayDay(day);
      const fromMinute = ymd === now.ymd ? (now.hour + 1) * 60 : 0;
      const busy = taken.get(ymd) || [];
      let best: NextSlot | null = null;
      for (const shift of myShifts) {
        if (shift.day !== weekday) continue;
        const type = typeOrder.find((t) => types.has(t) && (shift.sessionTypes || []).includes(t as never));
        if (!type) continue;
        for (const [start, end] of getShiftSessionBounds(shift as never)) {
          if (start < fromMinute || (best && start >= best.start)) continue;
          if (overlapsBlocked(blocked.ranges, start, end)) continue;
          if (busy.some(([a, b]) => !(b <= start || a >= end))) continue;
          best = { ymd, date: day, start, end, office: String(shift.office), sessionType: type };
          break;
        }
      }
      if (best) out.set(id, best);
    }
  }
  return out;
};

// the same, written onto a page of rows as `nextSlot` (null when none)
export const attachNextSlots = async <T extends { _id: unknown }>(
  rows: T[],
  options?: { sessionTypes?: string[] },
): Promise<(T & { nextSlot: NextSlot | null })[]> => {
  const list = Array.isArray(rows) ? rows : [];
  const slots = await nextFreeSlots(
    list.map((r) => r?._id),
    options,
  ).catch(() => new Map<string, NextSlot>());
  return list.map((r) => Object.assign(r, { nextSlot: slots.get(String(r?._id)) || null }));
};

// The "earliest available" order of a search (2026-10): by each doctor's
// real next slot - the one their card shows - not the cached availability.
// `ranked` is every matching doctor in the cached order with its cached
// first-free instant (earliestKey; MAX for none): a lower bound, since the
// cache ignores the visit type and inactive offices. The real slots are
// computed in batches (one query per collection, nextFreeSlots) for a
// window of the best candidates, doubled until the first `need` places are
// provably right - every doctor left outside the window has a lower bound
// later than they are - or the window reaches MAX_WINDOW. Returns the ids
// in order and the slots computed (null: none in the horizon).
const MIN_WINDOW = 36;
const MAX_WINDOW = 288;
export const earliestOrder = async (
  ranked: { _id: unknown; earliestKey?: number }[],
  need: number,
  options?: { sessionTypes?: string[] },
): Promise<{ ids: string[]; slots: Map<string, NextSlot | null> }> => {
  const list = (Array.isArray(ranked) ? ranked : []).map((r) => ({
    id: String(r._id),
    key: Number.isFinite(Number(r.earliestKey)) ? Number(r.earliestKey) : Number.MAX_SAFE_INTEGER,
  }));
  const slots = new Map<string, NextSlot | null>();
  const at = (s: NextSlot) => fromTehranWallClock(s.ymd, s.start).getTime();
  let size = Math.min(list.length, Math.max(MIN_WINDOW, need + 18));
  for (;;) {
    const todo = list.slice(0, size).filter((r) => !slots.has(r.id)).map((r) => r.id);
    if (todo.length) {
      const found = await nextFreeSlots(todo, options).catch(() => new Map<string, NextSlot>());
      for (const id of todo) slots.set(id, found.get(id) || null);
    }
    if (size >= list.length || size >= MAX_WINDOW) break;
    // the cached lower bound of the first doctor outside the window
    const boundary = list[size].key;
    const sure = list.slice(0, size).filter((r) => {
      const s = slots.get(r.id);
      return !!s && at(s) <= boundary;
    }).length;
    if (sure >= need) break;
    size = Math.min(list.length, MAX_WINDOW, size * 2);
  }
  const index = new Map(list.map((r, i) => [r.id, i]));
  const inWindow = list.slice(0, size);
  const withSlot = inWindow
    .filter((r) => !!slots.get(r.id))
    .sort((a, b) => at(slots.get(a.id)!) - at(slots.get(b.id)!) || index.get(a.id)! - index.get(b.id)!);
  const outside = list.slice(size);
  const ids = [
    ...withSlot.map((r) => r.id),
    // past the window, the cached order (their real slot is not earlier)
    ...outside.filter((r) => r.key < Number.MAX_SAFE_INTEGER).map((r) => r.id),
    // no free slot at all: last
    ...inWindow.filter((r) => !slots.get(r.id)).map((r) => r.id),
    ...outside.filter((r) => r.key >= Number.MAX_SAFE_INTEGER).map((r) => r.id),
  ];
  return { ids, slots };
};
