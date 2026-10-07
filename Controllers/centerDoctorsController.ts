import { addTehranDays, parseTehranDay, startOfTehranDay } from "../Lib/tehranTime";
import { notifyWithSms } from "../Services/notificationSmsService";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId, Model } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import ClinicDoctor from "../Models/ClinicDoctor";
import HospitalDoctor from "../Models/HospitalDoctor";
import ClinicDepartment from "../Models/ClinicDepatment";
import HospitalDepartment from "../Models/HospitalDepartment";
import DoctorJoinClinicRequest from "../Models/DoctorJoinClinicRequest";
import DoctorJoinHospitalRequest from "../Models/DoctorJoinHospitalRequest";
import DoctorProfile from "../Models/DoctorProfile";
import Notification from "../Models/Notification";
import Office from "../Models/Office";
import Reservation from "../Models/Reservation";
import { endCentreMembership } from "../Lib/centreMembership";
import { escapeRegex } from "../Lib/helpers";
import { resolveMyLicenseModules as resolveDoctorModules } from "./doctorController";

// The clinic/hospital side of doctor membership (2026-09). Until now only
// the super admin could approve a doctor's request to join; the center
// itself had no page. Clinic and hospital share the same shape
// (membership model + join-request model keyed by `clinic`/`hospital`), so
// one set of handlers serves both.
type Center = "clinic" | "hospital";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;
const cfg: Record<Center, { key: Center; member: AnyModel; request: AnyModel; department: AnyModel; title: string }> = {
  clinic: {
    key: "clinic",
    member: ClinicDoctor as AnyModel,
    request: DoctorJoinClinicRequest as AnyModel,
    department: ClinicDepartment as AnyModel,
    title: "کلینیک",
  },
  hospital: {
    key: "hospital",
    member: HospitalDoctor as AnyModel,
    request: DoctorJoinHospitalRequest as AnyModel,
    department: HospitalDepartment as AnyModel,
    title: "بیمارستان",
  },
};

const doctorFields = {
  path: "doctor",
  select: "firstName lastName avatar slug mainSpeciality user",
  populate: { path: "mainSpeciality", select: "name" },
};

const centerOf = (req: Request, center: Center) => req[center] as { _id: unknown; name?: string } | undefined;

export const getMyDoctors = (center: Center): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const c = cfg[center];
    const me = centerOf(req, center);
    if (!me) return next(new MiddlewareError());
    const [members, requests, departments] = await Promise.all([
      c.member
        .find({ [c.key]: me._id })
        .populate([doctorFields, { path: "department", select: "name" }]),
      c.request
        .find({ [c.key]: me._id, status: "Pending" })
        .sort({ submittedAt: -1 })
        .populate(doctorFields),
      c.department
        .find({ [c.key]: me._id })
        .sort({ order: 1, _id: 1 })
        .select("name summary phone active order")
        .lean(),
    ]);
    res.status(200).json({
      message: "getMyDoctors",
      data: {
        members: members.filter((m) => !!m.doctor),
        departments,
        // incoming = the doctor asked, the center answers; outgoing = the
        // center invited, waiting on the doctor
        incoming: requests.filter((r) => r.submissionParty === "DoctorProfile" && !!r.doctor),
        outgoing: requests.filter((r) => r.submissionParty !== "DoctorProfile" && !!r.doctor),
      },
    });
  });

// a rejection says why (the doctor is told), like the admin queue
const answerSchema = z
  .strictObject({
    status: z.enum(["Approved", "Rejected"]),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((d) => d.status !== "Rejected" || (d.reason?.length ?? 0) >= 3);

export const answerJoinRequest = (center: Center): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const c = cfg[center];
    const me = centerOf(req, center);
    if (!me) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) return next(new AppError("دلیل رد درخواست را بنویسید", 400));
    // one-way: only a pending request the doctor sent is answered here (the
    // admin queue decides the same ones; whoever is first wins)
    const node = await c.request.findOneAndUpdate(
      {
        _id: nodeId,
        [c.key]: me._id,
        submissionParty: "DoctorProfile",
        status: "Pending",
      },
      {
        $set: {
          status: parsed.data.status,
          decidedAt: new Date(),
          statusLastChangedAt: new Date(),
          ...(parsed.data.status === "Rejected" ? { rejectReason: parsed.data.reason } : {}),
        },
      },
    );
    if (!node) return next(new NotFoundError());
    if (parsed.data.status === "Approved")
      await c.member.findOneAndUpdate(
        { [c.key]: me._id, doctor: node.doctor },
        { [c.key]: me._id, doctor: node.doctor },
        { upsert: true },
      );
    // let the doctor know
    const doctor = await DoctorProfile.findById(node.doctor).select("user");
    if (doctor?.user)
      await Notification.create({
        user: doctor.user,
        source: "System",
        title:
          parsed.data.status === "Approved"
            ? `عضویت شما در ${c.title} تأیید شد`
            : `درخواست عضویت شما در ${c.title} رد شد`,
        message:
          parsed.data.status === "Rejected" && parsed.data.reason
            ? parsed.data.reason
            : me.name
              ? `${c.title} ${me.name}`
              : c.title,
        link: `/doctorpanel/${center}`,
      }).catch(() => undefined);
    if (doctor?.user) {
      const centre = me.name ? `${c.title} ${me.name}` : c.title;
      if (parsed.data.status === "Approved")
        notifyWithSms("centreMembershipApprovedDoctor", doctor.user, { centre });
      else
        notifyWithSms("centreMembershipRejectedDoctor", doctor.user, {
          centre,
          reason: parsed.data.reason || "",
        });
    }
    res.status(200).json({ message: "answerJoinRequest" });
  });

