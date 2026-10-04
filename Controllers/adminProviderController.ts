import { notifyWithSms } from "../Services/notificationSmsService";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId, Model, Types } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import { AccessLevelModel } from "../Models/AccessLevel";
import * as authController from "./authController";
import DoctorProfile from "../Models/DoctorProfile";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import Pharmacy from "../Models/Pharmacy";
import ParaClinic from "../Models/Paraclinic";
import Insurance from "../Models/Insurance";
import User from "../Models/User";
import Notification from "../Models/Notification";
import DoctorShift from "../Models/DoctorShift";
import Office from "../Models/Office";
import Reservation from "../Models/Reservation";
import DoctorAvailability from "../Models/DoctorAvailability";
import Secretary from "../Models/Secretary";
import SecretaryRequest from "../Models/SecretaryRequest";
import DoctorProfileLicense from "../Models/DoctorProfileLicense";
import InPersonSettings from "../Models/InPersonSettings";
import SipCallSettings from "../Models/SipCallSettings";
import TextChatSettings from "../Models/TextChatSettings";
import VideoCallSettings from "../Models/VideoCallSettings";
import VoiceCallSettings from "../Models/voiceCallSetrtings";
import PhoneConsultSettings from "../Models/DoctorPhoneConsultSettings";
import { doctorSessionTypes, DoctorSessionType } from "../Models/DoctorSession";
import { getShiftSessionBounds } from "../Lib/shiftUtils";
import { saturdayBasedDay, todayStart } from "../Lib/dateUtils";
import { IDoctorShift } from "../Models/DoctorShift";

// Provider back office (2026-10 admin audit P2-9, P2-11, P3-19):
//  - suspend / reactivate a doctor or centre, with a reason the owner is
//    told (Lib/providerStatus.ts explains how a suspension hides the page
//    and stops bookings / orders),
//  - set or clear the panel owner through one audited route, for all six
//    provider kinds,
//  - the doctor's schedule and access, read-only, so support can answer
//    "why can't I book this doctor?".
// Every write here is a state-changing /admin request, so it is recorded by
// Services/adminAudit.ts (PUT /admin/<kind>/<id>/... -> "update" of <kind>,
// shown on the record's overview).

type ProviderKind = {
  model: Model<any>;
  activeField: "active" | "isActive";
  access: AccessLevelModel;
  title: string;
  panel: string;
  name: (node: any) => string;
};

const personName = (node?: { firstName?: string; lastName?: string } | null) =>
  [node?.firstName, node?.lastName].filter(Boolean).join(" ");

export const providerKinds: Record<string, ProviderKind> = {
  doctorprofile: {
    model: DoctorProfile,
    activeField: "active",
    access: "DoctorProfile",
    title: "پروفایل پزشک",
    panel: "/doctorpanel",
    name: personName,
  },
  clinic: {
    model: Clinic,
    activeField: "active",
    access: "Clinic",
    title: "کلینیک",
    panel: "/clinicpanel",
    name: (n) => n.name,
  },
  hospital: {
    model: Hospital,
    activeField: "isActive",
    access: "Hospital",
    title: "بیمارستان",
    panel: "/hospitalpanel",
    name: (n) => n.name,
  },
  pharmacy: {
    model: Pharmacy,
    activeField: "active",
    access: "Pharmacy",
    title: "داروخانه",
    panel: "/pharmacypanel",
    name: (n) => n.name,
  },
  paraClinic: {
    model: ParaClinic,
    activeField: "active",
    access: "ParaClinic",
    title: "مرکز پاراکلینیک",
    panel: "/paraClinicPanel",
    name: (n) => n.name,
  },
  insurance: {
    model: Insurance,
    activeField: "active",
    access: "Insurance",
    title: "بیمه",
    panel: "/insurancepanel",
    name: (n) => n.name,
  },
};

export const providerKindPattern = Object.keys(providerKinds).join("|");

// the kind's own access level ("update" to change, "readOne" to look)
export const providerPermission =
  (op: "update" | "readOne"): RequestHandler =>
  (req, res, next) => {
    const kind = providerKinds[req.params.kind];
    if (!kind) return next(new NotFoundError());
    return authController.hasPermission({ model: kind.access, op })(req, res, next);
  };

const notify = (user: unknown, title: string, message: string, link?: string) =>
  user
    ? Notification.create({ user, source: "System", title, message, ...(link ? { link } : {}) }).catch(
        (err) => console.log("[adminProvider] failed to notify the owner:", err),
      )
    : Promise.resolve();

// ---------------------------------------------------------------- status

const statusSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("suspended"),
    reason: z.string().trim().min(3).max(1000),
  }),
  z.object({ status: z.literal("active") }),
]);

