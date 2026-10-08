import { NextFunction, Request, RequestHandler, Response } from "express";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { nanoid } from "nanoid";
import { isValidObjectId, Types } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import BecomeDoctorRequest, {
  medicalSystemTitles,
  OnboardingDocField,
  onboardingDocFields,
} from "../Models/BecomeDoctorRequest";
import DoctorProfile from "../Models/DoctorProfile";
import McCode from "../Models/McCode";
import Speciality from "../Models/Speciality";
import UserIdentity from "../Models/UserIdentity";
import { councilCodesOf, councilDegreeOf } from "../Lib/councilInquiry";
import { matchSpecialityByTitle } from "../Lib/specialityMatch";
import { notifyUserAlertSubscribers } from "../Services/userAlertService";
import { sniffExtension } from "./uploadController";

// One doctor onboarding flow (2026-10 owner decision, the Doctolib /
// Paziresh24 pattern). It replaces two parallel ways in: the old request
// form (name, code, address typed by hand, then an admin approved it) and
// the council-inquiry self-service that created or claimed a profile on
// the spot with no human look at all.
//
//  1. POST /doctor/onboarding/inquiry {mcCode}: the council code is checked
//     against the applicant's verified national id (UserIdentity) through
//     the council's service (Lib/councilInquiry.ts); its degree title
//     prefills the speciality, and an existing page with that code (an old
//     directory profile, unowned) is offered to claim. If the service is
//     unavailable the applicant goes on by hand ("manual"), flagged for
//     the admin to check against the council card.
//  2. POST /doctor/onboarding (multipart): the council card image (required),
//     the optional licence and office permit, the confirmed speciality -
//     one BecomeDoctorRequest in the /requests queue.
//  3. The admin approves it (adminEntityController.approveBecomeDoctor:
//     creates or claims the profile as a draft that publishes itself once
//     bookable, Lib/doctorPublish.ts), or rejects it with a reason the
//     applicant sees here and can resubmit.
// A council code already owned by another account, or held by another
// open request, is refused.

const CODE_OWNED_ERROR = "این کد نظام پزشکی به حساب دیگری وصل است؛ برای بررسی با پشتیبانی تماس بگیرید";
const CODE_REQUESTED_ERROR = "برای این کد نظام پزشکی درخواست دیگری در دست بررسی است";

const cleanCode = (v: unknown) =>
  String(v ?? "")
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/\s+/g, "")
    .trim();

const codeSchema = z.string().regex(/^[0-9A-Za-z-]{2,20}$/);

// the page that already carries this code: claimable when nobody owns it,
// a refusal when another account does
const pageWithCode = async (code: string) =>
  DoctorProfile.findOne({ medicalSystemCode: code })
    .select("user firstName lastName slug mainSpeciality avatar")
    .populate({ path: "mainSpeciality", select: "name" })
    .lean<{
      _id: Types.ObjectId;
      user?: unknown;
      firstName?: string;
      lastName?: string;
      slug?: string;
      avatar?: string;
      mainSpeciality?: { _id: unknown; name?: string } | null;
    }>();

// shared by both steps: the reasons a code cannot be used by this user
const codeConflict = async (req: Request, code: string) => {
  const userId = String(req.user!._id);
  const page = await pageWithCode(code);
  if (page?.user && String(page.user) !== userId) {
    notifyUserAlertSubscribers(
      "newBecomeDoctorRequest",
      {
        title: "تداخل کد نظام پزشکی",
        message: `کاربر ${req.user!.phone} با کد نظام پزشکی ${code} ثبت‌نام کرد، اما این کد به حساب دیگری وصل است.`,
      },
      { requestId: String(page._id), userPhone: req.user!.phone },
    ).catch(() => {});
    return { error: new AppError(CODE_OWNED_ERROR, 409), page: null };
  }
  const other = await BecomeDoctorRequest.exists({
    medicalSystemCode: code,
    user: { $ne: req.user!._id },
    status: { $in: ["Pending", "Approved"] },
  });
  if (other) return { error: new AppError(CODE_REQUESTED_ERROR, 409), page: null };
  return { error: null, page: page && !page.user ? page : null };
};

