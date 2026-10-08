import Reservation from "../Models/Reservation";
import { endCentreMembership } from "../Lib/centreMembership";
import { sanitizePlanAi } from "../Lib/ai/planAi";
import type { AiAudience } from "../Lib/ai/aiFeatures";
import PharmacyAdditionRequest from "../Models/PharmacyAdditionRequest";
import { registerAuditSingletons } from "../Services/adminAudit";
import { blockIfReferenced, detachReferences } from "../Lib/refIntegrity";
import express, { NextFunction, Request, RequestHandler, Response } from "express";
import mongoose, { Model, PopulateOptions } from "mongoose";
import * as z from "zod";

import * as authController from "../Controllers/authController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";
import * as contentTranslationController from "../Controllers/contentTranslationController";
import Blog from "../Models/Blog";
import BlogCategory from "../Models/BlogCategory";
import InlineAdvertisement from "../Models/InlineAdvertisement";
import BlogMedia from "../Models/BlogMedia";
import Speciality from "../Models/Speciality";
import BecomeDoctorRequest from "../Models/BecomeDoctorRequest";
import User from "../Models/User";
import catchAsync from "../Lib/catchAsync";
import AppError from "../Lib/AppError";
import DoctorProfile from "../Models/DoctorProfile";
import Doctor from "../Models/Doctor";
import AccessLevel, { AccessLevelModel } from "../Models/AccessLevel";
import UserAccessLevel from "../Models/UserAccessLevel";
import Clinic from "../Models/Clinic";
import ClinicDepartment from "../Models/ClinicDepatment";
import ClinicDoctor from "../Models/ClinicDoctor";
import DoctorJoinClinicRequest from "../Models/DoctorJoinClinicRequest";
import ClinicAdditionRequest from "../Models/ClinicAdditionRequest";
import Insurance from "../Models/Insurance";
import BaseInsuranceLicense from "../Models/BaseInsuranceLicense";
import LicensePromotion from "../Models/LicensePromotion";
import { clearPromotionCache } from "../Lib/licenseQuote";
import InsuranceProfileLicense from "../Models/InsuranceProfileLicense";
import InsuranceAdditionRequest from "../Models/InsuranceAdditionRequest";
import Pharmacy from "../Models/Pharmacy";
import BecomeClinicRequest from "../Models/BecomeClinicRequest";
import BecomeInsuranceRequest from "../Models/BecomeInsuranceRequest";
import BecomePharmacyRequest from "../Models/BecomePharmacyRequest";
import BasePharmacyLicense from "../Models/BasePharmacyLicense";
import PharmacyProfileLicense from "../Models/PharmacyProfileLicense";
import BaseClinicLicense from "../Models/BaseClinicLicense";
import ClinicProfileLicense from "../Models/ClinicProfileLicense";
import BaseParaClinicLicense from "../Models/BaseParaClinicLicense";
import ParaClinicProfileLicense from "../Models/ParaClinicProfileLicense";
import CallRoom from "../Models/CallRoom";
import Redirection from "../Models/Redirection";
import ShortLink from "../Models/ShortLink";
import Disease from "../Models/Disease";
import Drug from "../Models/Drug";
import Symptom from "../Models/Symptom";
import Part from "../Models/Part";
import DoctorFaq from "../Models/DoctorFaq";
import TaminServiceType from "../Models/TaminServiceType";
import TaminPrescriptionType from "../Models/TaminPrescriptionType";
import TaminService from "../Models/TaminService";
import TaminParTaref from "../Models/TaminParTaref";
import TaminDrugUsage from "../Models/TaminDrugUsage";
import TaminDrugInstruction from "../Models/TaminDrugInstruction";
import TaminDrugAmount from "../Models/TaminDrugAmount";
import TaminPhPlan from "../Models/TaminPhPlan";
import TaminPhIllness from "../Models/TaminPhIllness";
import TaminIcid from "../Models/TaminIdid";
import TaminComplaint from "../Models/TaminComplaint";
import TaminSpec from "../Models/TaminSpec";
import Advertisement from "../Models/Advertisement";
import Service from "../Models/Service";
import Faq from "../Models/Faq";
import OllamaModel from "../Models/Bot/OllamaModel";
import GlobalOllamaSettings from "../Models/Bot/GlobalOllamaSettings";
import BotInstruction from "../Models/Bot/BotInstruction";
import ServiceCategory from "../Models/ServiceCategory";
import * as serviceCatalogController from "../Controllers/serviceCatalogController";
import Province from "../Models/Geo/Province";
import City from "../Models/Geo/City";
import District from "../Models/Geo/District";
import BecomeParaClinicRequest from "../Models/BecomeParaClinicRequest";
import ParaClinic from "../Models/Paraclinic";
import ProductCategory from "../Models/ProductCategory";
import Product from "../Models/Product";
import ProductImage from "../Models/ProductImage";
import ProductSeller from "../Models/ProductSeller";
import ProductSpec from "../Models/ProductSpec";
import ClinicCategory from "../Models/ClinicCategory";
import DiseaseCategory from "../Models/DiseaseCategory";
import DiseaseTag from "../Models/DiseaseTag";
import DrugTag from "../Models/Drugtag";
import ClinicTag from "../Models/ClinicTag";
import Hospital from "../Models/Hospital";
import HospitalCategory from "../Models/HospitalCategory";
import HospitalTag from "../Models/HospitalTag";
import HospitalDepartment from "../Models/HospitalDepartment";
import HospitalDoctor from "../Models/HospitalDoctor";
import DoctorJoinHospitalRequest from "../Models/DoctorJoinHospitalRequest";
import HospitalAdditionRequest from "../Models/HospitalAdditionRequest";
import BecomeHospitalRequest from "../Models/BecomeHospitalRequest";
import BaseHospitalLicense from "../Models/BaseHospitalLicense";
import HospitalProfileLicense from "../Models/HospitalProfileLicense";
import Test from "../Models/Test";
import TestCategory from "../Models/TestCategory";
import ParaClinicTest from "../Models/ParaClinicTest";
import ParaClinicTag from "../Models/ParaClinicTag";
import ParaClinicCategory from "../Models/ParaClinicCategory";
import ServicePackage from "../Models/ServicePackage";
import ProductPackage from "../Models/ProductPackage";
import SymptomCategory from "../Models/SymptomCategory";
import Comment from "../Models/Comment";
import DoctorFeedBack, {
  doctorFeedbackStatuses,
} from "../Models/DoctorFeedback";
import HospitalClinic from "../Models/HospitalClinic";
import InsuranceCategory from "../Models/InsuranceCategory";
import InsuranceTag from "../Models/InsuranceTag";
import InsurancePlan from "../Models/InsurancePlan";
import FaqCategory from "../Models/FaqCategory";
import ContactRequest, { contactRequestStatuses } from "../Models/ContactRequest";
import PrivacySection from "../Models/PrivacySection";
import AboutPartner from "../Models/AboutPartner";
import AboutTeam from "../Models/AboutTeam";
import AboutWhy from "../Models/AboutWhy";
import Testify from "../Models/Testify";
import PageMeta from "../Models/PageMeta";
import Ticket from "../Models/Ticket";
import TicketMessage from "../Models/TicketMessage";
import Notification from "../Models/Notification";
import PushSubscription from "../Models/PushSubscription";
import AppConfig, { APP_CONFIG_SECRETS } from "../Models/AppConfig";
import { isMaskedSecret } from "../Lib/secretMask";
import { clearNexaMapSettingsCache } from "../Lib/nexamap";
import BlogTag from "../Models/BlogTag";
import BlogRRS from "../Models/BlogRRS";
import PharmacyFinanceSettings from "../Models/PharmacyFinanceSettings";
import DoctorFinanceSettings from "../Models/DoctorFinanceSettings";
import ParaClinicFinanceSettings from "../Models/ParaClinicFinanceSettings";
import GlobalFinanceSettings from "../Models/GlobalFinanceSettings";
import PharmacyTaxSettings from "../Models/PharmacyTaxSettings";
import DoctorTaxSettings from "../Models/DoctorTaxSettings";
import ClinicTaxSettings from "../Models/ClinicTaxSettings";
import HospitalTaxSettings from "../Models/HospitalTaxSettings";
import ParaClinicTaxSettings from "../Models/ParaClinicTaxSettings";
import GlobalTaxSettings from "../Models/GlobalTaxSettings";
import BaseDoctorLicense from "../Models/BaseDoctorLicense";
import DoctorProfileLicense from "../Models/DoctorProfileLicense";
import UserAlert from "../Models/UserAlert";
import SmsPatterns from "../Models/SmsPatterns";
import StaticImages from "../Models/StaticImages";
import BookingDescription from "../Models/BookingDescription";

const router = express.Router();

// A speciality in use (doctors, diseases, the legacy directory) cannot be
// deleted - it would leave cards and filters pointing at nothing; deactivate
// it instead.
const specialityRemoveGuard = async (id: string) => {
  const used =
    (await DoctorProfile.exists({
      $or: [{ mainSpeciality: id }, { specialities: id }],
    })) ||
    (await Doctor.exists({ $or: [{ speciality: id }, { specialities: id }] })) ||
    (await Disease.exists({ specialities: id }));
  return used ? "این تخصص به پزشک یا بیماری وصل است؛ به‌جای حذف، غیرفعالش کنید" : null;
};