// PUT /admin/:kind/:nodeId/status  {status: "suspended", reason} | {status: "active"}
// Idempotent: suspending a suspended provider only updates the reason (the
// owner is not told twice); reactivating an active one changes nothing.
export const setProviderStatus: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const kind = providerKinds[req.params.kind];
    const { nodeId } = req.params;
    if (!kind || !isValidObjectId(nodeId)) return next(new NotFoundError());
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success)
      return next(
        new AppError("برای تعلیق، دلیل آن را بنویسید (حداقل ۳ حرف)", 400),
      );
    const node: any = await kind.model
      .findById(nodeId)
      .select(`user status ${kind.activeField} activeBeforeSuspension firstName lastName name`)
      .lean();
    if (!node) return next(new NotFoundError());
    const wasSuspended = node.status === "suspended";
    const now = new Date();
    const name = kind.name(node) || kind.title;

    if (parsed.data.status === "suspended") {
      // raw update: the model hooks keep these fields away from every
      // other write path (Lib/providerStatus.ts)
      await kind.model.collection.updateOne(
        { _id: new Types.ObjectId(nodeId) },
        {
          $set: {
            status: "suspended",
            statusReason: parsed.data.reason,
            ...(wasSuspended
              ? {}
              : {
                  statusChangedAt: now,
                  activeBeforeSuspension: !!node[kind.activeField],
                  [kind.activeField]: false,
                }),
          },
        },
      );
      if (!wasSuspended) {
        await notify(
          node.user,
          `${kind.title} شما تعلیق شد`,
          `صفحه‌ی «${name}» از سایت برداشته شد و نوبت یا سفارش تازه نمی‌گیرد. دلیل: ${parsed.data.reason}. نوبت‌ها و سفارش‌های ثبت‌شده سر جایشان هستند. برای رفع تعلیق با پشتیبانی تماس بگیرید.`,
          kind.panel,
        );
        if (node.user)
          notifyWithSms("providerSuspendedProvider", node.user, {
            kind: kind.title,
            name,
            reason: parsed.data.reason,
          });
      }
    } else {
      if (!wasSuspended)
        return res.status(200).json({ message: "setProviderStatus", data: { status: "active" } });
      await kind.model.collection.updateOne(
        { _id: new Types.ObjectId(nodeId) },
        {
          $set: {
            status: "active",
            statusChangedAt: now,
            // a draft stays a draft; a published page comes back
            [kind.activeField]: node.activeBeforeSuspension !== false,
          },
          $unset: { statusReason: 1, activeBeforeSuspension: 1 },
        },
      );
      await notify(
        node.user,
        `تعلیق ${kind.title} شما برداشته شد`,
        `«${name}» دوباره روی سایت است و می‌تواند نوبت و سفارش بگیرد.`,
        kind.panel,
      );
      if (node.user)
        notifyWithSms("providerReinstatedProvider", node.user, { kind: kind.title, name });
    }
    res.status(200).json({
      message: "setProviderStatus",
      data: { status: parsed.data.status },
    });
  },
);

// ---------------------------------------------------------------- owner

// PUT /admin/:kind/:nodeId/owner  {user: "<id>"} sets, {user: null} clears.
// Also PUT /admin/pharmacy/:nodeId and /admin/paraClinic/:nodeId (clear),
// like the older doctor / clinic / hospital / insurance clear routes.
// One account owns at most one provider of a kind (unique on the model), so
// an account that already owns another one is refused, not moved.
export const setProviderOwner: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const kind = providerKinds[req.params.kind];
    const { nodeId } = req.params;
    if (!kind || !isValidObjectId(nodeId)) return next(new NotFoundError());
    const raw = req.path.endsWith("/owner") ? req.body?.user : null;
    const userId = raw === "" || raw === undefined ? null : raw;
    if (userId !== null && (typeof userId !== "string" || !isValidObjectId(userId)))
      return next(new BadInputError());
    const node: any = await kind.model
      .findById(nodeId)
      .select("user firstName lastName name")
      .lean();
    if (!node) return next(new NotFoundError());
    const name = kind.name(node) || kind.title;

    if (userId === null) {
      if (node.user) await kind.model.updateOne({ _id: nodeId }, { $unset: { user: 1 } });
      return res.status(200).json({ message: "setProviderOwner", data: { user: null } });
    }

    if (String(node.user || "") === userId)
      return res.status(200).json({ message: "setProviderOwner", data: { user: userId } });
    const user = await User.findById(userId).select("status").lean<{ status?: string }>();
    if (!user || user.status === "deleted") return next(new NotFoundError("کاربر"));
    const other: any = await kind.model
      .findOne({ user: userId, _id: { $ne: nodeId } })
      .select("_id")
      .lean();
    if (other)
      return next(
        new AppError(
          `این حساب از قبل مالک پنل ${kind.title} دیگری است؛ اول آن را جدا کنید`,
          400,
        ),
      );
    // a doctor profile with an owner is a claimed, bookable profile (the
    // become-doctor approval does the same)
    await kind.model.updateOne(
      { _id: nodeId },
      { $set: { user: userId, ...(req.params.kind === "doctorprofile" ? { claimed: true } : {}) } },
    );
    await notify(
      userId,
      `شما مالک پنل ${kind.title} شدید`,
      `مدیریت «${name}» به حساب شما سپرده شد. از پنل وارد شوید.`,
      kind.panel,
    );
    notifyWithSms("providerOwnerAssignedProvider", userId, { kind: kind.title, name });
    res.status(200).json({ message: "setProviderOwner", data: { user: userId } });
  },
);

