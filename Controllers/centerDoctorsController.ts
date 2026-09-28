import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId, Model } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import ClinicDoctor from "../Models/ClinicDoctor";
import HospitalDoctor from "../Models/HospitalDoctor";
import DoctorJoinClinicRequest from "../Models/DoctorJoinClinicRequest";
import DoctorJoinHospitalRequest from "../Models/DoctorJoinHospitalRequest";
import DoctorProfile from "../Models/DoctorProfile";
import Notification from "../Models/Notification";
import Office from "../Models/Office";
import Reservation from "../Models/Reservation";

// The clinic/hospital side of doctor membership (2026-09). Until now only
// the super admin could approve a doctor's request to join; the center
// itself had no page. Clinic and hospital share the same shape
// (membership model + join-request model keyed by `clinic`/`hospital`), so
// one set of handlers serves both.
type Center = "clinic" | "hospital";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;
const cfg: Record<Center, { key: Center; member: AnyModel; request: AnyModel; title: string }> = {
  clinic: { key: "clinic", member: ClinicDoctor as AnyModel, request: DoctorJoinClinicRequest as AnyModel, title: "کلینیک" },
  hospital: { key: "hospital", member: HospitalDoctor as AnyModel, request: DoctorJoinHospitalRequest as AnyModel, title: "بیمارستان" },
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
    const [members, requests] = await Promise.all([
      c.member.find({ [c.key]: me._id }).populate(doctorFields),
      c.request
        .find({ [c.key]: me._id, status: "Pending" })
        .sort({ submittedAt: -1 })
        .populate(doctorFields),
    ]);
    res.status(200).json({
      message: "getMyDoctors",
      data: {
        members: members.filter((m) => !!m.doctor),
        // incoming = the doctor asked, the center answers; outgoing = the
        // center invited, waiting on the doctor
        incoming: requests.filter((r) => r.submissionParty === "DoctorProfile" && !!r.doctor),
        outgoing: requests.filter((r) => r.submissionParty !== "DoctorProfile" && !!r.doctor),
      },
    });
  });

const answerSchema = z.strictObject({ status: z.enum(["Approved", "Rejected"]) });

export const answerJoinRequest = (center: Center): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const c = cfg[center];
    const me = centerOf(req, center);
    if (!me) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) return next(new BadInputError());
    const node = await c.request.findOne({
      _id: nodeId,
      [c.key]: me._id,
      submissionParty: "DoctorProfile",
      status: "Pending",
    });
    if (!node) return next(new NotFoundError());
    if (parsed.data.status === "Approved")
      await c.member.findOneAndUpdate(
        { [c.key]: me._id, doctor: node.doctor },
        { [c.key]: me._id, doctor: node.doctor },
        { upsert: true },
      );
    await c.request.findByIdAndUpdate(node._id, {
      status: parsed.data.status,
      statusLastChangedAt: new Date(),
    });
    // let the doctor know
    const doctor = await DoctorProfile.findById(node.doctor).select("user");
    if (doctor?.user)
      await Notification.create({
        user: doctor.user,
        title:
          parsed.data.status === "Approved"
            ? `عضویت شما در ${c.title} تأیید شد`
            : `درخواست عضویت شما در ${c.title} رد شد`,
        message: me.name ? `${c.title} ${me.name}` : c.title,
        link: `/doctorpanel/${center}`,
      }).catch(() => undefined);
    res.status(200).json({ message: "answerJoinRequest" });
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
    // the doctor's offices at this centre no longer count as the centre's
    await Office.updateMany(
      { doctor: node.doctor, [c.key]: me._id },
      { $unset: { [c.key]: 1 } },
    );
    res.status(200).json({ message: "removeMyDoctor" });
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