// A doctor with bookings keeps their profile (medical and money history
// point at it); one without is deleted along with their centre memberships.
// Prescriptions, visit notes, payouts, reviews and the services / packages
// patients buy point at the profile too: deleting it left them pointing at
// nothing (public service lists showed "owner: null" items), so they keep it
// as well. What is only a link (memberships, join requests, the hospital's
// manager field) goes with the profile.
const doctorHistory: [model: string, field: string][] = [
  ["Booking", "doctor"],
  ["Prescription", "author"],
  ["Prescription2", "author"],
  ["VisitPrescription", "author"],
  ["VisitNote", "doctor"],
  ["Transaction", "doctor"],
  ["DoctorFeedback", "doctor"],
  ["Service", "owner"],
  ["ServicePackage", "owner"],
];
const doctorProfileRemoveGuard = async (id: string) => {
  if (await Reservation.exists({ doctor: id }))
    return "این پزشک نوبت ثبت‌شده دارد؛ به‌جای حذف، پروفایل را غیرفعال کنید";
  for (const [name, field] of doctorHistory) {
    if (!mongoose.modelNames().includes(name)) continue;
    if (await mongoose.model(name).exists({ [field]: id }))
      return "این پزشک سابقه‌ی نسخه، تراکنش، نظر یا خدمت دارد؛ به‌جای حذف، پروفایل را غیرفعال کنید";
  }
  await Promise.all([
    ClinicDoctor.deleteMany({ doctor: id }),
    HospitalDoctor.deleteMany({ doctor: id }),
    DoctorJoinClinicRequest.deleteMany({ doctor: id }),
    DoctorJoinHospitalRequest.deleteMany({ doctor: id }),
    ...["DoctorPharmacy", "DoctorInsurance"]
      .filter((name) => mongoose.modelNames().includes(name))
      .map((name) => mongoose.model(name).deleteMany({ doctor: id })),
    Hospital.updateMany({ owner: id }, { $unset: { owner: 1 } }),
  ]);
  return null;
};

// Removing a doctor from a centre here (the admin's team tab) does what the
// centre panel's "remove doctor" does: the doctor's offices at that centre
// stop counting as the centre's (its visit tax / share no longer applies).
const membershipRemoveGuard =
  (member: Model<any>, field: "clinic" | "hospital") => async (id: string) => {
    const node = await member.findById(id).select(`doctor ${field}`).lean<Record<string, unknown>>();
    // offices, the hospital's manager, the join request ("Left") - the same
    // as when the doctor leaves or the centre removes them
    if (node?.doctor && node[field]) await endCentreMembership(field, node.doctor, node[field]);
    return null;
  };

// A request's status moves only through its own one-way actions: approve
// (adminEntityController) and reject / reopen / processing
// (adminRequestsController, which tell the applicant). The generic edit may
// no longer set it - a free status select used to un-approve without undoing
// the centre, reject without a word to the applicant, or mark an addition
// "Done" with nothing created.
const lockedStatusEditSchema = z.strictObject({}).refine(() => false, {
  message: "status is changed through /admin/requests",
});

const stripFields =
  (fields: string[]): RequestHandler =>
  (req, _res, next) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (body && typeof body === "object") {
      for (const f of fields) delete body[f];
      const set = body.$set as Record<string, unknown> | undefined;
      if (set && typeof set === "object") for (const f of fields) delete set[f];
    }
    next();
  };

// runs request handlers one after another, as one handler
const chainHandlers =
  (...handlers: RequestHandler[]): RequestHandler =>
  (req, res, next) => {
    const run = (i: number): void => {
      if (i >= handlers.length) return next();
      handlers[i](req, res, (err?: unknown) => (err ? next(err) : run(i + 1)));
    };
    run(0);
  };

// A provider's plan record follows its plan (2026-10): picking a plan in
// the admin's license tab copies the plan's modules and name, the same as a
// purchase does, so "on Gold" can no longer mean "no modules ticked". Only
// a record with no plan (a custom grant) takes modules typed by hand. An
// inactive plan can't be assigned.
const licenseFromPlan = (
  record: Model<any>,
  plan: Model<any>,
): RequestHandler =>
  catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
    const body = req.body as Record<string, any>;
    if (typeof body.modules === "string") {
      try {
        body.modules = JSON.parse(body.modules);
      } catch {}
    }
    const current = req.params.nodeId
      ? await record.findById(req.params.nodeId).select("baseLicense").lean<{ baseLicense?: unknown }>()
      : null;
    const planId =
      body.baseLicense !== undefined ? body.baseLicense : current?.baseLicense;
    if (!planId) return next();
    const base = await plan
      .findById(planId)
      .select("displayName modules isActive")
      .lean<{ displayName?: string; modules?: string[]; isActive?: boolean }>();
    if (!base) return next(new AppError("این پلن پیدا نشد", 400));
    if (body.baseLicense !== undefined && base.isActive === false)
      return next(new AppError("این پلن غیرفعال است؛ اول آن را فعال کنید", 400));
    body.modules = base.modules || [];
    if (body.baseLicense !== undefined && !String(body.displayName || "").trim())
      body.displayName = base.displayName;
    next();
  });

// a plan record's period must run forwards
const licensePeriod = (record: Model<any>): RequestHandler =>
  catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
    const body = req.body as Record<string, any>;
    if (body.startedAt === undefined && body.expiresAt === undefined) return next();
    const current = req.params.nodeId
      ? await record.findById(req.params.nodeId).select("startedAt expiresAt").lean<{ startedAt?: Date; expiresAt?: Date }>()
      : null;
    const start = body.startedAt !== undefined ? body.startedAt : current?.startedAt;
    const end = body.expiresAt !== undefined ? body.expiresAt : current?.expiresAt;
    if (start && end && new Date(end) <= new Date(start))
      return next(new AppError("تاریخ انقضا باید بعد از تاریخ شروع باشد", 400));
    next();
  });

// A plan promotion (2026-10): a real discount, a window that ends after it
// starts (whole Tehran days: from the start of the first to the end of the
// last), something to apply to, and a code no other promotion uses.
const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const tehranDayStart = (d: Date) =>
  new Date(Math.floor((d.getTime() + TEHRAN_OFFSET_MS) / DAY_MS) * DAY_MS - TEHRAN_OFFSET_MS);
const promotionRules: RequestHandler = (() => {
  const parse = autoController.mutateCompoundFields(["kinds", "plans"]);
  const check = catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
    const body = req.body as Record<string, any>;
    const current = req.params.nodeId
      ? await LicensePromotion.findById(req.params.nodeId).lean<Record<string, any>>()
      : null;
    const pick = (k: string) => (body[k] !== undefined ? body[k] : current?.[k]);
    const asDate = (v: unknown) => {
      const d = v ? new Date(v as string) : null;
      return d && !Number.isNaN(d.getTime()) ? d : null;
    };
    if (body.startsAt !== undefined) {
      const d = asDate(body.startsAt);
      if (d) body.startsAt = tehranDayStart(d);
    }
    if (body.endsAt !== undefined) {
      const d = asDate(body.endsAt);
      if (d) body.endsAt = new Date(tehranDayStart(d).getTime() + DAY_MS - 1);
    }
    const startsAt = asDate(pick("startsAt")) || new Date();
    const endsAt = asDate(pick("endsAt"));
    if (!endsAt) return next(new AppError("تاریخ پایان تخفیف را وارد کنید", 400));
    if (endsAt <= startsAt) return next(new AppError("تاریخ پایان تخفیف باید بعد از تاریخ شروع باشد", 400));
    const type = pick("discountType") === "amount" ? "amount" : "percent";
    const value = Number(pick("value"));
    if (!(value > 0)) return next(new AppError("مقدار تخفیف باید بیشتر از صفر باشد", 400));
    if (type === "percent" && value > 100) return next(new AppError("درصد تخفیف نباید از ۱۰۰ بیشتر باشد", 400));
    const list = (v: unknown) => (Array.isArray(v) ? v.filter(Boolean) : []);
    if (body.kinds !== undefined) body.kinds = list(body.kinds);
    if (body.plans !== undefined) body.plans = list(body.plans).map(String);
    if (!list(pick("kinds")).length && !list(pick("plans")).length)
      return next(new AppError("دست‌کم یک نوع ارائه‌دهنده یا یک پلن برای تخفیف انتخاب کنید", 400));
    if (body.code !== undefined) {
      const code = String(body.code || "").trim().toUpperCase();
      if (code && !/^[A-Z0-9_-]{3,40}$/.test(code))
        return next(new AppError("کد تخفیف فقط حروف انگلیسی، عدد، خط تیره و زیرخط (۳ تا ۴۰ نویسه) است", 400));
      if (code && (await LicensePromotion.exists({ code, _id: { $ne: req.params.nodeId || null } })))
        return next(new AppError("این کد تخفیف برای تخفیف دیگری ثبت شده است", 400));
      body.code = code;
    }
    clearPromotionCache();
    next();
  });
  return (req, res, next) => parse(req, res, (err?: unknown) => (err ? next(err) : check(req, res, next)));
})();