// ---------------------------------------------------------------- schedule

const SCHEDULE_DAYS = 14;

const sessionSettingsModels: Record<DoctorSessionType, Model<any>> = {
  inPerson: InPersonSettings,
  sipCall: SipCallSettings,
  textChat: TextChatSettings,
  videoCall: VideoCallSettings,
  voiceCall: VoiceCallSettings,
  phone: PhoneConsultSettings,
};

// minutes since midnight, Tehran wall-clock time (as the booking guard)
const tehranMinutesNow = () => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value) || 0;
  return get("hour") * 60 + get("minute");
};

const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

// GET /admin/doctorprofile/:nodeId/schedule
// Everything that decides whether a patient can book this doctor, in one
// read-only answer: the blockers, the session types and their settings,
// offices, weekly shifts, the next 14 days (slots from the shifts, minus
// booked ones, and what the public booking page has stored), secretaries.
export const getDoctorSchedule: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const doctor: any = await DoctorProfile.findById(nodeId)
      .select("active claimed status statusReason user firstName lastName")
      .lean();
    if (!doctor) return next(new NotFoundError());
    const id = new Types.ObjectId(nodeId);

    // days the way the booking flow stores them (Lib/dateUtils.ts
    // dateStartOfDay, bookingController.submitBookingNew)
    const today = todayStart();
    const rangeStart = today;
    const rangeEnd = addDays(today, SCHEDULE_DAYS);
    const nowMinutes = tehranMinutesNow();

    const [shiftsRaw, offices, settingsList, reservations, stored, secretaries, pendingSecretaries, license] =
      await Promise.all([
        DoctorShift.find({ doctor: id })
          .populate({ path: "office", select: "name active address clinic hospital" })
          .sort({ day: 1, start: 1 })
          .lean(),
        Office.find({ doctor: id })
          .populate([
            { path: "clinic", select: "name" },
            { path: "hospital", select: "name" },
          ])
          .select("name address tel active clinic hospital order location")
          .sort({ order: 1, _id: 1 })
          .lean(),
        Promise.all(
          doctorSessionTypes.map(async (type) => {
            const doc: any = await sessionSettingsModels[type]
              .findOne({ doctor: id })
              .select("active price")
              .lean();
            return {
              type,
              exists: !!doc,
              active: !!doc?.active,
              price: typeof doc?.price === "number" ? doc.price : null,
            };
          }),
        ),
        Reservation.find({
          doctor: id,
          status: { $ne: "cancelled" },
          date: { $gte: rangeStart, $lt: rangeEnd },
        })
          .select("date start end status sessionType")
          .lean(),
        DoctorAvailability.find({ doctor: id, date: { $gte: rangeStart, $lt: rangeEnd } })
          .select("date bounds")
          .lean(),
        Secretary.find({ owner: id, ownerPath: "DoctorProfile" })
          .populate([
            { path: "secretary", select: "phone username status" },
            { path: "acl", select: "name" },
          ])
          .lean(),
        SecretaryRequest.countDocuments({ owner: id, ownerPath: "DoctorProfile", status: "Pending" }),
        DoctorProfileLicense.findOne({ owner: id }).select("displayName expiresAt").lean(),
      ]);

    const shifts = (shiftsRaw as any[]).map((shift) => ({
      _id: String(shift._id),
      name: shift.name || "",
      day: shift.day,
      start: shift.start,
      end: shift.end,
      duration: shift.duration,
      gap: shift.gap || 0,
      sessionTypes: shift.sessionTypes || [],
      patientTypes: shift.patientTypes || [],
      office: shift.office
        ? { _id: String(shift.office._id), name: shift.office.name || "", active: !!shift.office.active }
        : null,
      slots: getShiftSessionBounds(shift as IDoctorShift).length,
    }));

    const settings = settingsList.map((row) => ({
      ...row,
      bookable: row.active && !!row.price,
      shiftCount: shifts.filter((s) => s.sessionTypes.includes(row.type)).length,
    }));

    const inDay = (value: unknown, start: Date, end: Date) => {
      const time = new Date(value as string).getTime();
      return time >= start.getTime() && time < end.getTime();
    };
    const days = Array.from({ length: SCHEDULE_DAYS }, (_, offset) => {
      const start = addDays(today, offset);
      const end = addDays(today, offset + 1);
      const weekday = saturdayBasedDay(start.getDay());
      const booked = (reservations as any[]).filter((r) => inDay(r.date, start, end));
      const dayShifts = (shiftsRaw as any[]).filter((s) => s.day === weekday);
      let total = 0;
      let free = 0;
      for (const shift of dayShifts)
        for (const [from, to] of getShiftSessionBounds(shift as IDoctorShift)) {
          total += 1;
          // today: a slot whose hour has started can't be booked
          if (offset === 0 && Math.floor(from / 60) <= Math.floor(nowMinutes / 60)) continue;
          if (booked.some((r) => !(r.end <= from || r.start >= to))) continue;
          free += 1;
        }
      const storedDay = (stored as any[]).find((row) => inDay(row.date, start, end));
      return {
        date: start,
        weekday,
        shifts: dayShifts.length,
        totalSlots: total,
        freeSlots: free,
        booked: booked.length,
        publishedSlots: storedDay ? (storedDay.bounds || []).length : 0,
      };
    });

    // the reasons a patient can't book, most fundamental first
    const blockers: { key: string; text: string }[] = [];
    if (doctor.status === "suspended")
      blockers.push({ key: "suspended", text: `پروفایل تعلیق شده است: ${doctor.statusReason || ""}` });
    else if (!doctor.active) blockers.push({ key: "inactive", text: "پروفایل منتشر نشده (پیش‌نویس) است" });
    if (doctor.claimed === false) blockers.push({ key: "unclaimed", text: "پروفایل ادعانشده (از فهرست قدیمی) است و نوبت نمی‌گیرد" });
    if (!doctor.user) blockers.push({ key: "noOwner", text: "پروفایل مالک پنل ندارد؛ درآمد نوبت به کسی پرداخت نمی‌شود" });
    if (!shifts.length) blockers.push({ key: "noShifts", text: "هیچ شیفتی تعریف نشده است" });
    if (!settings.some((s) => s.bookable))
      blockers.push({ key: "noSessionType", text: "هیچ نوع ویزیتی فعال و قیمت‌دار نیست" });
    else if (!settings.some((s) => s.bookable && s.shiftCount > 0))
      blockers.push({ key: "noShiftForType", text: "نوع ویزیت فعال در هیچ شیفتی نیست" });
    if (shifts.some((s) => s.office && !s.office.active))
      blockers.push({ key: "inactiveOffice", text: "بعضی شیفت‌ها در مطبی غیرفعال هستند" });
    if (shifts.length && !days.some((d) => d.freeSlots > 0))
      blockers.push({ key: "fullyBooked", text: `در ${SCHEDULE_DAYS} روز آینده نوبت خالی نیست` });
    if (days.some((d) => d.freeSlots > 0) && !days.some((d) => d.publishedSlots > 0))
      blockers.push({
        key: "notPublished",
        text: "نوبت خالی هست اما در صفحه‌ی نوبت‌دهی منتشر نشده؛ پزشک باید شیفت‌ها را یک بار ذخیره کند",
      });

    const lic: any = license;
    res.status(200).json({
      message: "getDoctorSchedule",
      data: {
        data: {
          doctor: {
            _id: String(doctor._id),
            name: personName(doctor),
            active: !!doctor.active,
            claimed: doctor.claimed !== false,
            status: doctor.status || "active",
            statusReason: doctor.statusReason || "",
            hasOwner: !!doctor.user,
          },
          blockers,
          settings,
          offices: (offices as any[]).map((office) => ({
            _id: String(office._id),
            name: office.name || "",
            address: office.address || "",
            tel: office.tel || "",
            active: !!office.active,
            coordinates: Array.isArray(office.location?.coordinates) ? office.location.coordinates : null,
            centre: office.clinic?.name
              ? { kind: "clinic", _id: String(office.clinic._id), name: office.clinic.name }
              : office.hospital?.name
                ? { kind: "hospital", _id: String(office.hospital._id), name: office.hospital.name }
                : null,
          })),
          shifts,
          days,
          secretaries: (secretaries as any[]).map((row) => ({
            _id: String(row._id),
            displayName: row.displayName || "",
            phone: row.secretary?.phone || "",
            username: row.secretary?.username || "",
            userId: row.secretary?._id ? String(row.secretary._id) : null,
            userStatus: row.secretary?.status || "active",
            acl: row.acl?.name || "",
          })),
          pendingSecretaries,
          license: lic
            ? {
                displayName: lic.displayName || "",
                expiresAt: lic.expiresAt || null,
                isExpired: !!lic.expiresAt && new Date(lic.expiresAt) < new Date(),
              }
            : null,
        },
      },
    });
  },
);
