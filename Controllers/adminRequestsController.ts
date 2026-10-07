import { notifyWithSms } from "../Services/notificationSmsService";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { Model, isValidObjectId } from "mongoose";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import { AccessError, BadInputError, NotFoundError } from "../Lib/AppError";
import { AccessLevelModel } from "../Models/AccessLevel";
import UserAccessLevel from "../Models/UserAccessLevel";
import Notification from "../Models/Notification";
import BecomeDoctorRequest from "../Models/BecomeDoctorRequest";
import BecomePharmacyRequest from "../Models/BecomePharmacyRequest";
import BecomeClinicRequest from "../Models/BecomeClinicRequest";
import BecomeHospitalRequest from "../Models/BecomeHospitalRequest";
import BecomeParaClinicRequest from "../Models/BecomeParaClinicRequest";
import BecomeInsuranceRequest from "../Models/BecomeInsuranceRequest";
import ClinicAdditionRequest from "../Models/ClinicAdditionRequest";
import HospitalAdditionRequest from "../Models/HospitalAdditionRequest";
import PharmacyAdditionRequest from "../Models/PharmacyAdditionRequest";
import InsuranceAdditionRequest from "../Models/InsuranceAdditionRequest";
import DoctorJoinClinicRequest from "../Models/DoctorJoinClinicRequest";
import DoctorJoinHospitalRequest from "../Models/DoctorJoinHospitalRequest";
import DoctorProfile from "../Models/DoctorProfile";
import BizCampaign from "../Models/BizCampaign";
import BizTemplate from "../Models/BizTemplate";
import Pharmacy from "../Models/Pharmacy";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import ParaClinic from "../Models/Paraclinic";
import Insurance from "../Models/Insurance";

// One provider-verification queue (2026-09), like the back offices of
// Doctolib / Zocdoc / Practo: every "become X", "add this centre" and
// "doctor joins a centre" request in one list, filtered by group, kind and
// status, oldest pending first. The requests keep their own models; this
// reads them through one shape and owns the one-way state changes that used
// to be a free status select (reject with a reason the applicant is told,
// reopen a rejected one). Approving stays with each kind's own flow
// (adminEntityController), which creates the centre / profile / membership.

// "campaign" (2026-10): a provider's SMS campaign waiting for its text to be
// cleared (Lib/business/campaign.ts); approving sends it.
// "smsTemplate" (2026-10): a CRM SMS template (Models/BizTemplate.ts) whose
// text the automations and one-off sends use once it is cleared.
export const requestGroups = ["become", "addition", "join", "campaign", "smsTemplate"] as const;
export type RequestGroup = (typeof requestGroups)[number];

export type KindConfig = {
  model: Model<any>;
  access: AccessLevelModel;
  // the admin page that shows (and approves) one request
  detail: (id: string) => string;
  title: (doc: any) => string;
  // who is told about a decision: a User id, or a DoctorProfile to resolve
  applicant: (doc: any) => { user?: unknown; doctor?: unknown; org?: { model: Model<any>; id: unknown } };
  pending: string[];
  // the statuses the "done" tab shows (default Approved / Done)
  done?: string[];
  populate?: string[];
  label: string;
  // only these documents are the admin's to decide (2026-10): a doctor's
  // own join request, not a centre's invite that waits on the doctor
  match?: Record<string, unknown>;
};

const nameOf = (v: any) => (v && typeof v === "object" ? v.name : "") || "";
const doctorName = (d: any) =>
  d && typeof d === "object" ? `${d.firstName || ""} ${d.lastName || ""}`.trim() : "";