// A plan catalog entry (2026-10): the default plan is what every provider
// without a paid plan runs on, so it must stay on sale.
const planRules = (plan: Model<any>): RequestHandler => {
  const parse = autoController.mutateCompoundFields([
    "descriptions",
    "modules",
    "pricing",
  ]);
  // the AI a plan sells (2026-10, Lib/ai/planAi.ts), checked against the
  // registry for this kind
  const kind = ({
    BaseDoctorLicense: "doctor",
    BaseClinicLicense: "clinic",
    BaseHospitalLicense: "hospital",
    BasePharmacyLicense: "pharmacy",
    BaseParaClinicLicense: "paraClinic",
    BaseInsuranceLicense: "insurance",
  } as Record<string, AiAudience>)[plan.modelName];
  const check = catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
    const body = req.body as Record<string, any>;
    if (kind && body && typeof body === "object") sanitizePlanAi(kind, body);
    const current = req.params.nodeId
      ? await plan.findById(req.params.nodeId).select("isDefault isActive").lean<{ isDefault?: boolean; isActive?: boolean }>()
      : null;
    const flag = (v: unknown) => v === true || v === "true";
    const isDefault = body.isDefault !== undefined ? flag(body.isDefault) : !!current?.isDefault;
    const isActive =
      body.isActive !== undefined ? flag(body.isActive) : current ? current.isActive !== false : true;
    if (isDefault && !isActive)
      return next(new AppError("پلن پیش‌فرض نمی‌تواند غیرفعال باشد؛ اول پلن دیگری را پیش‌فرض کنید", 400));
    // exactly one default per kind (2026-10): the default is taken off a
    // plan only by marking another plan default (which clears this one)
    if (current?.isDefault && !isDefault)
      return next(new AppError("هر نوع ارائه‌دهنده یک پلن پیش‌فرض لازم دارد؛ برای برداشتن آن، پلن دیگری را پیش‌فرض کنید", 400));
    // a discount above the price made the option free without anyone
    // deciding so (the purchase clamps the amount to zero)
    if (
      Array.isArray(body.pricing) &&
      body.pricing.some(
        (row: any) => Number(row?.discount || 0) > Number(row?.price || 0),
      )
    )
      return next(new AppError("تخفیف هر گزینه‌ی قیمت نباید از خود قیمت بیشتر باشد", 400));
    next();
  });
  return (req, res, next) => parse(req, res, (err?: unknown) => (err ? next(err) : check(req, res, next)));
};

// a package holds only what its owner sells (2026-10), the same rule the
// pharmacy and doctor panels apply; the admin path skipped it
const packageItemsOwned = (
  record: Model<any>,
  field: "products" | "services",
): RequestHandler =>
  catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
    const body = req.body as Record<string, any>;
    const current = req.params.nodeId
      ? await record.findById(req.params.nodeId).select(`owner ${field}`).lean<Record<string, any>>()
      : null;
    if (body[field] === undefined && body.owner === undefined) return next();
    const owner = body.owner ?? current?.owner;
    const raw = body[field] ?? current?.[field] ?? [];
    const items = (Array.isArray(raw) ? raw : []).map((v: any) => String(v?._id ?? v)).filter(Boolean);
    if (!owner || !items.length) return next();
    const unique = [...new Set(items)];
    const owned =
      field === "products"
        ? await ProductSeller.countDocuments({ seller: owner, product: { $in: unique } })
        : await Service.countDocuments({ owner, _id: { $in: unique } });
    if (owned !== unique.length)
      return next(
        new AppError(
          field === "products"
            ? "این بسته محصولی دارد که این داروخانه نمی‌فروشد"
            : "این بسته خدمتی دارد که مال این پزشک نیست",
          400,
        ),
      );
    next();
  });

const PROVIDER_OWNED = ["user", "claimed", "averageScore", "commentCount", "feedbackCount", "recommendCount"];