const claimPreview = (page: Awaited<ReturnType<typeof pageWithCode>>) =>
  page
    ? {
        _id: String(page._id),
        firstName: page.firstName || "",
        lastName: page.lastName || "",
        slug: page.slug || "",
        avatar: page.avatar || "",
        speciality: page.mainSpeciality?.name || "",
      }
    : null;

const alreadyDoctor = async (req: Request) => !!(await DoctorProfile.exists({ user: req.user!._id }));

// GET /doctor/onboarding - where the applicant stands: their identity (the
// name the profile will carry), their request with its decision, and
// whether a profile exists already
export const getMyOnboarding: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const [identity, request, hasProfile] = await Promise.all([
      UserIdentity.findOne({ user: req.user._id }).select("nationalId givenName lastName gender").lean(),
      BecomeDoctorRequest.findOne({ user: req.user._id })
        .populate({ path: "specialities", select: "name" })
        .populate({ path: "claimProfile", select: "firstName lastName slug" })
        .lean(),
      alreadyDoctor(req),
    ]);
    res.status(200).json({
      message: "getMyOnboarding",
      data: {
        identity: identity
          ? { nationalId: identity.nationalId, firstName: identity.givenName, lastName: identity.lastName, gender: identity.gender }
          : null,
        request: request
          ? {
              _id: String(request._id),
              status: request.status,
              rejectReason: request.rejectReason || "",
              createdAt: request.createdAt,
              decidedAt: request.decidedAt,
              medicalSystemCode: request.medicalSystemCode,
              medicalSystemTitle: request.medicalSystemTitle,
              verification: request.verification,
              council: request.council || {},
              specialities: (Array.isArray(request.specialities) ? request.specialities : []).filter(
                (s: any) => s && typeof s === "object" && s._id,
              ),
              claimProfile: request.claimProfile || null,
              description: request.description || "",
              documents: onboardingDocFields.filter((f) => !!request[f]),
            }
          : null,
        hasProfile,
      },
    });
  },
);

const inquirySchema = z.strictObject({ mcCode: z.unknown() });

// POST /doctor/onboarding/inquiry {mcCode}
export const inquireCouncilCode: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const parsed = inquirySchema.safeParse(req.body || {});
    const code = cleanCode(parsed.success ? parsed.data.mcCode : "");
    if (!codeSchema.safeParse(code).success) return next(new AppError("کد نظام پزشکی را درست وارد کنید", 400));
    if (await alreadyDoctor(req)) return next(new AppError("شما قبلا پزشک شده اید", 409));
    const identity = await UserIdentity.findOne({ user: req.user._id });
    if (!identity) return next(new AppError("احراز هویت شما یافت نشد", 400));
    const conflict = await codeConflict(req, code);
    if (conflict.error) return next(conflict.error);

    let verification: "inquiry" | "manual" = "manual";
    let degree: { title?: string; city?: string; acquiredAt?: string } = {};
    const codes = await councilCodesOf(identity.nationalId, req.user.phone);
    if (codes.status === "error") return next(new AppError(codes.message, 400));
    if (codes.status === "ok") {
      if (!codes.data.includes(code))
        return next(new AppError("این کد نظام پزشکی با کد ملی شما در سامانه نظام پزشکی مطابقت ندارد", 400));
      verification = "inquiry";
      const details = await councilDegreeOf(code, req.user.phone);
      // the code is confirmed; a missing degree only means no prefill
      if (details.status === "ok") degree = details.data;
    }
    if (verification === "inquiry")
      await McCode.findOneAndUpdate(
        { user: req.user._id, mcCode: code },
        { user: req.user._id, mcCode: code, ...degree, verifiedAt: new Date() },
        { upsert: true },
      );
    const matched = await matchSpecialityByTitle(degree.title);
    const speciality = matched
      ? await Speciality.findById(matched).select("name").lean<{ _id: unknown; name?: string }>()
      : null;
    res.status(200).json({
      message: "inquireCouncilCode",
      data: {
        mcCode: code,
        verification,
        council: degree,
        firstName: identity.givenName,
        lastName: identity.lastName,
        speciality: speciality ? { _id: String(speciality._id), name: speciality.name || "" } : null,
        claimable: claimPreview(conflict.page),
      },
    });
  },
);

