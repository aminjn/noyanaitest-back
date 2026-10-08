import mongoose, { Types } from "mongoose";
import z from "zod";
import ParaClinicSamplingSettings, {
  IParaClinicSamplingSettings,
  ISamplingHours,
  SAMPLING_DEFAULTS,
} from "../Models/ParaClinicSamplingSettings";
import LabSampling, { ILabSampling, LabSamplingKind, labSamplingKinds } from "../Models/LabSampling";
import LabSamplingSlot from "../Models/LabSamplingSlot";
import UserAddress from "../Models/UserAddress";
import Transaction from "../Models/Transaction";
import Wallet from "../Models/Wallet";
import Notification from "../Models/Notification";
import { getShiftSessionBounds } from "./shiftUtils";
import { IDoctorShift } from "../Models/DoctorShift";
import { creditEarning } from "./payoutHold";
import {
  addDaysYmd,
  diffDaysYmd,
  fromTehranWallClock,
  tehranJalaliFormat,
  tehranSaturdayDay,
  tehranYmd,
} from "./tehranTime";

// Lab sampling appointments (2026-10, owner decision).
//
// Halodoc's and SnappDoctor's lab flows: a test that needs a sample is not
// just "bought" - the patient also picks when the sample is taken, at the lab
// (a slot) or at home (a visit window at one of their addresses, for a
// fee, inside the cities the lab serves). NoyanAI copies that and keeps it
// inside the one cart order:
//
//   - the lab's schedule (Models/ParaClinicSamplingSettings.ts): weekly
//     hours cut into slots like a doctor's shift (Lib/shiftUtils.ts), but
//     each slot takes `capacity` patients, not one
//   - each test says whether it needs the lab, can be done at home, or
//     needs no appointment (ParaClinicTest.sampling)
//   - at checkout the test lines of one lab in the order share one
//     appointment (Models/LabSampling.ts); its seat is taken atomically in
//     Models/LabSamplingSlot.ts before any money moves
//   - cancelling every line it covers (seller, buyer, support, the sweeps -
//     all through Services/orderSettlementService.ts settleOrderLine), or an
//     order whose payment never went through, gives the seat back and the
//     home fee to the buyer; a fulfilled line pays the fee to the lab
//   - a booked appointment is NOT the lab's answer to the order: the
//     response deadline (Lib/orderResponse.ts) runs until the lab accepts,
//     and is brought forward to the appointment itself when that is sooner
//   - the patient (in-app + SMS) and the lab (in-app) are reminded the day
//     before

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export type SamplingSettings = {
  paraClinic: string;
  enabled: boolean;
  hours: ISamplingHours[];
  slotMinutes: number;
  capacity: number;
  closedDays: string[];
  horizonDays: number;
  leadMinutes: number;
  home: {
    enabled: boolean;
    fee: number;
    cities: string[];
    windowMinutes: number;
    capacity: number;
  };
};