const map: {
  name: string;
  model: Model<any>;
  one?: boolean;
  all?: boolean;
  create?: boolean;
  remove?: boolean;
  // a catalog other forms pick from (places, categories, tags): any staff
  // member may list it, so a form they can edit never hangs on a 403
  // select; writing still needs `accessLevel` (or the super admin)
  lookup?: boolean;
  // refuses the delete (returns the reason) while other records need it
  removeGuard?: (nodeId: string) => Promise<string | null>;
  edit?: boolean;
  singleton?: boolean;
  allPopulation?: PopulateOptions | PopulateOptions[];
  allSelection?: Record<string, number | boolean | string | object>;
  onePopulation?: PopulateOptions | PopulateOptions[];
  editBodyMutator?: RequestHandler;
  // fields a raw create / edit may not write: they have their own audited
  // path (a provider's panel owner and claimed flag through
  // PUT /admin/<kind>/<id>/owner, scores from the reviews)
  protectedFields?: string[];
  accessLevel?: AccessLevelModel;
  // Optional Zod validation (AUDIT F-09, see autoController.validateBody /
  // validateQuery). Left unset for now on every entry below on purpose -
  // these are meant to be filled in incrementally, model by model, in
  // later sessions. `editSchema` validates req.body on both create and
  // edit/editSingleton; `querySchema` validates req.query on get/getAll.
  // A segment with no schema set behaves exactly as before this change -
  // validation is skipped, not defaulted to some implicit shape.
  editSchema?: z.ZodTypeAny;
  querySchema?: z.ZodTypeAny;
}[] = [
  {
    name: "blog",
    model: Blog,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allSelection: { content: false },
    allPopulation: [
      { path: "related", select: ["title", "_id"] },
      { path: "category" },
    ],
    editBodyMutator: autoController.mutateCompoundFields(["related", "tags"]),
    accessLevel: "Blog",
  },
  {
    name: "blogcategory",
    model: BlogCategory,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    accessLevel: "BlogCategory",
  },
  {
    name: "inlinead",
    model: InlineAdvertisement,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    accessLevel: "InlineAdvertisement",
  },
  {
    name: "blogmedia",
    model: BlogMedia,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    accessLevel: "BlogMedia",
  },
  {
    name: "speciality",
    model: Speciality,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    removeGuard: specialityRemoveGuard,
    accessLevel: "Sepciality",
  },
  {
    name: "becomedoctor",
    model: BecomeDoctorRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "user" }, { path: "specialities" }],
    allPopulation: { path: "user" },
    accessLevel: "BecomeDoctorRequest",
    // approval runs through /admin/become<kind>/:id/approve (it creates the
    // centre); a raw edit may only reject or reopen
    editSchema: lockedStatusEditSchema,
  },
  {
    name: "becomeclinic",
    model: BecomeClinicRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "user" }],
    allPopulation: { path: "user" },
    accessLevel: "BecomeClinicRequest",
    // approval runs through /admin/become<kind>/:id/approve (it creates the
    // centre); a raw edit may only reject or reopen
    editSchema: lockedStatusEditSchema,
  },
  {
    name: "becomehospital",
    model: BecomeHospitalRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "user" }],
    allPopulation: { path: "user" },
    accessLevel: "BecomeHospitalRequest",
    // approval runs through /admin/become<kind>/:id/approve (it creates the
    // centre); a raw edit may only reject or reopen
    editSchema: lockedStatusEditSchema,
  },
  {
    name: "becomeinsurance",
    model: BecomeInsuranceRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "user" }],
    allPopulation: { path: "user" },
    accessLevel: "BecomeInsuranceRequest",
    // approval runs through /admin/become<kind>/:id/approve (it creates the
    // centre); a raw edit may only reject or reopen
    editSchema: lockedStatusEditSchema,
  },
  {
    name: "becomepharmacy",
    model: BecomePharmacyRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "user" }],
    allPopulation: { path: "user" },
    accessLevel: "BecomePharmacyRequest",
    // approval runs through /admin/become<kind>/:id/approve (it creates the
    // centre); a raw edit may only reject or reopen
    editSchema: lockedStatusEditSchema,
  },
  {
    name: "user",
    all: true,
    one: true,
    edit: true,
    model: User,
    accessLevel: "User",
    editBodyMutator: autoController.adminOnlyFields({
      fields: ["role", "phone"],
      model: User,
    }),
    // only cosmetic fields: status, role, phone and identity change through
    // the audited /admin/users routes (suspend cuts sessions, role keeps one
    // super admin), never through a raw edit
    editSchema: z.strictObject({
      username: z.string().trim().max(80).optional(),
      avatar: z.string().max(500).optional(),
    }),
  },
  {
    name: "doctorprofile",
    protectedFields: PROVIDER_OWNED,
    model: DoctorProfile,
    all: true,
    one: true,
    edit: true,
    remove: true,
    removeGuard: doctorProfileRemoveGuard,
    create: true,
    allPopulation: [
      { path: "phoneConsultSettings" },
      { path: "user" },
      { path: "mainSpeciality" },
      { path: "city", select: "name" },
    ],
    onePopulation: [{ path: "phoneConsultSettings" }],
    editBodyMutator: autoController.mutateCompoundFields([
      "serviceCategories",
      "achivements",
      "specialities",
      "location",
    ]),
    accessLevel: "DoctorProfile",
  },
  {
    name: "doctor",
    model: Doctor,
    // the old directory is read-only: every doctor now lives in
    // doctorprofile (merged at boot, Lib/mergeLegacyDoctors.ts)
    all: true,
    one: true,
    edit: false,
    remove: false,
    create: false,
    allPopulation: [{ path: "speciality" }],
    // read-only legacy rows, used when cloning a profile: same right as the
    // doctor profiles they were merged into
    accessLevel: "DoctorProfile",
  },
  {
    name: "accesslevel",
    model: AccessLevel,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    onePopulation: { path: "admins", populate: { path: "user" } },
    editBodyMutator: autoController.mutateCompoundFields(["$set"]),
  },
  {
    // read-only: who is staff changes only through PATCH
    // /admin/users/:id/role (keeps one super admin, no self-change)
    name: "useraccesslevel",
    model: UserAccessLevel,
    all: true,
    one: true,
    allPopulation: [{ path: "user" }, { path: "accessLevel" }],
  },
  {
    name: "clinic",
    protectedFields: PROVIDER_OWNED,
    model: Clinic,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    accessLevel: "Clinic",
    allPopulation: { path: "user" },
    onePopulation: { path: "user" },
    editBodyMutator: autoController.mutateCompoundFields([
      "tags",
      "insurances",
      "services",
      "certificates",
      "location",
    ]),
  },
  {
    name: "clinicdepartment",
    model: ClinicDepartment,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    accessLevel: "ClinicDepartment",
    allPopulation: { path: "doctorsCount" },
  },
  {
    name: "clinicdoctor",
    model: ClinicDoctor,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    removeGuard: membershipRemoveGuard(ClinicDoctor, "clinic"),
    accessLevel: "ClinicDoctor",
    allPopulation: [{ path: "doctor" }, { path: "department" }],
  },
  {
    name: "doctorjoinclinic",
    model: DoctorJoinClinicRequest,
    all: true,
    one: true,
    edit: true,
    editSchema: lockedStatusEditSchema,
    remove: true,
    accessLevel: "DoctorJoinClinic",
    allPopulation: [{ path: "doctor" }, { path: "clinic" }],
  },
  {
    name: "clinicaddition",
    model: ClinicAdditionRequest,
    accessLevel: "ClinicAdditionRequest",
    all: true,
    one: true,
    edit: true,
    editSchema: lockedStatusEditSchema,
    remove: true,
    allPopulation: { path: "submittedBy" },
    onePopulation: { path: "submittedBy" },
  },
  {
    name: "hospitaldepartment",
    model: HospitalDepartment,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    accessLevel: "HospitalDepartment",
    allPopulation: { path: "doctorsCount" },
  },
  {
    name: "hospitaldoctor",
    model: HospitalDoctor,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    removeGuard: membershipRemoveGuard(HospitalDoctor, "hospital"),
    accessLevel: "HospitalDoctor",
    allPopulation: [{ path: "doctor" }, { path: "department" }],
  },
  {
    name: "doctorjoinhospital",
    model: DoctorJoinHospitalRequest,
    all: true,
    one: true,
    edit: true,
    editSchema: lockedStatusEditSchema,
    remove: true,
    accessLevel: "DoctorJoinHospital",
    allPopulation: [{ path: "doctor" }, { path: "hospital" }],
  },
  {
    name: "hospitaladdition",
    model: HospitalAdditionRequest,
    accessLevel: "HospitalAdditionRequest",
    all: true,
    one: true,
    edit: true,
    editSchema: lockedStatusEditSchema,
    remove: true,
    allPopulation: { path: "submittedBy" },
    onePopulation: { path: "submittedBy" },
  },
  {
    // doctors' "add my pharmacy" requests - had no admin section at all
    name: "pharmacyaddition",
    accessLevel: "PharmacyAdditionRequest",
    model: PharmacyAdditionRequest,
    all: true,
    one: true,
    edit: true,
    editSchema: lockedStatusEditSchema,
    remove: true,
    allPopulation: { path: "submittedBy" },
    onePopulation: { path: "submittedBy" },
  },
  {
    name: "insurance",
    protectedFields: PROVIDER_OWNED,
    model: Insurance,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    accessLevel: "Insurance",
    editBodyMutator: autoController.mutateCompoundFields([
      "tags",
      "location",
      "coverages",
      "advantages",
    ]),
  },
  {
    // Mirrors hospitaladdition above - doctor-submitted requests to add a
    // new insurance provider to the platform (2026-09). See
    // Models/InsuranceAdditionRequest.ts.
    name: "insuranceaddition",
    model: InsuranceAdditionRequest,
    accessLevel: "InsuranceAdditionRequest",
    all: true,
    one: true,
    edit: true,
    editSchema: lockedStatusEditSchema,
    remove: true,
    allPopulation: { path: "submittedBy" },
    onePopulation: { path: "submittedBy" },
  },
  {
    name: "pharmacy",
    protectedFields: PROVIDER_OWNED,
    model: Pharmacy,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    accessLevel: "Pharmacy",
    editBodyMutator: autoController.mutateCompoundFields(["location", "insurances"]),
  },
  {
    name: "callroom",
    model: CallRoom,
    // read-only: participants/status of a consultation are a privacy
    // boundary, so rooms are created and ended only through callService
    // (/admin/call/create, /admin/call/:id/end), never edited or deleted raw
    all: true,
    one: true,
    edit: false,
    remove: false,
    create: false,
    accessLevel: "CallRoom",
    allPopulation: { path: "participants" },
  },
  {
    name: "redirection",
    model: Redirection,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    accessLevel: "Redirection",
  },
  {
    name: "shortlink",
    model: ShortLink,
    accessLevel: "ShortLink",
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
  },
  {
    name: "disease",
    model: Disease,
    accessLevel: "Disease",
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    onePopulation: [
      { path: "drugs" },
      { path: "sameAs" },
      { path: "specialities" },
      { path: "symptoms" },
      { path: "parts" },
    ],
    editBodyMutator: autoController.mutateCompoundFields([
      "symptoms",
      "specialities",
      "drugs",
      "sameAs",
      "parts",
    ]),
  },
  {
    name: "drug",
    model: Drug,
    accessLevel: "Drug",
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    // the form sends "similar drugs" as a JSON string
    editBodyMutator: autoController.mutateCompoundFields(["sameAs"]),
  },
  {
    name: "symptom",
    model: Symptom,
    accessLevel: "Symptom",
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    onePopulation: [{ path: "part" }, { path: "sameAs" }],
    editBodyMutator: autoController.mutateCompoundFields(["part", "sameAs"]),
  },
  {
    name: "part",
    model: Part,
    accessLevel: "Part",
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
  },
  {
    name: "doctorfaq",
    model: DoctorFaq,
    accessLevel: "DoctorFaq",
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
    allPopulation: [{ path: "doctor" }],
    onePopulation: { path: "doctor" },
  },
  { name: "taminServiceType", model: TaminServiceType, all: true, edit: true },
  {
    name: "taminPrescriptionType",
    model: TaminPrescriptionType,
    all: true,
    edit: true,
  },
  { name: "taminService", model: TaminService, all: true, edit: true },
  { name: "taminParTaref", model: TaminParTaref, all: true, edit: true },
  { name: "taminDrugUsage", model: TaminDrugUsage, all: true, edit: true },
  {
    name: "taminDrugInstruction",
    model: TaminDrugInstruction,
    all: true,
    edit: true,
  },
  { name: "taminDrugAmount", model: TaminDrugAmount, all: true, edit: true },
  { name: "taminPhPlan", model: TaminPhPlan, all: true, edit: true },
  { name: "taminPhIllness", model: TaminPhIllness, all: true, edit: true },
  { name: "taminIcid", model: TaminIcid, all: true, edit: true },
  { name: "taminComplaint", model: TaminComplaint, all: true, edit: true },
  { name: "taminSpec", model: TaminSpec, all: true, edit: true },
  {
    name: "advertisement",
    model: Advertisement,
    all: true,
    create: true,
    one: true,
    edit: true,
    remove: true,
    editBodyMutator: autoController.mutateCompoundFields(["positions"]),
    accessLevel: "Advertisement",
  },
  {
    name: "service",
    model: Service,
    all: true,
    create: true,
    one: true,
    edit: true,
    remove: true,
    allPopulation: [{ path: "owner" }, { path: "category" }],
    onePopulation: { path: "owner" },
    editBodyMutator: autoController.mutateCompoundFields(["sameAs"]),
    accessLevel: "Service",
  },
  {
    name: "faq",
    model: Faq,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
    allPopulation: [{ path: "category" }],
  },
  { name: "ollamaModel", model: OllamaModel, all: true },
  {
    name: "globalOllamaSettings",
    model: GlobalOllamaSettings,
    singleton: true,
    all: true,
    edit: true,
    allPopulation: { path: "defaultModel" },
  },
  {
    // Runtime configuration that used to live only in .env (SIP creds,
    // Podium API keys, booking/analytics/reservation/call tuning values) -
    // see Models/AppConfig.ts and Lib/appConfig.ts. No accessLevel set on
    // purpose: only the "admin" role (not "notadmin") can read/write this.
    name: "appConfig",
    model: AppConfig,
    singleton: true,
    edit: true,
    // the NexaMap key is read masked (Models/AppConfig.ts): a masked value
    // posted back is not a new key. The map settings tab saves it through
    // /admin/map/settings, which also refreshes the map client's cache.
    editBodyMutator: catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
      for (const k of APP_CONFIG_SECRETS) if (req.body && isMaskedSecret(req.body[k])) delete req.body[k];
      // online payment is switched on only with the gateway filled in;
      // otherwise the switch reads "on" while checkout hides the gateway
      const body = (req.body || {}) as Record<string, unknown>;
      const current = await AppConfig.findOne()
        .select("sepEnabled sepTerminalId sepCallbackBaseUrl siteBaseUrl")
        .lean<Record<string, unknown>>();
      const pick = (k: string) => (body[k] !== undefined ? body[k] : current?.[k]);
      const on = pick("sepEnabled") === true || pick("sepEnabled") === "true";
      const filled = (k: string) => !!String(pick(k) ?? "").trim();
      if (on && !(filled("sepTerminalId") && filled("sepCallbackBaseUrl") && filled("siteBaseUrl")))
        return next(
          new AppError("برای روشن کردن پرداخت آنلاین، شماره ترمینال، آدرس بازگشت و آدرس سایت را وارد کنید", 400),
        );
      clearNexaMapSettingsCache();
      next();
    }),
  },
  {
    // IPPanel SMS gateway pattern codes (Lib/sendSms.ts / Lib/smsPatterns.ts)
    // - see Models/SmsPatterns.ts. No accessLevel set on purpose, mirroring
    // appConfig above: only the "admin" role (not "notadmin") can read/write
    // this.
    name: "smsPatterns",
    model: SmsPatterns,
    singleton: true,
    edit: true,
  },
  {
    name: "botInstruction",
    model: BotInstruction,
    all: true,
    create: true,
    edit: true,
    remove: true,
    one: true,
  },
  {
    name: "serviceCategory",
    model: ServiceCategory,
    all: true,
    edit: true,
    remove: true,
    one: true,
    create: true,
    accessLevel: "Service",
    // a doctor's suggestion is reviewed through its own one-way actions
    // (/admin/serviceCatalog), and a name is never entered twice
    protectedFields: ["pendingReview", "suggestedBy"],
    editBodyMutator: serviceCatalogController.dedupeServiceCategory,
  },
  {
    name: "province",
    model: Province,
    all: true,
    edit: true,
    remove: true,
    one: true,
    create: true,
  },
  {
    name: "city",
    model: City,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
  },
  {
    name: "district",
    model: District,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
  },
  {
    name: "becomeParaClinic",
    accessLevel: "BecomeParaClinicRequest",
    model: BecomeParaClinicRequest,
    all: true,
    one: true,
    edit: true,
    remove: true,
    allPopulation: { path: "user" },
    onePopulation: { path: "user" },
    // approval runs through /admin/become<kind>/:id/approve (it creates the
    // centre); a raw edit may only reject or reopen
    editSchema: lockedStatusEditSchema,
  },
  {
    name: "paraClinic",
    protectedFields: PROVIDER_OWNED,
    accessLevel: "ParaClinic",
    model: ParaClinic,
    all: true,
    edit: true,
    remove: true,
    one: true,
    create: true,
    allPopulation: { path: "user" },
    onePopulation: { path: "user" },
    editBodyMutator: autoController.mutateCompoundFields([
      "tags",
      "location",
      "insurances",
    ]),
  },
  {
    name: "productCategory",
    model: ProductCategory,
    all: true,
    edit: true,
    remove: true,
    one: true,
    create: true,
    accessLevel: "Product",
  },
  {
    name: "Product",
    model: Product,
    all: true,
    edit: true,
    one: true,
    create: true,
    remove: true,
    editBodyMutator: autoController.mutateCompoundFields(["sameAs"]),
    // the linked drug (2026-10): its name for the form, its prescription
    // status for the "requires prescription" virtual
    onePopulation: { path: "drug", select: "name prescriptionStatus" },
    accessLevel: "Product",
  },
  {
    name: "productImage",
    model: ProductImage,
    all: true,
    edit: true,
    one: true,
    create: true,
    remove: true,
    accessLevel: "Product",
  },
  {
    name: "productSeller",
    model: ProductSeller,
    all: true,
    edit: true,
    one: true,
    create: true,
    remove: true,
    // the product's name too: a package form lists what its pharmacy sells
    allPopulation: [{ path: "seller" }, { path: "product", select: "name" }],
    accessLevel: "Product",
  },
  {
    name: "productSpec",
    model: ProductSpec,
    all: true,
    one: true,
    edit: true,
    remove: true,
    create: true,
    accessLevel: "Product",
  },
  {
    name: "clinicCategory",
    model: ClinicCategory,
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
  },
  {
    name: "diseaseCategory",
    model: DiseaseCategory,
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
  },
  {
    name: "diseaseTag",
    model: DiseaseTag,
    all: true,
    edit: true,
    one: true,
    create: true,
    remove: true,
  },
  {
    name: "drugTag",
    model: DrugTag,
    all: true,
    edit: true,
    remove: true,
    create: true,
    one: true,
  },
  {
    name: "clinicTag",
    model: ClinicTag,
    all: true,
    edit: true,
    remove: true,
    one: true,
    create: true,
  },
  {
    name: "hospital",
    protectedFields: PROVIDER_OWNED,
    model: Hospital,
    all: true,
    edit: true,
    remove: true,
    one: true,
    create: true,
    accessLevel: "Hospital",
    allPopulation: { path: "user" },
    onePopulation: { path: "user" },
    editBodyMutator: autoController.mutateCompoundFields([
      "tags",
      "location",
      "services",
      "insurances",
      "certificates",
    ]),
  },
  {
    name: "hospitalCategory",
    model: HospitalCategory,
    all: true,
    edit: true,
    one: true,
    remove: true,
    create: true,
  },
  {
    name: "hospitalTag",
    model: HospitalTag,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
  },
  {
    name: "test",
    model: Test,
    all: true,
    edit: true,
    one: true,
    remove: true,
    create: true,
    accessLevel: "Test",
  },
  {
    name: "testCategory",
    model: TestCategory,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
    accessLevel: "Test",
  },
  {
    name: "paraClinicTest",
    model: ParaClinicTest,
    // a tab of the ParaClinic record page: the same right (it was admin-only,
    // so staff who may edit the record saw that tab fail)
    accessLevel: "ParaClinic",
    all: true,
    edit: true,
    remove: true,
    create: true,
    one: true,
    allPopulation: { path: "test" },
  },
  {
    name: "paraClinicCategory",
    model: ParaClinicCategory,
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
  },
  {
    name: "paraClinicTag",
    model: ParaClinicTag,
    all: true,
    edit: true,
    remove: true,
    create: true,
    one: true,
  },
  {
    name: "servicePackage",
    model: ServicePackage,
    all: true,
    edit: true,
    remove: true,
    create: true,
    one: true,
    allPopulation: { path: "owner" },
    editBodyMutator: chainHandlers(
      autoController.mutateCompoundFields(["services", "sameAs"]),
      packageItemsOwned(ServicePackage, "services"),
    ),
    accessLevel: "Service",
  },
  {
    name: "productPackage",
    model: ProductPackage,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
    allPopulation: { path: "owner" },
    editBodyMutator: chainHandlers(
      autoController.mutateCompoundFields(["products", "sameAs"]),
      packageItemsOwned(ProductPackage, "products"),
    ),
    accessLevel: "Product",
  },
  {
    name: "symptomCategory",
    model: SymptomCategory,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
  },
  // Verified visit reviews of doctors (2026-09): admins approve / reject
  // them before they go public. Only the status is editable - the text is
  // the patient's own words and isn't rewritten by staff.
  {
    name: "doctorFeedback",
    model: DoctorFeedBack,
    all: true,
    one: true,
    edit: true,
    remove: true,
    accessLevel: "DoctorFeedback",
    // a rejection carries its reason (bulk moderation: /admin/support)
    editSchema: z.strictObject({
      status: z.enum(doctorFeedbackStatuses),
      rejectReason: z.string().trim().max(500).optional(),
    }),
    allPopulation: [
      { path: "doctor", select: "firstName lastName slug" },
      { path: "user", select: "phone" },
      { path: "reservation", select: "date start sessionType" },
    ],
    onePopulation: [
      { path: "doctor", select: "firstName lastName slug" },
      { path: "user", select: "phone" },
      { path: "reservation", select: "date start sessionType" },
    ],
  },
  {
    name: "comment",
    model: Comment,
    all: true,
    edit: true,
    remove: true,
    one: true,
    accessLevel: "Comment",
    // moderation only: an admin approves or rejects what a user wrote, and
    // never rewrites it (or posts one in someone's name)
    editSchema: z.strictObject({
      status: z.enum(["Pending", "Approved", "Rejected"]),
      rejectReason: z.string().trim().max(500).optional(),
    }),
    allPopulation: [{ path: "author" }, { path: "resource" }],
    onePopulation: [
      { path: "author" },
      { path: "resource" },
      { path: "upvotes" },
    ],
  },
  {
    name: "hospitalClinic",
    model: HospitalClinic,
    // a tab of the Hospital record page: the same right (it was admin-only,
    // so staff who may edit the record saw that tab fail)
    accessLevel: "Hospital",
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
    allPopulation: { path: "clinic" },
  },
  {
    name: "insuranceCategory",
    model: InsuranceCategory,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
  },
  {
    name: "insuranceTag",
    model: InsuranceTag,
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
  },
  {
    name: "insurancePlan",
    model: InsurancePlan,
    // the «طرح‌ها» tab of the insurance page: the same right
    accessLevel: "Insurance",
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
    editBodyMutator: autoController.mutateCompoundFields(["features"]),
  },
  {
    name: "faqCategory",
    model: FaqCategory,
    all: true,
    edit: true,
    remove: true,
    create: true,
    one: true,
  },
  {
    name: "contactRequest",
    model: ContactRequest,
    accessLevel: "ContactRequest",
    allPopulation: [
      { path: "handledBy", select: "phone username" },
      { path: "ticket", select: "title status" },
    ],
    onePopulation: [
      { path: "handledBy", select: "phone username" },
      { path: "ticket", select: "title status" },
    ],
    all: true,
    edit: true,
    // the visitor's message is a record; staff only move its status
    editSchema: z.strictObject({ status: z.enum(contactRequestStatuses) }),
    remove: true,
    one: true,
  },
  {
    name: "privacySection",
    model: PrivacySection,
    all: true,
    edit: true,
    create: true,
    one: true,
    remove: true,
  },
  {
    name: "aboutPartner",
    model: AboutPartner,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
  },
  {
    name: "aboutTeam",
    model: AboutTeam,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
  },
  {
    name: "aboutWhy",
    model: AboutWhy,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
  },
  {
    name: "testify",
    model: Testify,
    all: true,
    edit: true,
    create: true,
    remove: true,
    one: true,
  },
  {
    name: "pageMeta",
    model: PageMeta,
    all: true,
    one: true,
    edit: true,
    create: true,
    remove: true,
    editBodyMutator: autoController.mutateCompoundFields([
      "keywords",
      "webSchema",
    ]),
    accessLevel: "PageMeta",
  },
  {
    // assignment, priority and internal notes go through /admin/support
    // (internal notes are never sent to the user's own ticket API)
    name: "ticket",
    model: Ticket,
    accessLevel: "Ticket",
    all: true,
    one: true,
    // status changes only through /admin/support/tickets/<id> (one path)
    remove: true,
    allPopulation: { path: "submittedBy" },
    onePopulation: [{ path: "submittedBy" }, { path: "messages" }],
  },
  {
    // a staff reply: always marked as support's, whoever sends it (a
    // delegated staff member could otherwise post in the user's name)
    name: "ticketmessage",
    model: TicketMessage,
    accessLevel: "Ticket",
    all: true,
    one: true,
    create: true,
    remove: true,
    editSchema: z
      .object({
        ticket: z.string().regex(/^[0-9a-fA-F]{24}$/),
        content: z.string().trim().min(1).max(5000),
      })
      .transform((v) => ({ ...v, isAdmin: true })),
  },
  {
    name: "notification",
    accessLevel: "Notification",
    model: Notification,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    // sent is sent: an edit may fix the wording, never who got it, its
    // source or whether it was read; one the admin writes is the admin's
    // (it could otherwise pass as a "System" message)
    editBodyMutator: (req, _res, next) => {
      const body = (req.body || {}) as Record<string, unknown>;
      if (req.params.nodeId) {
        for (const k of ["user", "source", "isRead", "createdBy"]) delete body[k];
        const set = body.$set as Record<string, unknown> | undefined;
        if (set) for (const k of ["user", "source", "isRead", "createdBy"]) delete set[k];
      } else {
        body.source = "Admin";
        body.createdBy = req.user?._id;
      }
      next();
    },
    allPopulation: [{ path: "user" }, { path: "createdBy" }],
    onePopulation: [{ path: "user" }, { path: "createdBy" }],
  },
  // Read-only(ish) admin visibility into who has web push enabled, for the
  // "Test push notifications" admin page - subscriptions themselves are
  // only ever created via /user/push/subscribe (see userController.ts).
  // remove is allowed so an admin can clear a stale/duplicate one while
  // testing, same as PushSubscription.deleteOne on a 404/410 delivery
  // failure in Services/pushNotificationService.ts.
  {
    name: "pushsubscription",
    model: PushSubscription,
    all: true,
    remove: true,
    allPopulation: { path: "user" },
  },
  {
    name: "blogTag",
    model: BlogTag,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
  },
  { name: "blogRrs", model: BlogRRS, all: true },
  {
    // Per-pharmacy commission rate (2026-08) - see
    // Models/PharmacyFinanceSettings.ts. One doc per pharmacy (unique on
    // `pharmacy`); a pharmacy with no doc here falls back to
    // globalFinanceSettings.defaultPharmacyCommissionPercent below. Sibling
    // entries below for doctor/paraClinic. No accessLevel set on purpose,
    // matching appConfig: only the "admin" role (not "notadmin") can
    // read/write commission rates.
    name: "pharmacyFinanceSettings",
    model: PharmacyFinanceSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "pharmacy" },
    onePopulation: { path: "pharmacy" },
  },
  {
    name: "doctorFinanceSettings",
    model: DoctorFinanceSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "doctor" },
    onePopulation: { path: "doctor" },
  },
  {
    name: "paraClinicFinanceSettings",
    model: ParaClinicFinanceSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "paraClinic" },
    onePopulation: { path: "paraClinic" },
  },
  {
    // Platform-wide default commission rates (2026-08) - see
    // Models/GlobalFinanceSettings.ts. Fallback used when an organization
    // has no *FinanceSettings doc of its own above.
    name: "globalFinanceSettings",
    model: GlobalFinanceSettings,
    singleton: true,
    edit: true,
  },
  {
    // Per-pharmacy tax rate (2026-09) - see Models/PharmacyTaxSettings.ts.
    // One doc per pharmacy (unique on `pharmacy`); a pharmacy with no doc
    // here falls back to globalTaxSettings.defaultPharmacyTaxPercent below.
    // Sibling entries below for doctor/clinic/paraClinic. No accessLevel
    // set on purpose, matching pharmacyFinanceSettings above: only the
    // "admin" role (not "notadmin") can read/write tax rates - regular
    // buyers only ever see the already-resolved effective rate via
    // Lib/taxSettings.ts, never this admin CRUD surface directly.
    name: "pharmacyTaxSettings",
    model: PharmacyTaxSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "pharmacy" },
    onePopulation: { path: "pharmacy" },
  },
  {
    name: "doctorTaxSettings",
    model: DoctorTaxSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "doctor" },
    onePopulation: { path: "doctor" },
  },
  {
    // Clinic owns no sellable/payable item today - see
    // Models/ClinicTaxSettings.ts's comment. Registered the same as its
    // siblings for admin-UI parity (2026-09 user decision), even though
    // nothing reads this via Lib/taxSettings.ts yet.
    name: "clinicTaxSettings",
    model: ClinicTaxSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "clinic" },
    onePopulation: { path: "clinic" },
  },
  {
    // Per-hospital visit tax (2026-10, Models/HospitalTaxSettings.ts): read
    // by Lib/taxSettings.ts getVisitTaxPercent for in-person visits in a
    // hospital office. Admin only, like its siblings.
    name: "hospitalTaxSettings",
    model: HospitalTaxSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "hospital" },
    onePopulation: { path: "hospital" },
  },
  {
    name: "paraClinicTaxSettings",
    model: ParaClinicTaxSettings,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "paraClinic" },
    onePopulation: { path: "paraClinic" },
  },
  {
    // Platform-wide default tax rates (2026-09) - see
    // Models/GlobalTaxSettings.ts. Fallback used when an organization has no
    // *TaxSettings doc (or, for doctor, no value on the relevant field) of
    // its own above.
    name: "globalTaxSettings",
    model: GlobalTaxSettings,
    singleton: true,
    edit: true,
  },
  {
    // Doctor license/subscription tiers (2026-09) - see
    // Models/BaseDoctorLicense.ts. Flat admin-managed catalog, not tied to
    // a single doctor.
    name: "baseDoctorLicense",
    model: BaseDoctorLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    editBodyMutator: planRules(BaseDoctorLicense),
  },
  {
    // Per-doctor license record (2026-09) - see
    // Models/DoctorProfileLicense.ts. One doc per doctor (unique on
    // `owner`), fetched by the admin doctor-profile "License" tab via
    // GET /auto/doctorProfileLicense?owner=<doctorProfileId>, same pattern
    // as doctorFinanceSettings above.
    name: "doctorProfileLicense",
    model: DoctorProfileLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "owner" },
    onePopulation: { path: "owner" },
    editBodyMutator: chainHandlers(licenseFromPlan(DoctorProfileLicense, BaseDoctorLicense), licensePeriod(DoctorProfileLicense)),
  },
  {
    // Pharmacy license/subscription tiers (2026-09) - see
    // Models/BasePharmacyLicense.ts. Flat admin-managed catalog, not tied to
    // a single pharmacy. Mirrors baseDoctorLicense above.
    name: "basePharmacyLicense",
    model: BasePharmacyLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    editBodyMutator: planRules(BasePharmacyLicense),
  },
  {
    // Per-pharmacy license record (2026-09) - see
    // Models/PharmacyProfileLicense.ts. One doc per pharmacy (unique on
    // `owner`), fetched by the admin pharmacy-profile "License" tab via
    // GET /auto/pharmacyProfileLicense?owner=<pharmacyId>, mirrors
    // doctorProfileLicense above.
    name: "pharmacyProfileLicense",
    model: PharmacyProfileLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "owner" },
    onePopulation: { path: "owner" },
    editBodyMutator: chainHandlers(licenseFromPlan(PharmacyProfileLicense, BasePharmacyLicense), licensePeriod(PharmacyProfileLicense)),
  },
  {
    // Clinic license/subscription tiers (2026-09) - see
    // Models/BaseClinicLicense.ts. Flat admin-managed catalog, not tied to a
    // single clinic. Mirrors baseDoctorLicense/basePharmacyLicense above.
    name: "baseClinicLicense",
    model: BaseClinicLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    editBodyMutator: planRules(BaseClinicLicense),
  },
  {
    // Per-clinic license record (2026-09) - see
    // Models/ClinicProfileLicense.ts. One doc per clinic (unique on
    // `owner`), fetched by the admin clinic-profile "License" tab via
    // GET /auto/clinicProfileLicense?owner=<clinicId>, mirrors
    // doctorProfileLicense/pharmacyProfileLicense above.
    name: "clinicProfileLicense",
    model: ClinicProfileLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "owner" },
    onePopulation: { path: "owner" },
    editBodyMutator: chainHandlers(licenseFromPlan(ClinicProfileLicense, BaseClinicLicense), licensePeriod(ClinicProfileLicense)),
  },
  {
    // Hospital license/subscription tiers (2026-09) - see
    // Models/BaseHospitalLicense.ts. Flat admin-managed catalog, not tied to
    // a single hospital. Mirrors baseDoctorLicense/basePharmacyLicense/
    // baseClinicLicense above.
    name: "baseHospitalLicense",
    model: BaseHospitalLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    editBodyMutator: planRules(BaseHospitalLicense),
  },
  {
    // Per-hospital license record (2026-09) - see
    // Models/HospitalProfileLicense.ts. One doc per hospital (unique on
    // `owner`), fetched by the admin hospital-profile "License" tab via
    // GET /auto/hospitalProfileLicense?owner=<hospitalId>, mirrors
    // doctorProfileLicense/pharmacyProfileLicense/clinicProfileLicense above.
    name: "hospitalProfileLicense",
    model: HospitalProfileLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "owner" },
    onePopulation: { path: "owner" },
    editBodyMutator: chainHandlers(licenseFromPlan(HospitalProfileLicense, BaseHospitalLicense), licensePeriod(HospitalProfileLicense)),
  },
  {
    // Insurance license/subscription tiers (2026-09) - see
    // Models/BaseInsuranceLicense.ts. Flat admin-managed catalog, not tied
    // to a single insurance. Mirrors baseHospitalLicense above.
    name: "baseInsuranceLicense",
    model: BaseInsuranceLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    editBodyMutator: planRules(BaseInsuranceLicense),
  },
  {
    // Plan promotions - the launch discount (2026-10, Models/
    // LicensePromotion.ts, priced by Lib/licenseQuote.ts). Same audience as
    // the plan catalog above (super admin only).
    name: "licensePromotion",
    model: LicensePromotion,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    protectedFields: ["redemptions"],
    editBodyMutator: promotionRules,
  },
  {
    // Per-insurance license record (2026-09) - see
    // Models/InsuranceProfileLicense.ts. One doc per insurance (unique on
    // `owner`), fetched by the admin insurance-profile "License" tab via
    // GET /auto/insuranceProfileLicense?owner=<insuranceId>, mirrors
    // hospitalProfileLicense above.
    name: "insuranceProfileLicense",
    model: InsuranceProfileLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "owner" },
    onePopulation: { path: "owner" },
    editBodyMutator: chainHandlers(licenseFromPlan(InsuranceProfileLicense, BaseInsuranceLicense), licensePeriod(InsuranceProfileLicense)),
  },
  {
    // ParaClinic license/subscription tiers (2026-09) - see
    // Models/BaseParaClinicLicense.ts. Flat admin-managed catalog, not tied
    // to a single paraClinic. Mirrors
    // baseDoctorLicense/basePharmacyLicense/baseClinicLicense above.
    name: "baseParaClinicLicense",
    model: BaseParaClinicLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    editBodyMutator: planRules(BaseParaClinicLicense),
  },
  {
    // Per-paraClinic license record (2026-09) - see
    // Models/ParaClinicProfileLicense.ts. One doc per paraClinic (unique on
    // `owner`), fetched by the admin paraClinic-profile "License" tab via
    // GET /auto/paraClinicProfileLicense?owner=<paraClinicId>, mirrors
    // doctorProfileLicense/pharmacyProfileLicense/clinicProfileLicense
    // above.
    name: "paraClinicProfileLicense",
    model: ParaClinicProfileLicense,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    allPopulation: { path: "owner" },
    onePopulation: { path: "owner" },
    editBodyMutator: chainHandlers(licenseFromPlan(ParaClinicProfileLicense, BaseParaClinicLicense), licensePeriod(ParaClinicProfileLicense)),
  },
  {
    // Per-staff-account (role !== "user", i.e. "admin"/"notadmin") alert
    // preferences (2026-09) - see Models/UserAlert.ts. One doc per user
    // (unique on `user`). No accessLevel set on purpose, matching
    // notification/appConfig above: only the "admin" role manages who gets
    // alerted about what.
    name: "userAlert",
    model: UserAlert,
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
    // alerts go to staff only (Services/userAlertService.ts skips anyone
    // else, so a user's row would be saved and never fire)
    editBodyMutator: catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
      const target = (req.body?.user ?? req.body?.$set?.user) as unknown;
      if (target) {
        const u = await User.findById(String((target as { _id?: unknown })?._id ?? target)).select("role").lean<{ role?: string }>();
        if (!u || !["admin", "notadmin"].includes(String(u.role)))
          return next(new AppError("هشدارها فقط برای کارکنان (مدیر یا کارمند پنل) است", 400));
      }
      next();
    }),
    allPopulation: { path: "user" },
    onePopulation: { path: "user" },
  },
  {
    // Singleton bucket of static image slots used around the app (2026-09) -
    // see Models/StaticImages.ts. Field names (homeMain/onboardingMain/
    // onboadingSecurity/...) are declared in that file's staticImageFields
    // array; each is a plain String path saved via uploadController's
    // saveUplaodsToBody, same upload flow as every other `image` field. No
    // accessLevel set on purpose, matching globalFinanceSettings/
    // globalTaxSettings/smsPatterns above: only the "admin" role manages it.
    name: "staticImages",
    model: StaticImages,
    singleton: true,
    edit: true,
  },
  {
    // Per-segment booking descriptions shown in the booking flow (2026-09) -
    // see Models/BookingDescription.ts. Flat admin-managed list, ordered and
    // filtered by `segment`. Delegable to staff (BookingDescription).
    name: "bookingDescription",
    model: BookingDescription,
    accessLevel: "BookingDescription",
    all: true,
    one: true,
    create: true,
    edit: true,
    remove: true,
  },
];