// the documents are private (they carry the national id and a photo):
// NotPublic/, read back only by the applicant and the staff who handle
// doctor requests (getOnboardingFile)
const PRIVATE_EXTS = new Set(["jpg", "png", "webp", "pdf"]);
const docName = (userId: unknown, field: OnboardingDocField, ext: string) =>
  `onboard__${String(userId)}__${field}__${Date.now()}_${nanoid(8)}.${ext}`;
const notPublicDir = () => path.join(process.cwd(), "NotPublic");

const saveDocs = async (req: Request): Promise<Partial<Record<OnboardingDocField, string>> | string> => {
  const files = Array.isArray(req.files) ? req.files : [];
  const out: Partial<Record<OnboardingDocField, string>> = {};
  const dir = notPublicDir();
  await fsp.mkdir(dir, { recursive: true });
  for (const file of files) {
    const field = file.fieldname as OnboardingDocField;
    if (!(onboardingDocFields as readonly string[]).includes(field)) return "نوع فایل ارسال شده مجاز نیست";
    const declared = (file.originalname.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const ext = sniffExtension(file.buffer, declared);
    if (!ext || !PRIVATE_EXTS.has(ext)) return "نوع فایل ارسال شده مجاز نیست";
    const name = docName(req.user!._id, field, ext);
    await fsp.writeFile(path.join(dir, name), file.buffer);
    out[field] = name;
  }
  return out;
};

const submitSchema = z.strictObject({
  mcCode: z.unknown(),
  medicalSystemTitle: z.enum(medicalSystemTitles),
  specialities: z.union([z.array(z.string()), z.string()]),
  description: z.string().max(1000).optional(),
});

// POST /doctor/onboarding (multipart: councilCard, licenseDoc?, officePermit?)
export const submitOnboarding: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const parsed = submitSchema.safeParse(req.body || {});
    if (!parsed.success) return next(new BadInputError());
    const code = cleanCode(parsed.data.mcCode);
    if (!codeSchema.safeParse(code).success) return next(new AppError("کد نظام پزشکی را درست وارد کنید", 400));
    if (await alreadyDoctor(req)) return next(new AppError("شما قبلا پزشک شده اید", 409));
    const current = await BecomeDoctorRequest.findOne({ user: req.user._id });
    if (current?.status === "Pending")
      return next(new AppError("درخواست شما قبلا ثبت شده در دست بررسی میباشد", 411));
    const identity = await UserIdentity.findOne({ user: req.user._id });
    if (!identity) return next(new AppError("احراز هویت شما یافت نشد", 400));
    const rawSpecs = parsed.data.specialities;
    const specialities = [...new Set((Array.isArray(rawSpecs) ? rawSpecs : String(rawSpecs).split(",")).map((s) => s.trim()).filter(Boolean))];
    if (!specialities.length) return next(new AppError("تخصص خود را انتخاب کنید", 400));
    if (specialities.some((id) => !isValidObjectId(id))) return next(new BadInputError());
    if ((await Speciality.countDocuments({ _id: { $in: specialities } })) !== specialities.length)
      return next(new NotFoundError("تخصص"));
    const conflict = await codeConflict(req, code);
    if (conflict.error) return next(conflict.error);

    const saved = await saveDocs(req);
    if (typeof saved === "string") return next(new AppError(saved, 400));
    // a resubmission keeps a document it does not replace
    const docs: Partial<Record<OnboardingDocField, string>> = {};
    for (const f of onboardingDocFields) {
      const v = saved[f] || (current?.[f] as string | undefined);
      if (v) docs[f] = v;
    }
    if (!docs.councilCard) return next(new AppError("تصویر کارت نظام پزشکی را بارگذاری کنید", 400));

    const mc = await McCode.findOne({ user: req.user._id, mcCode: code, verifiedAt: { $exists: true } }).lean();
    const request = await BecomeDoctorRequest.findOneAndUpdate(
      { user: req.user._id },
      {
        $set: {
          user: req.user._id,
          firstName: identity.givenName,
          lastName: identity.lastName,
          ssid: identity.nationalId,
          gender: identity.gender,
          medicalSystemTitle: parsed.data.medicalSystemTitle,
          medicalSystemCode: code,
          specialities,
          verification: mc ? "inquiry" : "manual",
          council: mc ? { title: mc.title, city: mc.city, acquiredAt: mc.acquiredAt } : {},
          ...docs,
          ...(parsed.data.description?.trim() ? { description: parsed.data.description.trim() } : {}),
          ...(mc ? { mcCode: mc._id } : {}),
          ...(conflict.page ? { claimProfile: conflict.page._id } : {}),
          status: "Pending",
          // a resubmitted request is a fresh one: the old decision goes
          createdAt: new Date(),
        },
        $unset: {
          rejectReason: 1,
          decidedAt: 1,
          ...(mc ? {} : { mcCode: 1 }),
          ...(conflict.page ? {} : { claimProfile: 1 }),
          ...(parsed.data.description?.trim() ? {} : { description: 1 }),
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
    notifyUserAlertSubscribers(
      "newBecomeDoctorRequest",
      {
        title: "درخواست پزشک شدن",
        message: mc
          ? `کاربر ${req.user.phone} درخواست پزشک شدن ثبت کرد (کد نظام پزشکی ${code}، تأییدشده با استعلام).`
          : `کاربر ${req.user.phone} درخواست پزشک شدن ثبت کرد (کد نظام پزشکی ${code}، بدون استعلام: با کارت نظام پزشکی بررسی شود).`,
      },
      { requestId: String(request._id), userPhone: req.user.phone },
    ).catch(() => {});
    res.status(200).json({ message: "submitOnboarding", data: { _id: String(request._id) } });
  },
);

// one document of a doctor request, for its applicant (GET
// /doctor/onboarding/file/:field) or for staff (GET
// /admin/becomedoctor/:nodeId/file/:field, behind the request's read right)
const sendDoc = (res: Response, next: NextFunction, name?: string) => {
  const dir = notPublicDir();
  if (!name || !/^onboard__[0-9a-f]{24}__[A-Za-z]+__[\w-]+\.(jpg|png|webp|pdf)$/.test(name)) return next(new NotFoundError());
  const filePath = path.join(dir, name);
  if (path.dirname(filePath) !== dir || !fs.existsSync(filePath)) return next(new NotFoundError());
  const ext = name.split(".").pop() || "";
  const mime: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf" };
  res.setHeader("Content-Type", mime[ext] || "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=600");
  fs.createReadStream(filePath).pipe(res);
};

const isDocField = (v: unknown): v is OnboardingDocField =>
  typeof v === "string" && (onboardingDocFields as readonly string[]).includes(v);

export const getMyOnboardingFile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { field } = req.params;
    if (!isDocField(field)) return next(new NotFoundError());
    const request = await BecomeDoctorRequest.findOne({ user: req.user._id }).select(field).lean();
    sendDoc(res, next, (request as Record<string, any> | null)?.[field]);
  },
);

export const getOnboardingFile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId, field } = req.params;
    if (!isValidObjectId(nodeId) || !isDocField(field)) return next(new NotFoundError());
    const request = await BecomeDoctorRequest.findById(nodeId).select(field).lean();
    sendDoc(res, next, (request as Record<string, any> | null)?.[field]);
  },
);

// the two old ways in (the request form POST /doctor, the self-service
// inquiry /doctor/request*) answer with where to go now
export const retiredOnboarding: RequestHandler = (req, res, next) =>
  next(new AppError("ثبت‌نام پزشک از مسیر جدید انجام می‌شود؛ صفحه را دوباره باز کنید", 410));
