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
    res.status(200).json({ message: "removeMyDoctor" });
  });