const kinds: Record<RequestGroup, Record<string, KindConfig>> = {
  // filled below, once campaignKind exists
  campaign: {},
  smsTemplate: {},
  become: {
    doctor: {
      model: BecomeDoctorRequest,
      access: "BecomeDoctorRequest",
      detail: (id) => `/becomedoctor/${id}`,
      title: (d) => `${d.firstName || ""} ${d.lastName || ""}`.trim(),
      applicant: (d) => ({ user: d.user }),
      pending: ["Pending"],
      populate: ["user"],
      label: "پزشک",
    },
    pharmacy: {
      model: BecomePharmacyRequest,
      access: "BecomePharmacyRequest",
      detail: (id) => `/becomepharmacy/${id}`,
      title: (d) => d.name || "",
      applicant: (d) => ({ user: d.user }),
      pending: ["Pending"],
      populate: ["user"],
      label: "داروخانه",
    },
    clinic: {
      model: BecomeClinicRequest,
      access: "BecomeClinicRequest",
      detail: (id) => `/becomeclinic/${id}`,
      title: (d) => d.name || "",
      applicant: (d) => ({ user: d.user }),
      pending: ["Pending"],
      populate: ["user"],
      label: "کلینیک",
    },
    hospital: {
      model: BecomeHospitalRequest,
      access: "BecomeHospitalRequest",
      detail: (id) => `/becomehospital/${id}`,
      title: (d) => d.name || "",
      applicant: (d) => ({ user: d.user }),
      pending: ["Pending"],
      populate: ["user"],
      label: "بیمارستان",
    },
    paraClinic: {
      model: BecomeParaClinicRequest,
      access: "BecomeParaClinicRequest",
      detail: (id) => `/becomeParaClinic/${id}`,
      title: (d) => d.name || "",
      applicant: (d) => ({ user: d.user }),
      pending: ["Pending"],
      populate: ["user"],
      label: "پاراکلینیک",
    },
    insurance: {
      model: BecomeInsuranceRequest,
      access: "BecomeInsuranceRequest",
      detail: (id) => `/becomeinsurance/${id}`,
      title: (d) => d.name || "",
      applicant: (d) => ({ user: d.user }),
      pending: ["Pending"],
      populate: ["user"],
      label: "بیمه",
    },
  },
  addition: {
    clinic: {
      model: ClinicAdditionRequest,
      access: "ClinicAdditionRequest",
      detail: (id) => `/clinicaddition?open=${id}`,
      title: (d) => d.clinicName || "",
      applicant: (d) => ({ doctor: d.submittedBy }),
      pending: ["Pending", "Proccessing"],
      populate: ["submittedBy"],
      label: "کلینیک",
    },
    hospital: {
      model: HospitalAdditionRequest,
      access: "HospitalAdditionRequest",
      detail: (id) => `/hospitaladdition?open=${id}`,
      title: (d) => d.hospitalName || "",
      applicant: (d) => ({ doctor: d.submittedBy }),
      pending: ["Pending", "Proccessing"],
      populate: ["submittedBy"],
      label: "بیمارستان",
    },
    pharmacy: {
      model: PharmacyAdditionRequest,
      access: "PharmacyAdditionRequest",
      detail: (id) => `/pharmacyaddition?open=${id}`,
      title: (d) => d.name || "",
      applicant: (d) => ({ doctor: d.submittedBy }),
      pending: ["Pending", "Proccessing"],
      populate: ["submittedBy"],
      label: "داروخانه",
    },
    insurance: {
      model: InsuranceAdditionRequest,
      access: "InsuranceAdditionRequest",
      detail: (id) => `/insuranceaddition?open=${id}`,
      title: (d) => d.name || "",
      applicant: (d) => ({ doctor: d.submittedBy }),
      pending: ["Pending", "Proccessing"],
      populate: ["submittedBy"],
      label: "بیمه",
    },
  },
  join: {
    clinic: {
      model: DoctorJoinClinicRequest,
      access: "DoctorJoinClinic",
      detail: (id) => `/doctorjoinclinic?open=${id}`,
      title: (d) => [doctorName(d.doctor), nameOf(d.clinic)].filter(Boolean).join(" ← "),
      applicant: (d) => ({ doctor: d.doctor }),
      pending: ["Pending"],
      populate: ["doctor", "clinic"],
      // a membership that ended later is still a decided request
      done: ["Approved", "Left"],
      match: { submissionParty: "DoctorProfile" },
      label: "کلینیک",
    },
    hospital: {
      model: DoctorJoinHospitalRequest,
      access: "DoctorJoinHospital",
      detail: (id) => `/doctorjoinhospital?open=${id}`,
      title: (d) => [doctorName(d.doctor), nameOf(d.hospital)].filter(Boolean).join(" ← "),
      applicant: (d) => ({ doctor: d.doctor }),
      pending: ["Pending"],
      populate: ["doctor", "hospital"],
      // a membership that ended later is still a decided request
      done: ["Approved", "Left"],
      match: { submissionParty: "DoctorProfile" },
      label: "بیمارستان",
    },
  },
};

const campaignKind = (kind: string, org: Model<any>, label: string): KindConfig => ({
  model: BizCampaign,
  access: "Advertisement",
  detail: (id) => `/smscampaign/${id}`,
  title: (d) => `${d.name || ""} · ${d.recipients || 0}`,
  applicant: (d) => ({ org: { model: org, id: d.ownerId } }),
  pending: ["Pending"],
  done: ["Approved", "Sending", "Sent"],
  match: { ownerKind: kind },
  label,
});
kinds.campaign = {
  doctor: campaignKind("doctor", DoctorProfile, "پزشک"),
  pharmacy: campaignKind("pharmacy", Pharmacy, "داروخانه"),
  clinic: campaignKind("clinic", Clinic, "کلینیک"),
  hospital: campaignKind("hospital", Hospital, "بیمارستان"),
  paraClinic: campaignKind("paraClinic", ParaClinic, "پاراکلینیک"),
  insurance: campaignKind("insurance", Insurance, "بیمه"),
};