// GET /<center>/doctor/search?q= - doctors the centre can invite: active,
// claimed profiles that aren't members yet
export const searchDoctorsToInvite = (center: Center): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const c = cfg[center];
    const me = centerOf(req, center);
    if (!me) return next(new MiddlewareError());
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 60) : "";
    if (q.length < 2) return res.status(200).json({ message: "searchDoctorsToInvite", data: [] });
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const members = await c.member.find({ [c.key]: me._id }).distinct("doctor");
    const data = await DoctorProfile.find({
      _id: { $nin: members },
      active: true,
      claimed: { $ne: false },
      status: { $ne: "suspended" },
      $or: [{ firstName: rx }, { lastName: rx }, { medicalSystemCode: rx }],
    })
      .select("firstName lastName avatar slug mainSpeciality")
      .populate({ path: "mainSpeciality", select: "name" })
      .limit(10)
      .lean();
    res.status(200).json({ message: "searchDoctorsToInvite", data });
  });

const inviteSchema = z.strictObject({
  doctor: z.string().refine(isValidObjectId),
  message: z.string().trim().max(500).optional(),
});

// POST /<center>/doctor/invite - the centre invites a doctor; the doctor
// accepts or declines from their panel (doctorController's join answers)
export const inviteDoctor = (center: Center): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const c = cfg[center];
    const me = centerOf(req, center);
    if (!me) return next(new MiddlewareError());
    const parsed = inviteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError());
    const doctor = await DoctorProfile.findOne({
      _id: parsed.data.doctor,
      active: true,
      claimed: { $ne: false },
    }).select("user");
    if (!doctor) return next(new NotFoundError("پزشک"));
    // working with a clinic / hospital is a module of the doctor's plan
    // (Lib/licenseTiers.ts): a doctor without it could not open, accept or
    // decline the invite, which then waited forever
    if (!(await resolveDoctorModules(doctor._id)).includes(center === "clinic" ? "clinics" : "hospitals"))
      return next(new AppError("پلن فعلی این پزشک همکاری با مراکز را ندارد؛ پزشک باید پلن خود را ارتقا دهد", 400));
    if (await c.member.exists({ [c.key]: me._id, doctor: doctor._id }))
      return next(new AppError("این پزشک همین حالا عضو است", 400));
    if (await c.request.exists({ [c.key]: me._id, doctor: doctor._id, status: "Pending" }))
      return next(new AppError("برای این پزشک درخواست در انتظار وجود دارد", 400));
    // one row per doctor + centre (unique index): a doctor who left, or
    // whose earlier request was declined, is invited on the same row - a
    // create() hit a duplicate-key error there
    await c.request.updateOne(
      { [c.key]: me._id, doctor: doctor._id },
      {
        $set: {
          submissionParty: center === "clinic" ? "Clinic" : "Hospital",
          status: "Pending",
          submittedAt: new Date(),
          statusLastChangedAt: new Date(),
          message: parsed.data.message,
        },
        $unset: { rejectReason: 1, decidedAt: 1 },
      },
      { upsert: true, runValidators: true },
    );
    if (doctor.user)
      await Notification.create({
        user: doctor.user,
        source: "System",
        title: `دعوت به همکاری از طرف ${c.title}`,
        message: me.name ? `${c.title} ${me.name}` : c.title,
        link: `/doctorpanel/${center}`,
      }).catch(() => undefined);
    if (doctor.user)
      notifyWithSms("centreInvitationDoctor", doctor.user, {
        centre: me.name ? `${c.title} ${me.name}` : c.title,
      });
    res.status(200).json({ message: "inviteDoctor" });
  });

