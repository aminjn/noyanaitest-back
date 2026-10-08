import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import ParaClinic from "../Models/Paraclinic";
import ParaClinicSamplingSettings from "../Models/ParaClinicSamplingSettings";
import LabSampling, { ILabSampling, labSamplingKinds } from "../Models/LabSampling";
import LabSamplingSlot from "../Models/LabSamplingSlot";
import Order from "../Models/Order";
import City from "../Models/Geo/City";
import Notification from "../Models/Notification";
import {
  listSamplingSlots,
  loadSamplingSettings,
  samplingCapacity,
  samplingDayWindows,
  samplingKindOpen,
} from "../Lib/labSampling";
import { tehranYmd } from "../Lib/tehranTime";

// Lab sampling appointments (2026-10, Lib/labSampling.ts): the lab's schedule
// and day agenda (paraClinic panel, /paraClinic/sampling...), and the free
// slots a buyer picks from at checkout (/cart/sampling/slots).

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- settings

export const getMySamplingSettings: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const settings = await loadSamplingSettings(req.paraClinic._id);
    const lab = await ParaClinic.findById(req.paraClinic._id)
      .select("city")
      .populate({ path: "city", select: "name" })
      .lean<{ city?: { _id: unknown; name?: string } }>();
    const cities = settings.home.cities.length
      ? await City.find({ _id: { $in: settings.home.cities } }).select("name province").lean()
      : [];
    res.status(200).json({
      message: "getMySamplingSettings",
      data: { ...settings, home: { ...settings.home, cities }, labCity: lab?.city || null },
    });
  },
);

const minute = z.number().int().min(0).max(1440);
const updateSamplingSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  hours: z
    .array(z.strictObject({ day: z.number().int().min(0).max(6), start: minute, end: minute }))
    .max(70),
  slotMinutes: z.number().int().min(5).max(240),
  capacity: z.number().int().min(1).max(100),
  closedDays: z.array(z.string().regex(YMD)).max(366),
  horizonDays: z.number().int().min(1).max(60),
  leadMinutes: z.number().int().min(0).max(2880),
  home: z.strictObject({
    enabled: z.boolean(),
    fee: z.number().min(0).max(1e10),
    cities: z.array(z.string().refine((v) => isValidObjectId(v))).max(200),
    windowMinutes: z.number().int().min(30).max(480),
    capacity: z.number().int().min(1).max(50),
  }),
});

// Saves the whole schedule. Opening ranges must start before they end and
// not overlap on the same day; the public "home sampling" badge
// (ParaClinic.onPremises) follows home.enabled.
export const updateMySamplingSettings: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const { data, success, error } = await updateSamplingSettingsSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError(error.message));
    const hours = [...data.hours].sort((a, b) => a.day - b.day || a.start - b.start);
    for (let i = 0; i < hours.length; i++) {
      if (hours[i].start >= hours[i].end)
        return next(new AppError("ساعت پایان باید بعد از ساعت شروع باشد", 400));
      const prev = hours[i - 1];
      if (prev && prev.day === hours[i].day && prev.end > hours[i].start)
        return next(new AppError("بازه‌های ساعت کاری یک روز نباید هم‌پوشانی داشته باشند", 400));
    }
    if (data.enabled && !hours.length)
      return next(new AppError("برای فعال کردن نوبت نمونه‌گیری، دست‌کم یک بازه‌ی ساعت کاری وارد کنید", 400));
    const cities = [...new Set(data.home.cities)];
    if (cities.length && (await City.countDocuments({ _id: { $in: cities }, isActive: true })) !== cities.length)
      return next(new NotFoundError("شهر"));
    await ParaClinicSamplingSettings.updateOne(
      { paraClinic: req.paraClinic._id },
      {
        $set: {
          ...data,
          hours,
          closedDays: [...new Set(data.closedDays)].sort(),
          home: { ...data.home, cities },
        },
      },
      { upsert: true, runValidators: true },
    );
    await ParaClinic.updateOne({ _id: req.paraClinic._id }, { $set: { onPremises: data.home.enabled } });
    res.status(200).json({ message: "updateMySamplingSettings" });
  },
);

// ----------------------------------------------------------------- agenda

type AgendaOrder = {
  _id: unknown;
  status: string;
  user?: { username?: string; phone?: string };
  tests?: { _id: unknown; status: string; item?: { test?: { name?: string } } }[];
};