const templateKind = (kind: string, org: Model<any>, label: string): KindConfig => ({
  model: BizTemplate,
  access: "Advertisement",
  detail: (id) => `/smstemplate/${id}`,
  title: (d) => d.name || "",
  applicant: (d) => ({ org: { model: org, id: d.ownerId } }),
  pending: ["Pending"],
  done: ["Approved"],
  match: { ownerKind: kind },
  label,
});
kinds.smsTemplate = {
  doctor: templateKind("doctor", DoctorProfile, "پزشک"),
  pharmacy: templateKind("pharmacy", Pharmacy, "داروخانه"),
  clinic: templateKind("clinic", Clinic, "کلینیک"),
  hospital: templateKind("hospital", Hospital, "بیمارستان"),
  paraClinic: templateKind("paraClinic", ParaClinic, "پاراکلینیک"),
  insurance: templateKind("insurance", Insurance, "بیمه"),
};

const isGroup = (v: unknown): v is RequestGroup =>
  typeof v === "string" && (requestGroups as readonly string[]).includes(v);

// the kinds this staff member may see (a super admin sees all)
const allowedKinds = async (req: Request, op: "read" | "update") => {
  const all = requestGroups.flatMap((group) =>
    Object.keys(kinds[group]).map((kind) => ({ group, kind })),
  );
  if (req.user?.role === "admin") return all;
  if (req.user?.role !== "notadmin") return [];
  const access = await UserAccessLevel.findOne({ user: req.user._id }).populate("accessLevel");
  const level = access?.accessLevel as unknown as
    | Record<string, Record<string, boolean> | undefined>
    | undefined;
  return all.filter(({ group, kind }) => !!level?.[kinds[group][kind].access]?.[op]);
};

const dateOf = (d: any): Date => d.createdAt || d.submittedAt || d._id?.getTimestamp?.();

const row = (group: RequestGroup, kind: string, d: any) => {
  const cfg = kinds[group][kind];
  const applicant = cfg.applicant(d);
  const user = applicant.user as any;
  const doctor = applicant.doctor as any;
  return {
    _id: String(d._id),
    group,
    kind,
    title: cfg.title(d),
    status: d.status,
    isPending: cfg.pending.includes(d.status),
    rejectReason: d.rejectReason || "",
    applicant:
      user && typeof user === "object"
        ? { phone: user.phone, user: String(user._id) }
        : doctor && typeof doctor === "object"
          ? { name: doctorName(doctor), doctor: String(doctor._id) }
          : null,
    createdAt: dateOf(d),
    detail: cfg.detail(String(d._id)),
  };
};

// GET /admin/requests?group=&kind=&status=pending|rejected|done|all
export const listRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response) => {
    const group = isGroup(req.query.group) ? req.query.group : undefined;
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    const allowed = (await allowedKinds(req, "read")).filter(
      (k) => (!group || k.group === group) && (!kind || k.kind === kind),
    );
    const lists = await Promise.all(
      allowed.map(async ({ group: g, kind: k }) => {
        const cfg = kinds[g][k];
        const filter =
          status === "pending"
            ? { status: { $in: cfg.pending } }
            : status === "rejected"
              ? { status: "Rejected" }
              : status === "done"
                ? { status: { $in: cfg.done || ["Approved", "Done"] } }
                : {};
        let q = cfg.model.find({ ...filter, ...cfg.match }).sort({ _id: -1 }).limit(500);
        for (const path of cfg.populate || [])
          q = q.populate({ path, select: "phone name firstName lastName" });
        const docs = await q.lean();
        return docs.map((d: any) => row(g, k, d));
      }),
    );
    const data = lists
      .flat()
      // oldest pending first (who has waited longest), then newest
      .sort((a, b) =>
        a.isPending !== b.isPending
          ? a.isPending ? -1 : 1
          : a.isPending
            ? +new Date(a.createdAt) - +new Date(b.createdAt)
            : +new Date(b.createdAt) - +new Date(a.createdAt),
      );
    res.status(200).json({ message: "listRequests", data });
  },
);

