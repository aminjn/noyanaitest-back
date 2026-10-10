import { tehranParts } from "./tehranTime";

// The doctor's minimum booking notice (2026-10, Doctolib's "délai minimum
// de prise de rendez-vous"): how long before a visit a patient may still
// book it. Not set: the old rule, today only from the next whole hour on.
export const BOOKING_NOTICE_OPTIONS = [0, 15, 30, 60, 120, 180, 360, 720, 1440, 2880] as const;

export const isBookingNotice = (v: unknown): v is number =>
  typeof v === "number" && (BOOKING_NOTICE_OPTIONS as readonly number[]).includes(v);

// the first Tehran day and minute a slot may start at
export type Earliest = { ymd: string; minute: number };

export const earliestBookable = (notice?: number | null, now: Date = new Date()): Earliest => {
  if (!isBookingNotice(notice)) {
    const p = tehranParts(now);
    return { ymd: p.ymd, minute: (p.hour + 1) * 60 };
  }
  const p = tehranParts(new Date(now.getTime() + notice * 60_000));
  // a slot starting in the current minute is already too late
  return { ymd: p.ymd, minute: p.hour * 60 + p.minute + (p.second > 0 ? 1 : 0) };
};

// the first minute of `ymd` a slot may start at (Infinity: none that day)
export const fromMinuteOn = (e: Earliest, ymd: string) =>
  ymd < e.ymd ? Number.POSITIVE_INFINITY : ymd === e.ymd ? e.minute : 0;

export const isTooLate = (e: Earliest, ymd: string, start: number) => start < fromMinuteOn(e, ymd);