export const removeMyDoctor = (center: Center): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const c = cfg[center];
    const me = centerOf(req, center);
    if (!me) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await c.member.findOneAndDelete({ _id: nodeId, [c.key]: me._id });
    if (!node) return next(new NotFoundError());
    // the doctor's offices at this centre no longer count as the centre's,
    // a hospital's manager is cleared, the join request is "Left"
    await endCentreMembership(center, node.doctor, me._id);
    res.status(200).json({ message: "removeMyDoctor" });
    // the doctor is told; their booked visits stay (they are the doctor's)
    const doctor = await DoctorProfile.findById(node.doctor).select("user");
    if (doctor?.user)
      await Notification.create({
        user: doctor.user,
        source: "System",
        title: `عضویت شما در ${c.title} پایان یافت`,
        message: me.name ? `${c.title} ${me.name}` : c.title,
        link: `/doctorpanel/${center}`,
      }).catch(() => undefined);
    if (doctor?.user)
      notifyWithSms("centreMembershipEndedDoctor", doctor.user, {
        centre: me.name ? `${c.title} ${me.name}` : c.title,
      });
  });

// DELETE /<center>/doctor/invite/:nodeId - the centre withdraws an invite
// the doctor has not answered (2026-10): it used to wait on the doctor
// forever. Only the centre's own, still-pending invite; the row goes (no
// decision was made on it).
export const withdrawInvite = (center: Center): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const c = cfg[center];
    const me = centerOf(req, center);
    if (!me) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await c.request.findOneAndDelete({
      _id: nodeId,
      [c.key]: me._id,
      submissionParty: { $ne: "DoctorProfile" },
      status: "Pending",
    });
    if (!node) return next(new NotFoundError());
    res.status(200).json({ message: "withdrawInvite" });
  });

// The centre's own departments (2026-10). A clinic's departments / a
// hospital's wards were only editable by the super admin, although the
// approval notice tells the new owner to complete them in the panel; the
// public page lists each with its doctors (Doctolib / Practo group a
// practice's practitioners the same way). A department the centre adds is
// shown at once; it can be hidden without being deleted.
const departmentSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(30).optional(),
  active: z.boolean().optional(),
  order: z.coerce.number().int().min(0).max(10000).optional(),
});

const sameName = (name: string) => new RegExp(`^${escapeRegex(name)}$`, "i");

export const createMyDepartment = (center: Center): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const c = cfg[center];
    const me = centerOf(req, center);
    if (!me) return next(new MiddlewareError());
    const parsed = departmentSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError());
    if (await c.department.exists({ [c.key]: me._id, name: sameName(parsed.data.name) }))
      return next(new AppError("بخشی با این نام وجود دارد", 400));
    const count = await c.department.countDocuments({ [c.key]: me._id });
    const node = await c.department.create({
      active: true,
      order: count,
      ...parsed.data,
      [c.key]: me._id,
    });
    res.status(200).json({ message: "createMyDepartment", data: { _id: node._id } });
  });

export const updateMyDepartment = (center: Center): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const c = cfg[center];
    const me = centerOf(req, center);
    if (!me) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = departmentSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError());
    if (
      parsed.data.name &&
      (await c.department.exists({
        [c.key]: me._id,
        _id: { $ne: nodeId },
        name: sameName(parsed.data.name),
      }))
    )
      return next(new AppError("بخشی با این نام وجود دارد", 400));
    const node = await c.department.findOneAndUpdate(
      { _id: nodeId, [c.key]: me._id },
      { $set: parsed.data },
      { runValidators: true },
    );
    if (!node) return next(new NotFoundError());
    res.status(200).json({ message: "updateMyDepartment" });
  });

// its doctors stay members of the centre, without a department
export const deleteMyDepartment = (center: Center): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const c = cfg[center];
    const me = centerOf(req, center);
    if (!me) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await c.department.findOneAndDelete({ _id: nodeId, [c.key]: me._id });
    if (!node) return next(new NotFoundError());
    await c.member.updateMany(
      { [c.key]: me._id, department: node._id },
      { $unset: { department: 1 } },
    );
    res.status(200).json({ message: "deleteMyDepartment" });
  });