// Catalogs picked from other forms (2026-09 audit: a staff editor with Blog
// or Disease rights opened the form and its tag / category select spun
// forever on a 403). They are lookups any staff member may list; creating
// or editing one (inline from the form, too) follows the access level of
// the record that uses it.
const lookupAccess: Record<string, AccessLevelModel | null> = {
  blogTag: "Blog", blogcategory: "BlogCategory",
  diseaseCategory: "Disease", diseaseTag: "Disease",
  symptomCategory: "Symptom", part: "Part",
  drugTag: "Drug",
  clinicTag: "Clinic", clinicCategory: "Clinic",
  hospitalTag: "Hospital", hospitalCategory: "Hospital",
  paraClinicTag: "ParaClinic", paraClinicCategory: "ParaClinic",
  insuranceTag: "Insurance", insuranceCategory: "Insurance",
  faq: "Faq", faqCategory: "Faq",
  province: null, city: null, district: null,
  serviceCategory: null, productCategory: null, testCategory: null,
  speciality: "Sepciality",
};
for (const segment of map) {
  if (!(segment.name in lookupAccess)) continue;
  segment.lookup = true;
  const access = lookupAccess[segment.name];
  if (access && !segment.accessLevel) segment.accessLevel = access;
}

// Delete integrity (Lib/refIntegrity.ts): catalogs other records point at
// (places, categories, tests, products, insurances, body parts) refuse the
// delete while in use; labels (tags) and content cross-links are detached
// from the items that carry them. A segment's own guard wins.
const blockWhileUsed = [
  "province", "city", "district",
  "blogcategory", "faqCategory", "diseaseCategory", "symptomCategory",
  "serviceCategory", "productCategory", "clinicCategory", "hospitalCategory",
  "paraClinicCategory", "insuranceCategory", "testCategory",
  "test", "Product", "insurance", "insurancePlan", "part", "service",
  "clinic", "hospital", "pharmacy", "paraClinic",
  // a plan providers still hold (their license points at it)
  "baseDoctorLicense", "baseClinicLicense", "baseHospitalLicense",
  "basePharmacyLicense", "baseParaClinicLicense", "baseInsuranceLicense",
  // a role still held by staff (UserAccessLevel rows)
  "accesslevel",
];
const detachOnDelete = [
  "clinicTag", "hospitalTag", "paraClinicTag", "insuranceTag", "diseaseTag",
  "drugTag", "blogTag", "blog", "disease", "symptom", "drug", "servicePackage",
  "productPackage",
  // a centre's department: its doctors stay members, without a department
  "clinicdepartment", "hospitaldepartment",
];
for (const segment of map) {
  if (!segment.remove || segment.removeGuard) continue;
  if (blockWhileUsed.includes(segment.name))
    segment.removeGuard = blockIfReferenced(segment.model.modelName);
  else if (detachOnDelete.includes(segment.name))
    segment.removeGuard = detachReferences(segment.model.modelName);
}