const num = (value: unknown, fallback: number, min: number, max: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

// a stored document (or none) as plain settings with every default filled
export const normalizeSamplingSettings = (
  doc: Partial<IParaClinicSamplingSettings> | null | undefined,
  paraClinicId: unknown,
): SamplingSettings => {
  const home = (doc?.home || {}) as Partial<IParaClinicSamplingSettings["home"]>;
  const hours = (Array.isArray(doc?.hours) ? doc!.hours : [])
    .map((h) => ({ day: Number(h?.day), start: Number(h?.start), end: Number(h?.end) }))
    .filter(
      (h) =>
        Number.isInteger(h.day) && h.day >= 0 && h.day <= 6 &&
        Number.isFinite(h.start) && Number.isFinite(h.end) &&
        h.start >= 0 && h.end <= 1440 && h.start < h.end,
    )
    .sort((a, b) => a.day - b.day || a.start - b.start);
  return {
    paraClinic: String(paraClinicId),
    enabled: !!doc?.enabled,
    hours,
    slotMinutes: num(doc?.slotMinutes, SAMPLING_DEFAULTS.slotMinutes, 5, 240),
    capacity: num(doc?.capacity, SAMPLING_DEFAULTS.capacity, 1, 100),
    closedDays: (Array.isArray(doc?.closedDays) ? doc!.closedDays : []).filter(
      (d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d),
    ),
    horizonDays: num(doc?.horizonDays, SAMPLING_DEFAULTS.horizonDays, 1, 60),
    leadMinutes: num(doc?.leadMinutes, SAMPLING_DEFAULTS.leadMinutes, 0, 2880),
    home: {
      enabled: !!home.enabled,
      fee: num(home.fee, 0, 0, 1e10),
      cities: (Array.isArray(home.cities) ? home.cities : []).map((c) =>
        String((c as { _id?: unknown })?._id ?? c),
      ),
      windowMinutes: num(home.windowMinutes, SAMPLING_DEFAULTS.homeWindowMinutes, 30, 480),
      capacity: num(home.capacity, SAMPLING_DEFAULTS.homeCapacity, 1, 50),
    },
  };
};

export const loadSamplingSettings = async (paraClinicId: unknown): Promise<SamplingSettings> => {
  const doc = await ParaClinicSamplingSettings.findOne({ paraClinic: paraClinicId }).lean();
  return normalizeSamplingSettings(doc as Partial<IParaClinicSamplingSettings> | null, paraClinicId);
};

// the lab takes appointments of this kind at all
export const samplingKindOpen = (settings: SamplingSettings, kind: LabSamplingKind) =>
  settings.enabled && settings.hours.length > 0 && (kind === "lab" || settings.home.enabled);

export const samplingCapacity = (settings: SamplingSettings, kind: LabSamplingKind) =>
  kind === "home" ? settings.home.capacity : settings.capacity;

// the shift day index (0 = Saturday) of a Tehran "YYYY-MM-DD" day
const shiftDayOf = (ymd: string) => tehranSaturdayDay(fromTehranWallClock(ymd, 12 * 60));

// The slots (or home windows) of one Tehran day: each opening range cut like
// a doctor's shift into back-to-back pieces that end inside it.
export const samplingDayWindows = (
  settings: SamplingSettings,
  kind: LabSamplingKind,
  ymd: string,
): [number, number][] => {
  if (settings.closedDays.includes(ymd)) return [];
  const day = shiftDayOf(ymd);
  const length = kind === "home" ? settings.home.windowMinutes : settings.slotMinutes;
  const seen = new Set<number>();
  const out: [number, number][] = [];
  for (const h of settings.hours) {
    if (h.day !== day) continue;
    const bounds = getShiftSessionBounds({ start: h.start, end: h.end, duration: length, gap: 0 } as IDoctorShift);
    for (const b of bounds) {
      if (seen.has(b[0])) continue;
      seen.add(b[0]);
      out.push(b);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
};

export type SamplingSlotView = { start: number; end: number; left: number; capacity: number };
export type SamplingDayView = { ymd: string; slots: SamplingSlotView[] };

// Bookable days from `from` (Tehran "YYYY-MM-DD", default today), at most
// `days` of them, inside the lab's horizon and after its lead time. Full
// slots are listed with left = 0 so the picker can show them greyed out.
export const listSamplingSlots = async (
  settings: SamplingSettings,
  kind: LabSamplingKind,
  opts: { from?: string; days?: number; now?: Date } = {},
): Promise<SamplingDayView[]> => {
  if (!samplingKindOpen(settings, kind)) return [];
  const now = opts.now || new Date();
  const today = tehranYmd(now);
  const last = addDaysYmd(today, settings.horizonDays - 1);
  let from = opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : today;
  if (diffDaysYmd(today, from) < 0) from = today;
  const span = Math.max(1, Math.min(14, Number(opts.days) || 7));
  const earliest = now.getTime() + settings.leadMinutes * MINUTE;
  const capacity = samplingCapacity(settings, kind);
  const days: SamplingDayView[] = [];
  for (let i = 0; i < span; i++) {
    const ymd = addDaysYmd(from, i);
    if (diffDaysYmd(ymd, last) < 0) break;
    const slots = samplingDayWindows(settings, kind, ymd)
      .filter(([start]) => fromTehranWallClock(ymd, start).getTime() >= earliest)
      .map(([start, end]) => ({ start, end, left: capacity, capacity }));
    days.push({ ymd, slots });
  }
  const ymds = days.filter((d) => d.slots.length).map((d) => d.ymd);
  if (ymds.length) {
    const taken = await LabSamplingSlot.find({
      paraClinic: settings.paraClinic,
      kind,
      ymd: { $in: ymds },
    }).lean();
    const byKey = new Map(taken.map((t) => [`${t.ymd}:${t.start}`, Number(t.booked) || 0]));
    for (const d of days)
      for (const s of d.slots) s.left = Math.max(0, capacity - (byKey.get(`${d.ymd}:${s.start}`) || 0));
  }
  return days;
};

// one chosen slot, re-checked against the schedule (hours, closed days,
// lead time, horizon); null when it is not a slot of this lab
export const resolveSamplingSlot = (
  settings: SamplingSettings,
  kind: LabSamplingKind,
  ymd: string,
  start: number,
  now = new Date(),
): { start: number; end: number; startsAt: Date } | null => {
  if (!samplingKindOpen(settings, kind) || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const today = tehranYmd(now);
  const ahead = diffDaysYmd(today, ymd);
  if (ahead < 0 || ahead > settings.horizonDays - 1) return null;
  const window = samplingDayWindows(settings, kind, ymd).find(([s]) => s === start);
  if (!window) return null;
  const startsAt = fromTehranWallClock(ymd, window[0]);
  if (startsAt.getTime() < now.getTime() + settings.leadMinutes * MINUTE) return null;
  return { start: window[0], end: window[1], startsAt };
};

// ------------------------------------------------------------------ seats

// Takes one seat of a slot: the counter row is created if missing, then
// incremented only while under capacity - in a single update, so the last
// seat goes to exactly one buyer.
const takeSeat = async (
  paraClinic: unknown,
  kind: LabSamplingKind,
  ymd: string,
  start: number,
  capacity: number,
): Promise<boolean> => {
  const key = { paraClinic, kind, ymd, start };
  try {
    await LabSamplingSlot.updateOne(key, { $setOnInsert: { booked: 0 } }, { upsert: true });
  } catch (err) {
    // two first bookings of the same slot: the other one created the row
    if ((err as { code?: number })?.code !== 11000) throw err;
  }
  const res = await LabSamplingSlot.updateOne(
    { ...key, booked: { $lt: capacity } },
    { $inc: { booked: 1 } },
  );
  return res.modifiedCount === 1;
};

const giveSeat = async (b: Pick<ILabSampling, "paraClinic" | "kind" | "ymd" | "start">) => {
  await LabSamplingSlot.updateOne(
    {
      paraClinic: (b.paraClinic as unknown as { _id?: unknown })?._id ?? b.paraClinic,
      kind: b.kind,
      ymd: b.ymd,
      start: b.start,
      booked: { $gt: 0 },
    },
    { $inc: { booked: -1 } },
  );
};

// active -> cancelled, then the seat back; the status flip is the lock, so a
// seat is never given back twice
export const cancelSamplingBooking = async (bookingId: unknown): Promise<ILabSampling | null> => {
  const booking = await LabSampling.findOneAndUpdate(
    { _id: bookingId, status: "active" },
    { $set: { status: "cancelled", cancelledAt: new Date() } },
    { new: true },
  ).lean<ILabSampling>();
  if (booking) await giveSeat(booking);
  return booking;
};

// an order that was never paid (gateway failed or abandoned, wallet debit
// failed): its appointments go and their seats come back
export const releaseOrderSamplings = async (orderId: unknown): Promise<void> => {
  try {
    const ids = await LabSampling.find({ order: orderId, status: "active" }).distinct("_id");
    for (const id of ids) await cancelSamplingBooking(id);
  } catch (err) {
    console.log("[sampling] releasing order appointments failed:", err);
  }
};

// ------------------------------------------------------------- checkout

export const samplingChoiceSchema = z.strictObject({
  paraClinic: z.string().regex(/^[0-9a-fA-F]{24}$/),
  kind: z.enum(labSamplingKinds),
  ymd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.number().int().min(0).max(1440),
  // home sampling: one of the buyer's saved addresses
  address: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
});
export type SamplingChoice = z.infer<typeof samplingChoiceSchema>;

type CartTestLine = {
  item?: {
    _id?: unknown;
    sampling?: string;
    paraClinic?: { _id?: unknown; name?: string; city?: unknown } | null;
    test?: { name?: string } | null;
  } | null;
};

export type CartSamplingGroup = {
  paraClinic: string;
  name?: string;
  // ParaClinicTest ids of this lab's lines that need the appointment
  itemIds: string[];
  tests: string[];
  lab: boolean;
  home: boolean;
  homeFee: number;
  settings: SamplingSettings;
  labCity?: string;
};

// The labs of a (populated) cart whose tests need an appointment: lines
// with sampling "lab" / "labOrHome", at a lab whose schedule is on. Home is
// offered only when every such line of that lab may be done at home (one
// in-lab-only test means the patient goes to the lab anyway).
export const cartSamplingGroups = async (cart: unknown): Promise<CartSamplingGroup[]> => {
  const lines = ((cart as { tests?: CartTestLine[] } | null)?.tests || []) as CartTestLine[];
  const groups = new Map<string, Omit<CartSamplingGroup, "settings" | "lab" | "home" | "homeFee"> & { homeOk: boolean }>();
  for (const line of Array.isArray(lines) ? lines : []) {
    const item = line?.item;
    const lab = item?.paraClinic;
    if (!item?._id || !lab?._id) continue;
    const mode = item.sampling || "lab";
    if (mode === "none") continue;
    const key = String(lab._id);
    const group = groups.get(key) || {
      paraClinic: key,
      name: lab.name,
      itemIds: [],
      tests: [],
      homeOk: true,
      labCity: lab.city ? String((lab.city as { _id?: unknown })?._id ?? lab.city) : undefined,
    };
    group.itemIds.push(String(item._id));
    if (item.test?.name) group.tests.push(item.test.name);
    if (mode !== "labOrHome") group.homeOk = false;
    groups.set(key, group);
  }
  const out: CartSamplingGroup[] = [];
  for (const group of groups.values()) {
    const settings = await loadSamplingSettings(group.paraClinic);
    // no schedule yet: the tests sell as before (the patient goes in
    // during the lab's business hours)
    if (!samplingKindOpen(settings, "lab")) continue;
    const { homeOk, ...rest } = group;
    out.push({
      ...rest,
      settings,
      lab: true,
      home: homeOk && samplingKindOpen(settings, "home"),
      homeFee: settings.home.fee,
    });
  }
  return out;
};

// the cities a lab's home sampling serves: its list, or else its own city
const homeCities = (group: CartSamplingGroup) =>
  group.settings.home.cities.length ? group.settings.home.cities : group.labCity ? [group.labCity] : [];

export type SamplingPlan = {
  paraClinic: string;
  kind: LabSamplingKind;
  ymd: string;
  start: number;
  end: number;
  startsAt: Date;
  fee: number;
  address?: string;
  itemIds: string[];
  capacity: number;
};

// The buyer's choices checked against the cart and the labs' schedules. No
// seat is taken here (getCartSummary may call it too): bookCartSamplings
// does that.
export const planCartSamplings = async (
  cart: unknown,
  choices: SamplingChoice[] | undefined,
  userId: unknown,
  now = new Date(),
): Promise<{ error: string } | { plans: SamplingPlan[]; fee: number }> => {
  const groups = await cartSamplingGroups(cart);
  const plans: SamplingPlan[] = [];
  for (const group of groups) {
    const choice = (choices || []).find((c) => c.paraClinic === group.paraClinic);
    if (!choice)
      return { error: "برای آزمایش‌هایی که نمونه‌گیری دارند، زمان نمونه‌گیری را انتخاب کنید" };
    if (choice.kind === "home" && !group.home)
      return { error: "نمونه‌گیری در منزل برای این آزمایش‌ها ممکن نیست" };
    let address: string | undefined;
    if (choice.kind === "home") {
      if (!choice.address) return { error: "برای نمونه‌گیری در منزل، آدرس را انتخاب کنید" };
      const doc = await UserAddress.findOne({
        _id: choice.address,
        user: userId,
        archived: { $ne: true },
      })
        .select("city")
        .lean<{ _id: unknown; city?: unknown }>();
      if (!doc) return { error: "آدرس انتخاب‌شده معتبر نیست" };
      const city = doc.city ? String((doc.city as { _id?: unknown })?._id ?? doc.city) : "";
      if (!city || !homeCities(group).includes(city))
        return { error: "نمونه‌گیری در منزل به این آدرس ارائه نمی‌شود" };
      address = String(doc._id);
    }
    const slot = resolveSamplingSlot(group.settings, choice.kind, choice.ymd, choice.start, now);
    if (!slot)
      return { error: "این زمان نمونه‌گیری دیگر در دسترس نیست؛ زمان دیگری انتخاب کنید" };
    plans.push({
      paraClinic: group.paraClinic,
      kind: choice.kind,
      ymd: choice.ymd,
      ...slot,
      fee: choice.kind === "home" ? group.homeFee : 0,
      address,
      itemIds: group.itemIds,
      capacity: samplingCapacity(group.settings, choice.kind),
    });
  }
  return { plans, fee: plans.reduce((sum, p) => sum + p.fee, 0) };
};

// Takes the seats of the planned appointments for the order about to be
// created (`orderId` is chosen by the caller), and links the order's test
// lines to them in place (each line gets its own _id now, so the
// appointment can name it). All or nothing: a full slot gives back the
// seats already taken.
export const bookCartSamplings = async (
  orderId: Types.ObjectId,
  userId: unknown,
  plans: SamplingPlan[],
  testLines: Record<string, unknown>[],
): Promise<{ error: string } | { bookings: unknown[] }> => {
  const done: unknown[] = [];
  for (const plan of plans) {
    const ok = await takeSeat(plan.paraClinic, plan.kind, plan.ymd, plan.start, plan.capacity);
    if (!ok) {
      for (const id of done) await cancelSamplingBooking(id);
      return { error: "ظرفیت این زمان نمونه‌گیری پر شد؛ زمان دیگری انتخاب کنید" };
    }
    const bookingId = new Types.ObjectId();
    const lineIds: Types.ObjectId[] = [];
    for (const line of testLines) {
      if (!plan.itemIds.includes(String(line.item))) continue;
      if (!line._id) line._id = new Types.ObjectId();
      line.sampling = bookingId;
      line.samplingAt = plan.startsAt;
      lineIds.push(line._id as Types.ObjectId);
    }
    try {
      await LabSampling.create({
        _id: bookingId,
        paraClinic: plan.paraClinic,
        order: orderId,
        user: userId,
        kind: plan.kind,
        ymd: plan.ymd,
        start: plan.start,
        end: plan.end,
        startsAt: plan.startsAt,
        lines: lineIds,
        fee: plan.fee,
        address: plan.address,
      });
    } catch (err) {
      await giveSeat({ paraClinic: plan.paraClinic as never, kind: plan.kind, ymd: plan.ymd, start: plan.start });
      for (const id of done) await cancelSamplingBooking(id);
      throw err;
    }
    done.push(bookingId);
  }
  return { bookings: done };
};

// --------------------------------------------------------- settlement

const idOf = (value: unknown) => String((value as { _id?: unknown })?._id ?? value);

type OrderTestLine = { _id: unknown; item: unknown; status: string; sampling?: unknown };

// After a test line of an order was fulfilled or cancelled
// (Services/orderSettlementService.ts settleOrderLine): its appointment
// follows its lines.
//   - every line cancelled -> the appointment is cancelled, its seat comes
//     back, and the buyer gets the home-sampling fee back
//   - a line fulfilled     -> the lab earns the home-sampling fee (once);
//     with no line left pending the appointment is done
// Idempotent: the status flip and `feeSettled` are each claimed atomically.
export const settleLineSampling = async (orderId: unknown, itemId: string): Promise<void> => {
  const Order = mongoose.model("Order");
  const order = await Order.findById(orderId)
    .select("user tests")
    .lean<{ _id: unknown; user: unknown; tests?: OrderTestLine[] }>();
  const line = (order?.tests || []).find((l) => idOf(l.item) === itemId);
  if (!order || !line?.sampling) return;
  const booking = await LabSampling.findById(line.sampling).lean<ILabSampling>();
  if (!booking) return;
  const covered = new Set((booking.lines || []).map(String));
  const lines = (order.tests || []).filter((l) => covered.has(String(l._id)));
  if (!lines.length) return;
  const fulfilled = lines.some((l) => l.status === "fulfilled");
  const pending = lines.some((l) => l.status === "pending");

  if (fulfilled) {
    if (booking.fee > 0) {
      const claimed = await LabSampling.findOneAndUpdate(
        { _id: booking._id, feeSettled: { $exists: false } },
        { $set: { feeSettled: "lab" } },
      );
      if (claimed) {
        const lab = await mongoose
          .model("ParaClinic")
          .findById(booking.paraClinic)
          .select("user")
          .lean<{ _id: unknown; user?: unknown }>();
        if (lab?.user)
          await creditEarning(idOf(lab.user), booking.fee, {
            order: order._id,
            orderItem: booking._id,
            grossAmount: booking.fee,
            commission: 0,
            commissionPercent: 0,
            tax: 0,
            paraClinic: lab._id,
          } as never);
      }
    }
    if (!pending)
      await LabSampling.updateOne({ _id: booking._id, status: "active" }, { $set: { status: "done" } });
    return;
  }

  if (!pending && lines.every((l) => l.status === "cancelled")) {
    await cancelSamplingBooking(booking._id);
    if (booking.fee > 0) {
      const claimed = await LabSampling.findOneAndUpdate(
        { _id: booking._id, feeSettled: { $exists: false } },
        { $set: { feeSettled: "buyer" } },
      );
      if (!claimed) return;
      const buyer = idOf(order.user);
      const wallet = await Wallet.findOneAndUpdate(
        { user: buyer },
        { user: buyer },
        { upsert: true, new: true },
      );
      await Wallet.findByIdAndUpdate(wallet._id, { $inc: { balance: booking.fee } });
      await Transaction.create({
        user: buyer,
        amount: booking.fee,
        order: order._id,
        orderItem: booking._id,
      });
    }
  }
};

// The lab accepted lines of the order (the order page's "accept" or the
// agenda's "confirm"): their appointment is confirmed.
export const confirmLineSampling = async (orderId: unknown, itemId: string): Promise<void> => {
  try {
    const order = await mongoose
      .model("Order")
      .findById(orderId)
      .select("tests")
      .lean<{ tests?: OrderTestLine[] }>();
    const line = (order?.tests || []).find((l) => idOf(l.item) === itemId);
    if (!line?.sampling) return;
    await LabSampling.updateOne(
      { _id: line.sampling, status: "active", confirmedAt: { $exists: false } },
      { $set: { confirmedAt: new Date() } },
    );
  } catch (err) {
    console.log("[sampling] confirming the appointment failed:", err);
  }
};

// "1405/07/18 08:30 - 08:45" for texts (Tehran, Jalali)
export const samplingWhenText = (b: Pick<ILabSampling, "startsAt" | "ymd" | "end">) => {
  const end = fromTehranWallClock(b.ymd, b.end);
  return `${tehranJalaliFormat(b.startsAt, "jYYYY/jMM/jDD HH:mm")} - ${tehranJalaliFormat(end, "HH:mm")}`;
};

// ------------------------------------------------------------ the sweeps

// The day-before reminder: an appointment starting in the next 24 hours,
// booked more than 12 hours before it (one booked for tomorrow morning
// tonight needs no reminder), of a paid order - once (remindedAt is claimed
// atomically). The patient gets an in-app notice and the
// labSamplingReminderUser SMS; the lab an in-app notice.
const remindDue = async (now: Date) => {
  const { notifyWithSms } = await import("../Services/notificationSmsService");
  const due = await LabSampling.find({
    status: "active",
    remindedAt: { $exists: false },
    startsAt: { $gt: now, $lte: new Date(now.getTime() + 24 * HOUR) },
  })
    .limit(300)
    .lean<ILabSampling[]>();
  let sent = 0;
  for (const b of due) {
    if (new Date(b.createdAt).getTime() > new Date(b.startsAt).getTime() - 12 * HOUR) continue;
    const order = await mongoose.model("Order").findById(b.order).select("status").lean<{ status?: string }>();
    if (order?.status !== "paid") continue;
    const claimed = await LabSampling.updateOne(
      { _id: b._id, status: "active", remindedAt: { $exists: false } },
      { $set: { remindedAt: new Date() } },
    );
    if (!claimed.modifiedCount) continue;
    sent += 1;
    const lab = await mongoose
      .model("ParaClinic")
      .findById(b.paraClinic)
      .select("name user")
      .lean<{ name?: string; user?: unknown }>();
    const when = samplingWhenText(b);
    const labName = lab?.name || "";
    await Notification.create({
      user: idOf(b.user),
      source: "System",
      title: "یادآوری نوبت نمونه‌گیری",
      message:
        b.kind === "home"
          ? `نمونه‌گیری در منزل توسط «${labName}»: ${when}`
          : `نمونه‌گیری در «${labName}»: ${when}`,
      link: `/order/${idOf(b.order)}`,
    }).catch(() => undefined);
    notifyWithSms("labSamplingReminderUser", idOf(b.user), {
      labName,
      date: tehranJalaliFormat(b.startsAt, "jYYYY/jMM/jDD"),
      time: tehranJalaliFormat(b.startsAt, "HH:mm"),
    });
    if (lab?.user)
      await Notification.create({
        user: idOf(lab.user),
        source: "System",
        title: "نوبت نمونه‌گیری فردا",
        message: b.confirmedAt
          ? `نوبت نمونه‌گیری در ${when}`
          : `نوبت نمونه‌گیری در ${when}؛ هنوز آن را تأیید نکرده‌اید`,
        link: `/paraClinicPanel/sampling?date=${b.ymd}`,
      }).catch(() => undefined);
  }
  return sent;
};

// Safety net for a hook that did not run (a crash between steps): an
// appointment of an order that is cancelled or gone gives its seat back, and
// one whose lines all ended is settled.
const reconcile = async (now: Date) => {
  const stale = await LabSampling.find({
    status: "active",
    createdAt: { $lt: new Date(now.getTime() - 30 * MINUTE) },
  })
    .select("order lines")
    .limit(500)
    .lean<ILabSampling[]>();
  if (!stale.length) return;
  const orders = await mongoose
    .model("Order")
    .find({ _id: { $in: stale.map((b) => b.order) } })
    .select("status tests")
    .lean<{ _id: unknown; status: string; tests?: OrderTestLine[] }[]>();
  const byId = new Map(orders.map((o) => [String(o._id), o]));
  for (const b of stale) {
    const order = byId.get(String(b.order));
    if (!order || order.status === "cancelled") {
      await cancelSamplingBooking(b._id);
      continue;
    }
    if (order.status !== "paid") continue;
    const covered = new Set((b.lines || []).map(String));
    const lines = (order.tests || []).filter((l) => covered.has(String(l._id)));
    if (lines.length && !lines.some((l) => l.status === "pending"))
      await settleLineSampling(order._id, idOf(lines[0].item));
  }
};

export const runLabSamplingSweep = async (now = new Date()) => {
  const reminded = await remindDue(now);
  await reconcile(now);
  if (reminded) console.log(`[sampling] ${reminded} reminders sent`);
};

export const startLabSamplingJob = (intervalMs = 15 * MINUTE): void => {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    runLabSamplingSweep()
      .catch((err) => console.log("[sampling] sweep failed:", err))
      .finally(() => {
        running = false;
      });
  }, intervalMs).unref?.();
};

// ------------------------------------------------------------ migration

// Once (2026-10): a lab that had ticked «نمونه‌گیری در محل» gets home
// sampling switched on in its new settings (its own city, no fee) so the
// public badge, now derived from these settings, keeps saying the same.
// Labs that already have settings are left alone, so a re-run changes
// nothing.
export const migrateLabSamplingSettings = async (): Promise<number> => {
  const labs = await mongoose
    .model("ParaClinic")
    .find({ onPremises: true })
    .select("_id")
    .lean<{ _id: unknown }[]>();
  let created = 0;
  for (const lab of labs) {
    const res = await ParaClinicSamplingSettings.updateOne(
      { paraClinic: lab._id },
      { $setOnInsert: { paraClinic: lab._id, home: { enabled: true, fee: 0, cities: [] } } },
      { upsert: true },
    );
    if (res.upsertedCount) created += 1;
  }
  return created;
};

// What the checkout shows for the cart (GET /cart/summary): each lab whose
// tests need an appointment, whether home sampling is possible, its fee and
// the cities it serves (the picker greys out other addresses).
export const describeCartSamplings = async (cart: unknown) => {
  try {
    const groups = await cartSamplingGroups(cart);
    return groups.map((g) => ({
      paraClinic: g.paraClinic,
      name: g.name,
      tests: g.tests,
      home: g.home,
      homeFee: g.home ? g.homeFee : 0,
      homeCities: g.home ? homeCities(g) : [],
    }));
  } catch (err) {
    console.log("[sampling] describing the cart failed:", err);
    return [];
  }
};

// the id of an order about to be created, so its appointments can name it
export const newOrderId = () => new Types.ObjectId();