// PATCH /<center>/doctor/:nodeId {department: id | null} - which of the
// centre's departments a member works in (none: the centre's general list)
const memberDepartmentSchema = z.strictObject({
  department: z.union([z.string().refine(isValidObjectId), z.null()]),
});
export const setMemberDepartment = (center: Center): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const c = cfg[center];
    const me = centerOf(req, center);
    if (!me) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = memberDepartmentSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError());
    const { department } = parsed.data;
    // only one of this centre's own departments
    if (department && !(await c.department.exists({ _id: department, [c.key]: me._id })))
      return next(new AppError("بخش پیدا نشد", 404));
    const node = await c.member.findOneAndUpdate(
      { _id: nodeId, [c.key]: me._id },
      department ? { $set: { department } } : { $unset: { department: 1 } },
    );
    if (!node) return next(new NotFoundError());
    res.status(200).json({ message: "setMemberDepartment" });
  });

const STATS_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const tehranDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tehran",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// GET /<center>/reservation/stats - visits per day over the last 30 days at
// the offices doctors have linked to this centre (Office.clinic /
// Office.hospital), by appointment day; cancelled / failed ones excluded. `offices`
// is how many offices are linked, so the page can explain an empty chart.
export const getMyVisitStats = (center: Center): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const c = cfg[center];
    const me = centerOf(req, center);
    if (!me) return next(new MiddlewareError());
    const offices = await Office.find({ [c.key]: me._id }).distinct("_id");
    const keys: string[] = [];
    for (let i = STATS_DAYS - 1; i >= 0; i--)
      keys.push(tehranDay.format(new Date(Date.now() - i * DAY)));
    const byDay = new Map(keys.map((key) => [key, 0]));
    if (offices.length) {
      const reservations = await Reservation.find({
        office: { $in: offices },
        status: { $nin: ["cancelled", "error"] },
        date: { $gte: new Date(Date.now() - (STATS_DAYS + 1) * DAY), $lte: new Date() },
      })
        .select("date")
        .lean();
      for (const r of reservations as { date?: Date }[]) {
        if (!r.date) continue;
        const key = tehranDay.format(new Date(r.date));
        if (byDay.has(key)) byDay.set(key, (byDay.get(key) || 0) + 1);
      }
    }
    const series = keys.map((date) => ({ date, visits: byDay.get(date) || 0 }));
    res.status(200).json({
      message: "getMyVisitStats",
      data: {
        days: STATS_DAYS,
        offices: offices.length,
        series,
        totals: { visits: series.reduce((sum, p) => sum + p.visits, 0) },
      },
    });
  });

// GET /<center>/reservation?from=YYYY-MM-DD&to=YYYY-MM-DD&doctor=<id>
// The centre's agenda (2026-10): every visit at an office its doctors linked
// to the centre (Office.clinic / Office.hospital), for the front desk, like
// Doctolib's shared calendar for a multi-practitioner practice. Read-only:
// the doctor's own desk moves or cancels a visit. Default range: today and
// the next 14 days; at most 62 days.
const ymdDay = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  // Tehran midnight of the day (Lib/tehranTime.ts)
  return parseTehranDay(value);
};

export const getMyReservations = (center: Center): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const c = cfg[center];
    const me = centerOf(req, center);
    if (!me) return next(new MiddlewareError());
    const today = startOfTehranDay();
    const from = ymdDay(req.query.from) || today;
    let to = ymdDay(req.query.to) || addTehranDays(from, 14);
    if (to < from) to = from;
    if (to.getTime() - from.getTime() > 62 * DAY) to = addTehranDays(from, 62);
    const end = addTehranDays(to, 1);
    const officeFilter: Record<string, unknown> = { [c.key]: me._id };
    if (typeof req.query.doctor === "string" && isValidObjectId(req.query.doctor))
      officeFilter.doctor = req.query.doctor;
    const offices = await Office.find(officeFilter).distinct("_id");
    const [items, doctors] = await Promise.all([
      offices.length
        ? Reservation.find({ office: { $in: offices }, date: { $gte: from, $lt: end } })
            .sort({ date: 1, start: 1 })
            .limit(1000)
            .select("date start end status sessionType source doctor patient user office")
            .populate([
              { path: "doctor", select: "firstName lastName slug" },
              { path: "patient", select: "givenName lastName" },
              { path: "user", select: "phone" },
              { path: "office", select: "name" },
            ])
            .lean()
        : [],
      c.member
        .find({ [c.key]: me._id })
        .populate({ path: "doctor", select: "firstName lastName" })
        .lean(),
    ]);
    res.status(200).json({
      message: "getMyReservations",
      data: {
        from,
        to,
        offices: offices.length,
        items,
        doctors: (doctors as { doctor?: { _id: unknown; firstName?: string; lastName?: string } }[])
          .map((m) => m.doctor)
          .filter(Boolean),
      },
    });
  });