// GET /admin/requests/counts - pending count per group/kind (tab badges)
export const countRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response) => {
    const allowed = await allowedKinds(req, "read");
    const counts = await Promise.all(
      allowed.map(async ({ group, kind }) => ({
        group,
        kind,
        pending: await kinds[group][kind].model.countDocuments({
          status: { $in: kinds[group][kind].pending },
          ...kinds[group][kind].match,
        }),
      })),
    );
    res.status(200).json({ message: "countRequests", data: counts });
  },
);

const findRequest = async (req: Request, next: NextFunction) => {
  const { group, kind, nodeId } = req.params;
  if (!isGroup(group) || !kinds[group][kind] || !isValidObjectId(nodeId)) {
    next(new NotFoundError());
    return null;
  }
  const allowed = await allowedKinds(req, "update");
  if (!allowed.some((k) => k.group === group && k.kind === kind)) {
    next(new AccessError());
    return null;
  }
  const cfg = kinds[group][kind];
  // the same documents the queue lists: a centre's invitation waits on the
  // doctor, so the admin can neither reject nor reopen it from here
  const doc = await cfg.model.findOne({ _id: nodeId, ...cfg.match });
  if (!doc) {
    next(new NotFoundError());
    return null;
  }
  return { group, kind, cfg, doc };
};

const notifyApplicant = async (
  cfg: KindConfig,
  doc: any,
  title: string,
  message: string,
) => {
  const applicant = cfg.applicant(doc);
  let user = applicant.user;
  if (!user && applicant.org)
    user = (await applicant.org.model.findById(applicant.org.id).select("user").lean<{ user?: unknown }>())?.user;
  if (!user && applicant.doctor)
    user = (
      await DoctorProfile.findById(applicant.doctor).select("user").lean<{ user?: unknown }>()
    )?.user;
  if (user)
    await Notification.create({ user, source: "System", title, message }).catch(() => {});
  return user;
};

const rejectSchema = z.strictObject({ reason: z.string().trim().min(3).max(500) });

// POST /admin/requests/:group/:kind/:nodeId/reject {reason}
export const rejectRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = rejectSchema.safeParse(req.body || {});
    if (!success) return next(new BadInputError("دلیل رد درخواست را بنویسید"));
    const found = await findRequest(req, next);
    if (!found) return;
    const { cfg, doc } = found;
    if (!cfg.pending.includes(doc.status))
      return next(new BadInputError("فقط درخواست در انتظار بررسی را می‌توان رد کرد"));
    await doc.updateOne({
      $set: {
        status: "Rejected",
        rejectReason: data.reason,
        decidedAt: new Date(),
        ...(found.group === "join" ? { statusLastChangedAt: new Date() } : {}),
      },
    });
    const applicant = await notifyApplicant(
      cfg,
      doc,
      "درخواست شما رد شد",
      `درخواست «${cfg.title(doc) || cfg.label}» رد شد. دلیل: ${data.reason}`,
    );
    if (applicant)
      notifyWithSms("providerRequestRejectedProvider", applicant as any, {
        title: String(cfg.title(doc) || cfg.label),
        reason: data.reason,
      });
    res.status(200).json({ message: "rejectRequest" });
  },
);

// POST /admin/requests/:group/:kind/:nodeId/reopen - Rejected -> Pending
export const reopenRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const found = await findRequest(req, next);
    if (!found) return;
    const { doc } = found;
    if (doc.status !== "Rejected")
      return next(new BadInputError("فقط درخواست ردشده را می‌توان دوباره باز کرد"));
    await doc.updateOne({
      $set: {
        status: "Pending",
        // a doctor-join request's own "last changed" date (the panels show it)
        ...(found.group === "join" ? { statusLastChangedAt: new Date() } : {}),
      },
      $unset: { rejectReason: 1, decidedAt: 1 },
    });
    res.status(200).json({ message: "reopenRequest" });
  },
);

// POST /admin/requests/addition/:kind/:nodeId/processing - Pending -> Proccessing
export const markRequestProcessing: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const found = await findRequest(req, next);
    if (!found) return;
    if (found.group !== "addition" || found.doc.status !== "Pending")
      return next(new BadInputError());
    await found.doc.updateOne({ $set: { status: "Proccessing" } });
    res.status(200).json({ message: "markRequestProcessing" });
  },
);

// The queue's kinds, read-only, for the admin inbox and dashboard counts
// (Controllers/adminDashboardController.ts) so "what is pending" and where
// each request is handled are defined once.
export const providerRequestKinds: Readonly<
  Record<RequestGroup, Readonly<Record<string, Readonly<KindConfig>>>>
> = kinds;
