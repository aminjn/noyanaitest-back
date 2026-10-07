import crypto from "crypto";
import mongoose, { isValidObjectId } from "mongoose";
import WaitlistEntry, { IWaitlistEntry } from "../Models/WaitlistEntry";
import DoctorProfile from "../Models/DoctorProfile";
import { DoctorSessionType } from "../Models/DoctorSession";
import { bookableDays, BookableDay } from "./bookingFlow";
import { addDaysYmd, fromTehranWallClock, tehranYmd } from "./tehranTime";
import { notifyWithSms, smsDate, smsTime } from "../Services/notificationSmsService";

// The waitlist (2026-10, «وقتی نوبت خالی شد خبرم کن»; docs/booking-
// benchmark.md in the frontend). Doctolib and Zocdoc tell the first people
// waiting when a slot frees up; we do the same, fairly:
//  - first come, first told: waiters are taken in the order they joined;
//  - in waves: one freed slot is offered to WAVE_SIZE waiters at a time,
//    with a HOLD_MINUTES head start; if none of them books it, the next
//    wave hears about it when the hold runs out (runWaitlistSweep);
//  - nothing is reserved: the notice links to the normal booking, whose
//    checks (Controllers/bookingController.ts) still decide, so a slot is
//    never booked twice;
//  - rate limited: one live offer per entry, MAX_NOTICES_PER_DAY per entry
//    and MAX_USER_NOTICES_PER_DAY per patient per Tehran day;
//  - slots already free when the patient joined do not trigger a notice
//    (they saw them and chose to wait).
// It runs whenever the doctor's availability is regenerated
// (Lib/updateDoctorAvailablity.ts: a cancellation, a reschedule, new
// shifts, time off removed, the nightly horizon move) and on its own sweep.

export const WAVE_SIZE = 3;
export const HOLD_MINUTES = 15;
export const MAX_NOTICES_PER_DAY = 3;
export const MAX_USER_NOTICES_PER_DAY = 6;
// active entries one patient may keep
export const MAX_ACTIVE_ENTRIES = 10;
// the range is capped by the admin's booking horizon (what the picker
// shows and the slots are computed over, Lib/bookingFlow.ts)

export const slotKey = (ymd: string, start: number, office?: string | null) =>
  `${ymd}|${start}|${office || ""}`;

type FreeSlot = { ymd: string; start: number; end: number; office: string };

const flatten = (days: BookableDay[], from: string, to: string): FreeSlot[] =>
  days
    .filter((d) => d.ymd >= from && d.ymd <= to)
    .flatMap((d) => d.bounds.map((b) => ({ ymd: d.ymd, start: b.start, end: b.end, office: b.office })));

const doctorName = (d: { firstName?: string; lastName?: string } | null) =>
  `${d?.firstName || ""} ${d?.lastName || ""}`.trim();

// the free slots inside an entry's range, today first
export const freeSlotsFor = async (entry: {
  doctor: unknown;
  sessionType: DoctorSessionType;
  office?: unknown;
  from: string;
  to: string;
}) => {
  const { days } = await bookableDays({
    doctorId: entry.doctor,
    sessionType: entry.sessionType,
    office: entry.office ? String(entry.office) : undefined,
  });
  return flatten(days, entry.from, entry.to);
};

// a short, unguessable code for the SMS link (/w/<code>)
export const newWaitlistCode = () => crypto.randomBytes(6).toString("base64url");

// ----------------------------------------------------------------- match

const running = new Map<string, Promise<void>>();
const again = new Set<string>();

// Coalesced per doctor: a run already going for this doctor runs once more
// when it ends instead of racing a second one (two notices for one slot).
export const queueWaitlistMatch = (doctorId: unknown): Promise<void> => {
  const id = String(doctorId || "");
  if (!isValidObjectId(id)) return Promise.resolve();
  const current = running.get(id);
  if (current) {
    again.add(id);
    return current;
  }
  const run = (async () => {
    try {
      do {
        again.delete(id);
        await matchWaitlist(id);
      } while (again.has(id));
    } catch (err) {
      console.log("[waitlist] match failed:", err);
    } finally {
      running.delete(id);
    }
  })();
  running.set(id, run);
  return run;
};