// the default plan is what every provider without a paid plan runs on: it
// is never deleted while it is the default (2026-10)
const planSegments = [
  "baseDoctorLicense", "baseClinicLicense", "baseHospitalLicense",
  "basePharmacyLicense", "baseParaClinicLicense", "baseInsuranceLicense",
];
for (const segment of map) {
  if (!segment.remove || !planSegments.includes(segment.name)) continue;
  const previous = segment.removeGuard;
  const model = segment.model;
  segment.removeGuard = async (nodeId: string) => {
    const plan = await model.findById(nodeId).select("isDefault").lean<{ isDefault?: boolean }>();
    if (plan?.isDefault)
      return "پلن پیش‌فرض را نمی‌توان حذف کرد؛ اول پلن دیگری را پیش‌فرض کنید";
    return previous ? previous(nodeId) : null;
  };
}

// a provider request under review is decided (approve / reject with a
// reason), never deleted: a delete closed it with no decision and no notice
const requestSegments = [
  "becomedoctor", "becomeclinic", "becomehospital", "becomeinsurance",
  "becomepharmacy", "becomeParaClinic", "clinicaddition", "hospitaladdition",
  "pharmacyaddition", "insuranceaddition", "doctorjoinclinic", "doctorjoinhospital",
];
for (const segment of map) {
  if (!segment.remove || !requestSegments.includes(segment.name)) continue;
  const previous = segment.removeGuard;
  segment.removeGuard = async (nodeId: string) => {
    const doc = await segment.model.findById(nodeId).select("status").lean<{ status?: string }>();
    if (doc?.status === "Pending")
      return "درخواست در انتظار بررسی را نمی‌توان حذف کرد؛ آن را تأیید یا رد کنید";
    return previous ? previous(nodeId) : null;
  };
}