// GET /paraClinic/sampling?date=YYYY-MM-DD - the lab's appointments of one
// Tehran day (paid orders only), and how full each slot is.
export const getMySamplingAgenda: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const ymd = typeof req.query.date === "string" && YMD.test(req.query.date) ? req.query.date : tehranYmd();
    const settings = await loadSamplingSettings(req.paraClinic._id);
    const bookings = await LabSampling.find({
      paraClinic: req.paraClinic._id,
      ymd,
      status: { $ne: "cancelled" },
    })
      .sort({ start: 1, createdAt: 1 })
      .populate([
        {
          path: "order",
          select: "status user tests",
          populate: [
            { path: "user", select: "username phone" },
            { path: "tests.item", select: "test", populate: { path: "test", select: "name" } },
          ],
        },
        {
          path: "address",
          populate: [
            { path: "city", select: "name" },
            { path: "district", select: "name" },
          ],
        },
      ])
      .lean<(ILabSampling & { order: AgendaOrder | null })[]>();
    const items = bookings
      .filter((b) => b.order && b.order.status === "paid")
      .map((b) => {
        const covered = new Set((b.lines || []).map(String));
        const order = b.order as AgendaOrder;
        return {
          _id: b._id,
          kind: b.kind,
          ymd: b.ymd,
          start: b.start,
          end: b.end,
          startsAt: b.startsAt,
          status: b.status,
          confirmedAt: b.confirmedAt,
          collectedAt: b.collectedAt,
          fee: b.fee,
          order: order._id,
          buyer: { username: order.user?.username, phone: order.user?.phone },
          address: b.address || null,
          tests: (order.tests || [])
            .filter((l) => covered.has(String(l._id)))
            .map((l) => ({ _id: l._id, name: l.item?.test?.name || "", status: l.status })),
        };
      });
    // seats per slot of the day, both kinds
    const counters = await LabSamplingSlot.find({ paraClinic: req.paraClinic._id, ymd }).lean();
    const booked = new Map(counters.map((c) => [`${c.kind}:${c.start}`, Number(c.booked) || 0]));
    const slots = labSamplingKinds.flatMap((kind) =>
      samplingKindOpen(settings, kind)
        ? samplingDayWindows(settings, kind, ymd).map(([start, end]) => ({
            kind,
            start,
            end,
            capacity: samplingCapacity(settings, kind),
            booked: booked.get(`${kind}:${start}`) || 0,
          }))
        : [],
    );
    res.status(200).json({
      message: "getMySamplingAgenda",
      data: {
        ymd,
        enabled: settings.enabled,
        closed: settings.closedDays.includes(ymd),
        items,
        slots,
      },
    });
  },
);

const mutateSamplingSchema = z.strictObject({
  action: z.enum(["confirm", "collected"]),
});

// PATCH /paraClinic/sampling/:nodeId - the lab confirms an appointment
// (that accepts every pending line it covers: the lab's answer to the order,
// Lib/orderResponse.ts) or records that the sample was taken.
export const mutateMySampling: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await mutateSamplingSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const booking = await LabSampling.findOne({ _id: nodeId, paraClinic: req.paraClinic._id }).lean<ILabSampling>();
    if (!booking) return next(new NotFoundError());
    if (booking.status !== "active")
      return next(new AppError("این نوبت نمونه‌گیری دیگر فعال نیست", 409));
    const order = await Order.findOne({ _id: booking.order, status: "paid" }).select("user").lean<{ _id: unknown; user: unknown }>();
    if (!order) return next(new NotFoundError());
    const now = new Date();
    if (data.action === "collected" && !booking.confirmedAt)
      return next(new AppError("ابتدا نوبت نمونه‌گیری را تأیید کنید", 409));
    // either action answers the lines it covers ($min keeps an earlier time)
    await Order.updateOne(
      { _id: order._id, status: "paid" },
      { $min: { "tests.$[l].acceptedAt": now } },
      { arrayFilters: [{ "l._id": { $in: booking.lines || [] }, "l.status": "pending" }] },
    );
    if (data.action === "confirm") {
      const confirmed = await LabSampling.updateOne(
        { _id: booking._id, status: "active", confirmedAt: { $exists: false } },
        { $set: { confirmedAt: now } },
      );
      if (confirmed.modifiedCount)
        await Notification.create({
          user: order.user,
          source: "System",
          title: "آزمایشگاه نوبت نمونه‌گیری شما را تأیید کرد",
          message: req.paraClinic.name || "",
          link: `/order/${String(order._id)}`,
        }).catch(() => undefined);
    } else {
      await LabSampling.updateOne(
        { _id: booking._id, status: "active", collectedAt: { $exists: false } },
        { $set: { collectedAt: now } },
      );
    }
    res.status(200).json({ message: "mutateMySampling" });
  },
);

// -------------------------------------------------------------- checkout

const slotsQuerySchema = z.object({
  paraClinic: z.string().refine((v) => isValidObjectId(v)),
  kind: z.enum(labSamplingKinds),
  from: z.string().regex(YMD).optional(),
  days: z.coerce.number().int().min(1).max(14).optional(),
});

// GET /cart/sampling/slots?paraClinic=&kind=lab|home&from=&days= - the
// lab's bookable days and slots, with the seats left in each.
export const getSamplingSlots: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await slotsQuerySchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const lab = await ParaClinic.exists({ _id: data.paraClinic, active: true });
    if (!lab) return next(new NotFoundError());
    const settings = await loadSamplingSettings(data.paraClinic);
    const days = await listSamplingSlots(settings, data.kind, { from: data.from, days: data.days });
    res.status(200).json({
      message: "getSamplingSlots",
      data: { days, horizonDays: settings.horizonDays },
    });
  },
);