const matchWaitlist = async (doctorId: string) => {
  const today = tehranYmd();
  const now = new Date();
  await WaitlistEntry.updateMany(
    { doctor: doctorId, status: "active", to: { $lt: today } },
    { $set: { status: "expired", endedAt: now, offerOpen: false } },
  );
  const entries = await WaitlistEntry.find({ doctor: doctorId, status: "active" })
    .sort({ createdAt: 1, _id: 1 })
    .lean<IWaitlistEntry[]>();
  if (!entries.length) return;
  const doctor = await DoctorProfile.findOne({
    _id: doctorId,
    active: true,
    claimed: { $ne: false },
    status: { $ne: "suspended" },
  })
    .select("firstName lastName")
    .lean<{ firstName?: string; lastName?: string }>();
  if (!doctor) return;

  // one slot computation per (visit type, office), shared by its waiters
  const byKind = new Map<string, Promise<BookableDay[]>>();
  const daysOf = (e: IWaitlistEntry) => {
    const key = `${e.sessionType}|${e.officeKey || ""}`;
    let days = byKind.get(key);
    if (!days) {
      days = bookableDays({
        doctorId,
        sessionType: e.sessionType,
        office: e.office ? String(e.office) : undefined,
      }).then((r) => r.days);
      byKind.set(key, days);
    }
    return days;
  };
  const free = new Map<string, FreeSlot[]>();
  for (const e of entries) free.set(String(e._id), flatten(await daysOf(e), e.from, e.to));

  // the waves still in their head start, per slot
  const live = new Map<string, number>();
  const holding = new Set<string>();
  const settle: unknown[] = [];
  for (const e of entries) {
    if (!e.offerOpen) continue;
    const o = e.offer;
    const k = o ? slotKey(o.ymd, o.start, o.office) : "";
    const stillFree = !!o && (free.get(String(e._id)) || []).some((s) => slotKey(s.ymd, s.start, s.office) === k);
    if (o && stillFree && new Date(o.holdUntil) > now) {
      live.set(k, (live.get(k) || 0) + 1);
      holding.add(String(e._id));
    } else settle.push(e._id);
  }
  if (settle.length)
    await WaitlistEntry.updateMany({ _id: { $in: settle } }, { $set: { offerOpen: false } });

  // notices each patient already had today (all their entries)
  const users = [...new Set(entries.map((e) => String(e.user)))];
  const sentToday = new Map<string, number>(
    (
      await WaitlistEntry.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
        {
          $match: {
            user: { $in: users.map((u) => new mongoose.Types.ObjectId(u)) },
            noticeDay: today,
          },
        },
        { $group: { _id: "$user", n: { $sum: "$noticeCount" } } },
      ])
    ).map((r) => [String(r._id), r.n]),
  );

  const name = doctorName(doctor);
  for (const e of entries) {
    const id = String(e._id);
    if (holding.has(id)) continue;
    const todayCount = e.noticeDay === today ? e.noticeCount || 0 : 0;
    if (todayCount >= MAX_NOTICES_PER_DAY) continue;
    if ((sentToday.get(String(e.user)) || 0) >= MAX_USER_NOTICES_PER_DAY) continue;
    const seen = new Set(e.seen || []);
    const pick = (free.get(id) || []).find((s) => {
      const k = slotKey(s.ymd, s.start, s.office);
      return !seen.has(k) && (live.get(k) || 0) < WAVE_SIZE;
    });
    if (!pick) continue;
    const k = slotKey(pick.ymd, pick.start, pick.office);
    const holdUntil = new Date(now.getTime() + HOLD_MINUTES * 60 * 1000);
    const claimed = await WaitlistEntry.findOneAndUpdate(
      { _id: e._id, status: "active", seen: { $ne: k } },
      {
        $set: {
          offer: { ...pick, sentAt: now, holdUntil },
          offerOpen: true,
          noticeDay: today,
          noticeCount: todayCount + 1,
        },
        $inc: { notices: 1 },
        $push: { seen: { $each: [k], $slice: -300 } },
      },
      { new: true },
    ).lean<IWaitlistEntry>();
    if (!claimed) continue;
    live.set(k, (live.get(k) || 0) + 1);
    sentToday.set(String(e.user), (sentToday.get(String(e.user)) || 0) + 1);
    const date = smsDate(fromTehranWallClock(pick.ymd, 12 * 60));
    const time = smsTime(pick.start);
    await notifyWithSms(
      "waitlistSlotOpenUser",
      e.user,
      { doctorName: name, date, time, code: claimed.code },
      {
        notification: {
          title: "نوبت خالی شد",
          message: `یک نوبت با دکتر ${name} در تاریخ ${date} ساعت ${time} خالی شد. زودتر رزرو کنید؛ به چند نفر دیگر از صف انتظار هم خبر داده‌ایم.`,
          link: `/w/${claimed.code}`,
        },
        once: `${id}:${k}`,
      },
    );
  }
};

// ----------------------------------------------------------------- sweep

// Ends waits whose range is over, and moves a freed slot on to the next
// wave once the current wave's head start has run out.
export const runWaitlistSweep = async () => {
  const now = new Date();
  await WaitlistEntry.updateMany(
    { status: "active", to: { $lt: tehranYmd() } },
    { $set: { status: "expired", endedAt: now, offerOpen: false } },
  );
  const doctors = await WaitlistEntry.distinct("doctor", {
    status: "active",
    offerOpen: true,
    "offer.holdUntil": { $lte: now },
  });
  for (const d of doctors) await queueWaitlistMatch(d);
};

const SWEEP_INTERVAL = 2 * 60 * 1000;
export const startWaitlistJob = () => {
  const tick = () => runWaitlistSweep().catch((err) => console.log("[waitlist] sweep failed:", err));
  tick();
  setInterval(tick, SWEEP_INTERVAL);
};

// ------------------------------------------------------------- lifecycle

// A booking with the doctor ends the patient's wait for that visit type
// (whatever slot or office they took).
export const closeWaitlistOnBooking = (
  userId: unknown,
  doctorId: unknown,
  sessionType: string,
  reservationId: unknown,
) =>
  WaitlistEntry.updateMany(
    { user: userId, doctor: doctorId, sessionType, status: "active" },
    { $set: { status: "booked", reservation: reservationId, endedAt: new Date(), offerOpen: false } },
  ).catch(() => undefined);

// How many patients wait for each of the doctor's next days (the schedule
// shows it next to each day).
export const waitlistByDay = async (doctorId: unknown, days = 30) => {
  const today = tehranYmd();
  const last = addDaysYmd(today, days - 1);
  const entries = await WaitlistEntry.find({
    doctor: doctorId,
    status: "active",
    to: { $gte: today },
    from: { $lte: last },
  })
    .select("from to")
    .lean<{ from: string; to: string }[]>();
  const byDay: Record<string, number> = {};
  for (let ymd = today; ymd <= last; ymd = addDaysYmd(ymd, 1)) {
    const n = entries.filter((e) => e.from <= ymd && ymd <= e.to).length;
    if (n) byDay[ymd] = n;
  }
  return { total: entries.length, byDay };
};