registerAuditSingletons(map.filter((s) => s.singleton).map((s) => s.name));

const withAccessLevelRoles = ["admin", "notadmin"] as const;
const noAccessLevelRoles = ["admin"] as const;

// DB-content translations (see contentTranslationController). Registered
// before the generic routes so "/<segment>/_translations" is not taken for
// a nodeId.
const translationSegments = map.filter(
  (segment) =>
    !segment.singleton && contentTranslationController.fieldsOf(segment.model),
);

router
  .route("/_translations")
  .get(
    authController.protect,
    authController.restrictTo(...withAccessLevelRoles),
    contentTranslationController.getOverview(translationSegments),
  );
router
  .route("/_translations/bulk")
  .all(authController.protect, authController.restrictTo(...noAccessLevelRoles))
  .get(contentTranslationController.bulkStatus)
  .post(contentTranslationController.startBulk(translationSegments))
  .delete(contentTranslationController.stopBulk);

for (const segment of translationSegments) {
  const guard = (op: "readAll" | "readOne" | "update") => [
    authController.protect,
    authController.restrictTo(
      ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
    ),
    ...(segment.accessLevel
      ? [authController.hasPermission({ model: segment.accessLevel, op })]
      : []),
  ];
  router
    .route(`/${segment.name}/_translations`)
    .get(...guard("readAll"), contentTranslationController.listRecords(segment));
  router
    .route(`/${segment.name}/:nodeId/_translations`)
    .get(...guard("readOne"), contentTranslationController.getRecord(segment))
    .post(...guard("update"), contentTranslationController.saveRecord(segment));
  router
    .route(`/${segment.name}/:nodeId/_translations/auto`)
    .post(
      ...guard("update"),
      contentTranslationController.autoTranslateRecord(segment),
    );
}

for (let i = 0; i < map.length; i++) {
  const segment = map[i];
  if (segment.singleton) {
    router.route(`/${segment.name}`).get(
      authController.protect,
      authController.restrictTo(
        ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
      ),
      ...(segment.accessLevel
        ? [
            authController.hasPermission({
              model: segment.accessLevel,
              op: "readOne",
            }),
          ]
        : []),
      ...(segment.querySchema
        ? [autoController.validateQuery(segment.querySchema)]
        : []),
      autoController.getSingleton({
        model: segment.model,
        pop: segment.allPopulation,
      }),
    );
    if (segment.edit)
      router.route(`/${segment.name}`).post(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "update",
              }),
            ]
          : []),
        uploadController.upload.any(),
        uploadController.saveUplaodsToBody({ name: segment.name }),
        ...(segment.protectedFields ? [stripFields(segment.protectedFields)] : []),
        ...(segment.editBodyMutator ? [segment.editBodyMutator] : []),
        ...(segment.editSchema
          ? [autoController.validateBody(segment.editSchema)]
          : []),
        autoController.editSingleton({ model: segment.model }),
      );
  } else {
    if (segment.all)
      router.route(`/${segment.name}`).get(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel || segment.lookup
            ? withAccessLevelRoles
            : noAccessLevelRoles),
        ),
        ...(segment.accessLevel && !segment.lookup
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "readAll",
              }),
            ]
          : []),
        ...(segment.querySchema
          ? [autoController.validateQuery(segment.querySchema)]
          : []),
        autoController.getAll({
          model: segment.model,
          population: segment.allPopulation,
          selection: segment.allSelection,
        }),
      );
    if (segment.create)
      router.route(`/${segment.name}`).post(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "write",
              }),
            ]
          : []),
        uploadController.upload.any(),
        uploadController.saveUplaodsToBody({ name: segment.name }),
        ...(segment.protectedFields ? [stripFields(segment.protectedFields)] : []),
        ...(segment.editBodyMutator ? [segment.editBodyMutator] : []),
        ...(segment.editSchema
          ? [autoController.validateBody(segment.editSchema)]
          : []),
        autoController.create({ model: segment.model }),
      );
    if (segment.one)
      router.route(`/${segment.name}/:nodeId`).get(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "readOne",
              }),
            ]
          : []),
        ...(segment.querySchema
          ? [autoController.validateQuery(segment.querySchema)]
          : []),
        autoController.getOne({
          model: segment.model,
          pop: segment.onePopulation,
        }),
      );
    if (segment.edit)
      router.route(`/${segment.name}/:nodeId`).post(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "update",
              }),
            ]
          : []),
        uploadController.upload.any(),
        uploadController.saveUplaodsToBody({ name: segment.name }),
        ...(segment.protectedFields ? [stripFields(segment.protectedFields)] : []),
        ...(segment.editBodyMutator ? [segment.editBodyMutator] : []),
        ...(segment.editSchema
          ? [autoController.validateBody(segment.editSchema)]
          : []),
        autoController.edit({ model: segment.model }),
      );
    if (segment.remove)
      router.route(`/${segment.name}/:nodeId`).put(
        authController.protect,
        authController.restrictTo(
          ...(segment.accessLevel ? withAccessLevelRoles : noAccessLevelRoles),
        ),
        ...(segment.accessLevel
          ? [
              authController.hasPermission({
                model: segment.accessLevel,
                op: "delete",
              }),
            ]
          : []),
        autoController.remove({
          model: segment.model,
          guard: segment.removeGuard,
        }),
      );
  }
}

export default router;
