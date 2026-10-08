import { openNowIds, withOpenStatus, withOpenStatusOne } from "../Lib/openingHours";
import { deliveryAreasOf } from "../Lib/delivery";
import DoctorTaminCred from "../Models/DoctorTaminCred";
import { packageNeedsRx, productRxPopulate } from "../Lib/rxPrescription";
import { normalizePath } from "../Lib/normalizePath";
import InlineAdvertisement from "../Models/InlineAdvertisement";
import { NextFunction, Request, RequestHandler, Response } from "express";
import UserIdentity from "../Models/UserIdentity";
import DoctorFeedBack, { publicDoctorFeedbackMatch } from "../Models/DoctorFeedback";
import fs from "fs";
import path from "path";
import catchAsync from "../Lib/catchAsync";
import { looseServiceRegex, PUBLIC_SERVICE_CATEGORY } from "../Lib/serviceCatalog";
import Blog, { IBlog } from "../Models/Blog";
import { pageLimit } from "../Lib/enums";
import BlogCategory, { IBlogCategory } from "../Models/BlogCategory";
import { isPositiveInt } from "../Lib/validators";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import mongoose, {
  isValidObjectId,
  Model,
  ObjectId,
  PipelineStage,
} from "mongoose";
import { doctorIdsAccepting, getInsuranceNetworks } from "../Lib/insuranceNetwork";
import BizCrmSettings from "../Models/BizCrmSettings";
import { getSiteStats } from "../Lib/siteStats";
import Speciality, { ISpeciality } from "../Models/Speciality";
import ParaClinicTag from "../Models/ParaClinicTag";
import ParaClinicCategory from "../Models/ParaClinicCategory";
import DoctorProfile, { doctorProfileTiers } from "../Models/DoctorProfile";
import {
  getVisitTaxPercent,
} from "../Lib/taxSettings";
import { getStaticImages } from "../Lib/staticImages";
import DoctorSession, {
  doctorSessionTypes,
  patientStatuses,
} from "../Models/DoctorSession";
import {
  buildCommentableSort,
  commentableSortOptions,
  defaultCommentableSort,
  escapeRegex,
  getSessionDateKey,
  isLat,
  isLng,
  isPoint,
} from "../Lib/helpers";
import * as z from "zod";
import ShortLink from "../Models/ShortLink";
import { resolveTrackedClick } from "../Lib/business/crmSend";
import Redirection from "../Models/Redirection";
import Doctor, { IDoctor } from "../Models/Doctor";
import Symptom from "../Models/Symptom";
import Disease from "../Models/Disease";
import Drug from "../Models/Drug";
import SipCallSettings from "../Models/SipCallSettings";
import VoiceCallSettings from "../Models/voiceCallSetrtings";
import VideoCallSettings from "../Models/VideoCallSettings";
import InPersonSettings from "../Models/InPersonSettings";
import TextChatSettings from "../Models/TextChatSettings";
import DoctorShift from "../Models/DoctorShift";
import DoctorInsurance from "../Models/DoctorInsurance";
import ClinicDoctor from "../Models/ClinicDoctor";
import HospitalDoctor from "../Models/HospitalDoctor";
import HospitalDepartment from "../Models/HospitalDepartment";
import Office from "../Models/Office";
import DoctorFaq from "../Models/DoctorFaq";
import Insurance from "../Models/Insurance";
import AiExample from "../Models/AiExample";
import HomeIntroduction from "../Models/HomeIntroduction";
import {
  advertisementPositions,
  findAdvertisementsForPosition,
} from "../Models/Advertisement";
import Service from "../Models/Service";
import Faq from "../Models/Faq";
import BookingDescription from "../Models/BookingDescription";
import Clinic, { IClinic } from "../Models/Clinic";
import ClinicTag from "../Models/ClinicTag";
import HospitalTag from "../Models/HospitalTag";
import InsuranceTag from "../Models/InsuranceTag";
import SeoTemplate from "../Models/SeoTemplate";
import PageMeta, {
  isNodeResourceType,
  pageMetaListResourceTypes,
  pageMetaNodeResourceTypes,
} from "../Models/PageMeta";
import ServiceCategory, { IServiceCategory } from "../Models/ServiceCategory";
import { SomeType } from "zod/v4/core";
import { genders } from "../Models/BecomeDoctorRequest";
import Province, { IPolygon, IProvince } from "../Models/Geo/Province";
import District from "../Models/Geo/District";
import City from "../Models/Geo/City";
import { getDaysInRange, saturdayBasedDay } from "../Lib/dateUtils";
import { addDaysYmd, addTehranDays, parseTehranDay, startOfTehranDay, tehranParts, tehranYmd } from "../Lib/tehranTime";
import { attachNextSlots, earliestOrder, NextSlot } from "../Lib/nextSlot";
import { attachDoctorCards, doctorCards, doctorOffers, doctorsOffering } from "../Lib/doctorOffer";
import DoctorAvailability from "../Models/DoctorAvailability";
import Pharmacy from "../Models/Pharmacy";
import ProductCategory, { IProductCategory } from "../Models/ProductCategory";
import ClinicCategory from "../Models/ClinicCategory";
import DiseaseCategory from "../Models/DiseaseCategory";
import HospitalCategory, {
  IHospitalCategory,
} from "../Models/HospitalCategory";
import Hospital from "../Models/Hospital";
import ParaClinic from "../Models/Paraclinic";
import Test from "../Models/Test";
import ParaClinicTest from "../Models/ParaClinicTest";
import { labRating, liveTestOffers, offerCities, sortTestOffers } from "../Lib/testOffers";
import { resolveMyLicenseModules as resolvePharmacyModules } from "./pharmacyController";
import { normalizeLandLine, normalizeSocial, normalizeWebsite } from "../Lib/contactLinks";
import { resolveMyLicenseModules as resolveParaClinicModules } from "./paraClinicController";
import { outOfStockProducts } from "../Lib/pharmacyStock";
import Product from "../Models/Product";
import ProductSeller from "../Models/ProductSeller";
import ProductPackage from "../Models/ProductPackage";
import ServicePackage from "../Models/ServicePackage";
import InsuranceCategory, {
  IInsuranceCategory,
} from "../Models/InsuranceCategory";
import FaqCategory from "../Models/FaqCategory";
import TestCategory from "../Models/TestCategory";
import SymptomCategory from "../Models/SymptomCategory";
import ContactRequest, {
  contactRequestSubjects,
} from "../Models/ContactRequest";
import PrivacySection from "../Models/PrivacySection";
import AboutWhy from "../Models/AboutWhy";
import AboutPartner from "../Models/AboutPartner";
import AboutTeam from "../Models/AboutTeam";
import Testify from "../Models/Testify";
import BlogTag from "../Models/BlogTag";
import BlogRRS from "../Models/BlogRRS";
import { rankByTravel, travelPage } from "../Lib/nearbyTravel";
import { PUBLIC_MEDICAL, reviewerPopulation } from "../Lib/medicalContent";

const asArray = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => {
    if (v == null) return undefined;
    return Array.isArray(v) ? v : [v];
  }, z.array(schema));

// Fields the shared doctor card (FE Components/UI/DoctorCardAlt) reads.
const DOCTOR_CARD_FIELDS = [
  "firstName",
  "lastName",
  "slug",
  "avatar",
  "mainSpeciality",
  "averageScore",
  "feedbackCount",
  "recommendCount",
  "claimed",
  // the card's booking action and verified tick (Lib/doctorOffer.ts)
  "active",
  "status",
  "mcCode",
  "medicalSystemCode",
  "province",
  "voiceCallSettings",
  "sipCallSettings",
  "textChatSettings",
  "videoCallSettings",
  "inPersonSettings",
];

// GET /public/site (the old single-document UI texts) was removed in
// 2026-10: texts load from Translation through /public/texts.

// Dev-only diagnostics for the namespaced text content system: the frontend
// reports a key here whenever a component asks for a ContentKey that either
// (a) isn't declared in the namespace(s) it fetched, or (b) has no value on
// the TextContent document at all. Appends one line per report to a txt
// file at the backend project root for manual review — nothing structured,
// just something to skim and go fix the relevant namespace/key list.
//
// No-ops outside development so this can never write to disk (or accept
// unauthenticated POSTs that do anything) in production.
const MISSING_CONTENT_KEY_LOG_PATH = path.join(
  process.cwd(),
  "missing-content-keys.txt",
);

export const reportMissingContentKey: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (process.env.NODE_ENV !== "development") {
      res.status(200).json({ message: "reportMissingContentKey" });
      return;
    }
    const schema = z.strictObject({
      key: z.string().min(1),
      namespaces: z.array(z.string()).optional().default([]),
      reason: z.enum(["not-in-namespace", "no-value"]),
      path: z.string().optional(),
    });
    const { data, success } = schema.safeParse(req.body);
    if (!success) return next(new BadInputError());
    const line = `${new Date().toISOString()}\treason=${data.reason}\tkey=${
      data.key
    }\tnamespaces=[${data.namespaces.join(",")}]\tpath=${data.path || ""}\n`;
    await fs.promises.appendFile(MISSING_CONTENT_KEY_LOG_PATH, line, "utf8");
    res.status(200).json({ message: "reportMissingContentKey" });
  },
);

export const getHome: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const examples = await AiExample.find({ isActive: true }).sort({
      order: 1,
    });
    const introduction = await HomeIntroduction.find({ isActive: true }).sort({
      order: 1,
    });
    const specialities = await Speciality.find({
      isHome: true,
      active: true,
    }).sort({ order: 1 });
    // every live ad of the home slots: the admin's home overview counts
    // them (each slot loads its own ad on the page)
    const advertisements = await findAdvertisementsForPosition({
      position: ["home1", "home2", "home3", "home4", "home5", "home6"],
    });
    const popularDoctors = await DoctorProfile.find({
      active: true,
      popular: true,
    })
      .sort({ order: 1, _id: 1 })
      .select(DOCTOR_CARD_FIELDS)
      .populate([
        { path: "mainSpeciality" },
        { path: "voiceCallSettings" },
        { path: "sipCallSettings" },
        { path: "textChatSettings" },
        { path: "videoCallSettings" },
        { path: "inPersonSettings" },
        { path: "province" },
      ]);
    const services = (
      await Service.find({ isActive: true, isHome: true })
        .populate({
          path: "owner",
          match: { active: true },
          select: DOCTOR_CARD_FIELDS,
          populate: [{ path: "province", select: "name" }],
        })
        .populate({ path: "category" })
        .sort({ order: 1 })
    ).filter((el) => !!el.owner); // a deactivated doctor's services are hidden
    const faqs = await Faq.find({ isActive: true, isHome: true }).sort({
      order: 1,
    });
    const blogs = await Blog.find({ published: true, home: true })
      .sort({
        order: 1,
        _id: 1,
      })
      .populate({ path: "category" });
    const stats = await getSiteStats();
    const staticImages = await getStaticImages();
    res.status(200).json({
      message: "getHome",
      data: {
        stats,
        examples,
        introduction,
        specialities,
        advertisements,
        // the visit types the doctor really offers, and whether they can be
        // booked (Lib/doctorOffer.ts) - the same on every card
        popularDoctors: await doctorCards(popularDoctors),
        services,
        faqs,
        blogs,
        staticImages,
      },
    });
  },
);

export const getHeader: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const [
      blogCategories,
      productCategories,
      diseaseCategories,
      clinicCategories,
      paraClinicCategories,
      hospitalCategories,
      testCategories,
      serviceCategories,
      specialities,
      symptomCategories,
      insuranceCategories,
    ] = await Promise.all([
      BlogCategory.find().sort({ order: 1, _id: 1 }),
      ProductCategory.find({ isActive: true }).sort({ order: 1, _id: 1 }),
      DiseaseCategory.find({ isActive: true }).sort({ order: 1, _id: 1 }),
      ClinicCategory.find({ isActive: true }).sort({ order: 1, _id: 1 }),
      ParaClinicCategory.find({ isActive: true }).sort({ order: 1, _id: 1 }),
      HospitalCategory.find({ isActive: true }).sort({ order: 1, _id: 1 }),
      TestCategory.find({ isActive: true }).sort({ order: 1, _id: 1 }),
      // reviewed entries only: a doctor's suggestion waits for the admin
      ServiceCategory.find(PUBLIC_SERVICE_CATEGORY).sort({ order: 1, _id: 1 }),
      // specialities themselves (not "speciality groups"): a menu entry
      // opens that speciality's doctors - featured ones first
      Speciality.find({ active: true })
        .sort({ isHome: -1, order: 1, _id: 1 })
        .limit(HEADER_SPECIALITIES_LIMIT)
        .select(["name", "slug"]),
      SymptomCategory.find({ isActive: true }).sort({ order: 1, _id: 1 }),
      InsuranceCategory.find({ isActive: true }).sort({ order: 1, _id: 1 }),
    ]);
    // every active category is listed (the menu shows a category's own
    // sub-items, e.g. all specialities); the ones that already hold public
    // items (or, for a speciality, an active doctor) come first
    const [
      blogIds,
      productIds,
      diseaseIds,
      clinicIds,
      paraClinicIds,
      hospitalIds,
      testIds,
      serviceIds,
      specialityIds,
      symptomIds,
      insuranceIds,
    ] = await Promise.all([
      Blog.distinct("category", { published: true }),
      Product.distinct("category", { isActive: true }),
      Disease.distinct("category", PUBLIC_MEDICAL),
      Clinic.distinct("category", { active: true }),
      ParaClinic.distinct("category", { active: true }),
      Hospital.distinct("category", { isActive: true }),
      Test.distinct("category", { isActive: true }),
      // a service type is "in use" when a priced service or a doctor's
      // profile offers it
      Promise.all([
        Service.distinct("category", { isActive: true }),
        DoctorProfile.distinct("serviceCategories", { active: true }),
      ]).then(([a, b]) => [...a, ...b]),
      DoctorProfile.distinct("specialities", { active: true }),
      Symptom.distinct("category", PUBLIC_MEDICAL),
      Insurance.distinct("category", { active: true }),
    ]);
    const having = <T extends { _id: unknown }>(list: T[], ids: unknown[]) => {
      const set = new Set(ids.filter(Boolean).map(String));
      const has = (el: T) => set.has(String(el._id));
      return [...list.filter(has), ...list.filter((el) => !has(el))];
    };
    res.status(200).json({
      message: "getHeader",
      data: {
        blogCategories: having(blogCategories, blogIds),
        productCategories: having(productCategories, productIds),
        diseaseCategories: having(diseaseCategories, diseaseIds),
        clinicCategories: having(clinicCategories, clinicIds),
        paraClinicCategories: having(paraClinicCategories, paraClinicIds),
        hospitalCategories: having(hospitalCategories, hospitalIds),
        testCategories: having(testCategories, testIds),
        serviceCategories: having(serviceCategories, serviceIds),
        specialities: having(specialities, specialityIds),
        symptomCategories: having(symptomCategories, symptomIds),
        insuranceCategories: having(insuranceCategories, insuranceIds),
      },
    });
  },
);

const SPECIALITY_SLIDER_LIMIT = 24;

export const getSpecialityDoctors: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const speciality = await Speciality.findById(nodeId);
    if (!speciality) return next(new NotFoundError());
    // a slider of cards: card fields only, a stable order, a sane cap
    const doctors = await DoctorProfile.find({
      active: true,
      $or: [
        { mainSpeciality: speciality._id },
        { specialities: speciality._id },
      ],
    })
      .select(DOCTOR_CARD_FIELDS)
      .sort({ order: 1, _id: 1 })
      .limit(SPECIALITY_SLIDER_LIMIT)
      .populate([
      { path: "mainSpeciality" },
      { path: "voiceCallSettings" },
      { path: "sipCallSettings" },
      { path: "textChatSettings" },
      { path: "videoCallSettings" },
      { path: "inPersonSettings" },
      { path: "province" },
    ]);
    res
      .status(200)
      .json({ message: "getSpecialityDoctors", data: { doctors: await doctorCards(doctors) } });
  },
);

const BLOGS_PAGE_LIMIT = 4;

const blogSorts = ["newest", "best"] as const;

const getBlogsSchema = z.strictObject({
  page: z.coerce.number().int().min(1).optional().default(1),
  sort: z.enum(blogSorts).optional().default("newest"),
  category: z.string().optional(),
  query: z.string().optional(),
  tag: z.string().optional(),
});

export const getBlogs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data: input, success, error } = await getBlogsSchema.spa(req.query);
    if (!success) return next(new BadInputError());
    const { page, sort, category: _category, query: search, tag } = input;
    let category: IBlogCategory | undefined | null;
    if (_category) {
      if (isValidObjectId(_category)) {
        category = await BlogCategory.findById(_category);
        if (category?.slug) return next(new NotFoundError());
      } else {
        category = await BlogCategory.findOne({ slug: _category });
      }
      if (!category) return next(new NotFoundError());
    }
    const query: Record<string, unknown> = { published: true };
    if (category) query.category = category._id;
    if (search) query.title = { $regex: escapeRegex(search), $options: "i" };
    if (tag) {
      if (!isValidObjectId(tag)) return next(new BadInputError());
      query.tags = tag;
    }
    const blogs = await Blog.find(query)
      .sort(buildCommentableSort(sort))
      .limit(BLOGS_PAGE_LIMIT)
      .skip((page - 1) * BLOGS_PAGE_LIMIT)
      .select([
        "title",
        "_id",
        "slug",
        "summary",
        "order",
        "publishedAt",
        "image",
      ]);
    const categories = await BlogCategory.find().sort({ order: 1, _id: 1 });
    const blogsCount = await Blog.countDocuments(query);
    const recommended = await Blog.find({
      published: true,
      recommended: true,
    }).sort({ order: 1, _id: 1 });
    const chosen = await Blog.find({ published: true, chosen: true })
      .sort({ order: 1, _id: 1 })
      .limit(2)
      .populate({ path: "category" });
    const mostViewed = await Blog.find({ published: true })
      .sort({ viewCount: -1, order: 1, _id: 1 })
      .limit(4);
    const hotTags = await BlogTag.find({ isActive: true, hot: true }).sort({
      order: 1,
      _id: 1,
    });
    res.status(200).json({
      message: "getBlogs",
      data: {
        blogs,
        categories,
        blogsCount,
        recommended,
        chosen,
        pagesCount: Math.ceil(blogsCount / BLOGS_PAGE_LIMIT) || 1,
        mostViewed,
        hotTags,
      },
    });
  },
);

const submitBlogRRSSchema = z.strictObject({ email: z.email() });
export const submitBlogRRS: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      error,
      success,
    } = await submitBlogRRSSchema.spa(req.body);
    if (!success) return next(new BadInputError());
    const dup = await BlogRRS.exists({ email: input.email });
    if (dup) return next(new AppError("شما قبلا عضو خبرنامه شدید", 400));
    await BlogRRS.create({ email: input.email });
    res.status(200).json({ message: "submitBlogRRS" });
  },
);

export const getBlog: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    let blog: IBlog | null | undefined;
    const population = [
      {
        path: "related",
        // the admin's rank, as on every other list (1 = first)
        options: { sort: { order: 1, _id: -1 } },
        select: ["_id", "title", "order", "image", "summary", "slug"],
        match: { published: true },
      },
      { path: "category" },
      { path: "tags", match: { isActive: true } },
    ];
    // only published posts are public: a clinic's / doctor's submitted post
    // stays hidden until an admin reviews and publishes it
    if (isValidObjectId(nodeId)) {
      blog = await Blog.findOne({ _id: nodeId, published: true }).populate(population);
      if (blog?.slug) return next(new NotFoundError());
    } else {
      blog = await Blog.findOne({ slug: nodeId, published: true }).populate(population);
    }
    if (!blog) return next(new NotFoundError());
    // counted on the server, not trusted from the client
    Blog.updateOne({ _id: blog._id }, { $inc: { viewCount: 1 } }).catch(() => {});
    const thisWeek = await Blog.find({
      thisWeekSpecial: true,
      published: true,
    })
      .sort({ order: 1, _id: -1 })
      .select(["_id", "title", "order", "image", "summary", "slug"]);
    res.status(200).json({ message: "getBlog", data: { blog, thisWeek } });
  },
);

export const getSpecialityOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    // same order as every other list (it was reversed here)
    const data = await Speciality.find({ active: true }).sort({
      order: 1,
      _id: 1,
    });
    res.status(200).json({ message: "getSpecialityOptions", data: { data } });
  },
);

export const getServiceCategoryOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await ServiceCategory.find(PUBLIC_SERVICE_CATEGORY).sort({
      order: 1,
      _id: 1,
    });
    res
      .status(200)
      .json({ message: "getServiceCategoryOptions", data: { data } });
  },
);

export const getParaClinicTagOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await ParaClinicTag.find({ isActive: true }).sort({
      order: 1,
      _id: -1,
    });
    res
      .status(200)
      .json({ message: "getParaClinicTagOptions", data: { data } });
  },
);

// Every active insurer, for the "insurers we accept" picker of the centre
// panels (2026-10). The pickers used the public list (/public/insurance),
// which is paged: a centre could only choose among the first nine insurers.
export const getInsuranceOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await Insurance.find({ active: true })
      .select("name slug image isBasic order")
      .sort({ order: 1, _id: 1 })
      .lean();
    res.status(200).json({ message: "getInsuranceOptions", data: { data } });
  },
);

export const getClinicTagOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await ClinicTag.find({ isActive: true }).sort({
      order: 1,
      _id: -1,
    });
    res.status(200).json({ message: "getClinicTagOptions", data: { data } });
  },
);

export const getHospitalTagOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await HospitalTag.find({ isActive: true }).sort({
      order: 1,
      _id: -1,
    });
    res.status(200).json({ message: "getHospitalTagOptions", data: { data } });
  },
);

// Mirrors getHospitalTagOptions above - used by
// InsuranceManageDetailsTab's "tags" multiselect (2026-09).
export const getInsuranceTagOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await InsuranceTag.find({ isActive: true }).sort({
      order: 1,
      _id: -1,
    });
    res.status(200).json({ message: "getInsuranceTagOptions", data: { data } });
  },
);

const DOCTORS_PER_PAGE_BOOKING = 25;

export const getUpcomingWeekAvailabelSessions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const today = tehranYmd();
    const data = await DoctorSession.aggregate([
      {
        $match: {
          doctor: new mongoose.Types.ObjectId(nodeId),
          date: {
            $gte: today,
            $lte: addDaysYmd(today, 7),
          },
        },
      },
      {
        $lookup: {
          from: "bookings",
          localField: "_id",
          foreignField: "session",
          as: "booking",
        },
      },
      { $match: { booking: { $size: 0 } } },
      {
        $group: {
          _id: "$date",
          availabelSessions: { $push: "$$ROOT" },
          count: { $sum: 1 },
        },
      },
    ]);
    res.status(200).json({ message: "getUpcomingWeekAvailabelSessions", data });
  },
);

export const getAvailableSessionsByDay: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId, stamp: _stamp } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const stamp = isNaN(Number(_stamp))
      ? new Date(_stamp)
      : new Date(Number(_stamp));
    if (isNaN(stamp.getTime())) return next(new BadInputError());
    // the Tehran day of the stamp (Lib/tehranTime.ts)
    const data = await DoctorSession.aggregate([
      {
        $match: {
          doctor: new mongoose.Types.ObjectId(nodeId),
          date: getSessionDateKey(stamp),
        },
      },
      {
        $lookup: {
          from: "bookings",
          localField: "_id",
          foreignField: "session",
          as: "booking",
        },
      },
      { $match: { booking: { $size: 0 } } },
    ]);
    res.status(200).json({ message: "getAvailableSessionsByDay", data });
  },
);

// Verified visit reviews of a doctor (2026-09) - see
// userController.submitMyVisitFeedback. The reviewer shows as first name +
// last-name initial; the private message never leaves the server.
const DOCTOR_FEEDBACKS_PER_PAGE = 10;
export const getDoctorFeedbacks: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const doctor = new mongoose.Types.ObjectId(nodeId);
    // verified only: approved and backed by a completed visit
    const match = publicDoctorFeedbackMatch(doctor);
    const [rows, statsRows, count] = await Promise.all([
      DoctorFeedBack.find(match)
        .sort({ submittedAt: -1 })
        .skip((page - 1) * DOCTOR_FEEDBACKS_PER_PAGE)
        .limit(DOCTOR_FEEDBACKS_PER_PAGE)
        .select({
          overalScore: 1,
          suggest: 1,
          publicMessage: 1,
          submittedAt: 1,
          user: 1,
          reservation: 1,
          reply: 1,
        })
        // the visit month for the "verified visit" badge
        .populate({ path: "reservation", select: "date" })
        .lean(),
      DoctorFeedBack.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$overalScore",
            count: { $sum: 1 },
            recommend: { $sum: { $cond: ["$suggest", 1, 0] } },
          },
        },
      ]),
      DoctorFeedBack.countDocuments(match),
    ]);
    const identities = await UserIdentity.find({
      user: { $in: rows.map((el) => el.user) },
    }).select({ user: 1, givenName: 1, lastName: 1 });
    const data = rows.map((el) => {
      const who = identities.find(
        (i) => i.user?.toString() === el.user?.toString(),
      );
      const author = who
        ? `${who.givenName || ""} ${(who.lastName || "").trim().charAt(0)}${who.lastName ? "." : ""}`.trim()
        : "";
      return {
        _id: el._id,
        overalScore: el.overalScore,
        suggest: !!el.suggest,
        publicMessage: el.publicMessage || "",
        submittedAt: el.submittedAt,
        author,
        verified: !!el.reservation,
        visitAt: (el.reservation as any)?.date ?? null,
        reply: el.reply?.content
          ? { content: el.reply.content, at: el.reply.at }
          : null,
      };
    });
    const distribution: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    let recommend = 0;
    for (const row of statsRows) {
      if (row._id >= 1 && row._id <= 5) distribution[row._id] = row.count;
      sum += (row._id || 0) * row.count;
      recommend += row.recommend;
    }
    res.status(200).json({
      message: "getDoctorFeedbacks",
      data: {
        data,
        pagesCount: Math.ceil(count / DOCTOR_FEEDBACKS_PER_PAGE) || 1,
        stats: {
          count,
          average: count ? Math.round((sum / count) * 10) / 10 : 0,
          recommendPercent: count ? Math.round((recommend / count) * 100) : 0,
          distribution,
        },
      },
    });
  },
);

export const getDoctorConfig: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await DoctorProfile.findOne({ _id: nodeId, active: true });
    if (!node) return next(new NotFoundError());
    const sipCall = await SipCallSettings.findOne({ doctor: node._id });
    const voiceCall = await VoiceCallSettings.findOne({ doctor: node._id });
    const videoCall = await VideoCallSettings.findOne({ doctor: node._id });
    const inPerson = await InPersonSettings.findOne({ doctor: node._id });
    const textChat = await TextChatSettings.findOne({ doctor: node._id });
    // an insurer the admin switched off is not offered (the quote ignores
    // it too, Lib/insuranceTariffs.ts)
    const insurances = (
      await DoctorInsurance.find({
        doctor: node._id,
      }).populate({ path: "insurance", match: { active: true } })
    ).filter((el) => !!el.insurance);
    const clinics = await ClinicDoctor.find({ doctor: node._id });
    // a switched-off office takes no bookings and is not shown
    const offices = await Office.find({ doctor: node._id, active: true });
    // the visit types a patient can book (Lib/doctorOffer.ts): the page's
    // tags and the booking panel's choices, the same as the card
    const offer = (await doctorOffers([node._id])).get(String(node._id));
    res.status(200).json({
      message: "getDoctorConfig",
      data: {
        sipCall,
        voiceCall,
        videoCall,
        inPerson,
        textChat,
        insurances,
        clinics,
        offices,
        sessionTypes: node.claimed === false ? [] : offer?.sessionTypes || [],
      },
    });
  },
);

const getFirstAvailableSessionSchema = z.strictObject({
  patientStatus: z.enum(patientStatuses),
  sessionType: z.enum(doctorSessionTypes),
  clinic: z.string().optional(),
});

const CHECK_FOR_AVAILABLE_SESSION_SPAN = 30;
export const getFirstAvailableSession: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    const { data, success, error } =
      await getFirstAvailableSessionSchema.safeParseAsync(req.body);
    console.log({ error });
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const doctor = await DoctorProfile.findOne({ _id: nodeId, active: true });
    if (!doctor) return next(new BadInputError());
    if (data.clinic) {
      if (!isValidObjectId(data.clinic)) return next(new BadInputError());
      const clinic = await Office.findOne({
        _id: data.clinic,
        doctor: doctor._id,
      });
      if (!clinic) return next(new NotFoundError());
    }
    // the next Tehran days, from tomorrow
    const keys: string[] = [];
    for (let i = 0; i < CHECK_FOR_AVAILABLE_SESSION_SPAN; ++i)
      keys.push(addDaysYmd(tehranYmd(), i + 1));
    const session = await DoctorSession.aggregate([
      {
        $match: {
          doctor: new mongoose.Types.ObjectId(nodeId),
          date: { $in: keys },
          [data.sessionType]: true,
          [data.patientStatus]: true,
          ...(data.clinic
            ? { clinic: new mongoose.Types.ObjectId(data.clinic) }
            : {}),
        },
      },
      {
        $lookup: {
          from: "bookings",
          localField: "_id",
          foreignField: "session",
          as: "booking",
        },
      },
      { $match: { booking: { $size: 0 } } },
      {
        $group: {
          _id: "$date",
          availabelSessions: { $push: "$$ROOT" },
          count: { $sum: 1 },
        },
      },
    ]);
    res
      .status(200)
      .json({ message: "getFirstAvailableSession", data: session });
  },
);

export const getSessionDetails: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    const data = await DoctorSession.findById({ _id: nodeId }).populate([
      {
        path: "booking",
        select: { _id: 1 },
      },
      { path: "doctor", populate: { path: "mainSpeciality" } },
    ]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getSessionDetails", data });
  },
);

// the public map's layers (2026-10): doctors and every kind of centre, each
// switched on by the visitor (Google Maps / Doctolib "near me" pins)
const mapLayers = ["doctors", "clinics", "hospitals", "labs", "pharmacies"] as const;
const boundsSchema = z.strictObject({
  bounds: z
    .tuple([isPoint, isPoint])
    .refine(
      ([[minLng, minLat], [maxLng, maxLat]]) =>
        minLng < maxLng && minLat < maxLat,
    ),
  // what to return; the map asked for doctors only before
  layers: asArray(z.enum(mapLayers)).optional(),
});
const MAP_PLACES_PER_LAYER = 60;
const mapPlaceLayers: Record<
  Exclude<(typeof mapLayers)[number], "doctors">,
  { model: Model<any>; visible: Record<string, unknown>; image: string }
> = {
  clinics: { model: Clinic, visible: { active: true }, image: "image" },
  hospitals: { model: Hospital, visible: { isActive: true }, image: "image" },
  labs: { model: ParaClinic, visible: { active: true }, image: "image" },
  pharmacies: { model: Pharmacy, visible: { active: true }, image: "avatar" },
};

export const searchInMap: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await boundsSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const { bounds } = data;
    const [[lng1, lat1], [lng2, lat2]] = bounds;
    const poly = [
      [lng1, lat1],
      [lng2, lat1],
      [lng2, lat2],
      [lng1, lat2],
      [lng1, lat1],
    ];
    const within = {
      location: {
        $geoWithin: { $geometry: { type: "Polygon", coordinates: [poly] } },
      },
    };
    const layers = new Set(data.layers?.length ? data.layers : ["doctors"]);
    const doctors = layers.has("doctors")
      ? await DoctorProfile.find({ active: true, ...within })
          .select([...DOCTOR_CARD_FIELDS, "location"])
          .populate([
            { path: "mainSpeciality", select: ["name", "slug"] },
            { path: "province", select: ["name"] },
          ])
          .sort({ order: 1, _id: 1 })
          .limit(DOCTORS_PER_PAGE_BOOKING)
      : [];
    // each centre with what its pin and row show: name, page, address, image
    const places = Object.fromEntries(
      await Promise.all(
        (Object.keys(mapPlaceLayers) as (keyof typeof mapPlaceLayers)[]).map(async (layer) => {
          if (!layers.has(layer)) return [layer, []];
          const cfg = mapPlaceLayers[layer];
          const rows = await cfg.model
            .find({ ...cfg.visible, ...within, slug: { $exists: true, $nin: [null, ""] } })
            .select(["name", "slug", "location", "address", "isRoundTheClock", "openingHours", cfg.image, "translations"])
            .populate([
              { path: "city", select: ["name", "translations"] },
              { path: "province", select: ["name", "translations"] },
            ])
            .sort({ order: 1, _id: 1 })
            .limit(MAP_PLACES_PER_LAYER)
            .lean();
          return [
            layer,
            // "open now / closes at" on each row (Lib/openingHours.ts)
            withOpenStatus(rows.map((el: any) => ({ ...el, image: el[cfg.image], kind: layer }))),
          ];
        }),
      ),
    );
    res.status(200).json({
      message: "searchInMap",
      data: { doctors: layers.has("doctors") ? await doctorCards(doctors) : [], ...places },
    });
  },
);

export const getShortLink: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { token } = req.params;
    // a CRM message's tracked link: <token>-<recipient code> (2026-10,
    // Lib/business/crmSend.ts) - counts the click, then redirects as usual
    const data = (await ShortLink.findOne({ token })) || (await resolveTrackedClick(String(token || "")));
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getShortLink", data });
  },
);

export const getRedirect: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { path } = req.query;
    if (typeof path !== "string") return next(new BadInputError());
    const data = await Redirection.findOne({
      old: { $in: [...new Set([path, normalizePath(path)])] },
    });
    res.status(200).json({ message: "getRedirect", data });
  },
);

// The legacy directory was merged into DoctorProfile (2026-09): an old
// /doctor/<slug> link resolves to the profile it became, so the page can
// answer with a permanent redirect to /dr/<slug>.
export const getDoctor: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    if (!slug) return next(new BadInputError());
    const legacy: any =
      (await Doctor.collection.findOne({ slug })) ||
      (isValidObjectId(slug)
        ? await Doctor.collection.findOne({ _id: new mongoose.Types.ObjectId(slug) })
        : null) ||
      (await Doctor.collection.findOne({ name: slug }));
    const profile = legacy
      ? await DoctorProfile.findOne({
          $or: [{ _id: legacy.mergedInto }, { legacyDoctor: legacy._id }],
          active: true,
        }).select("slug")
      : null;
    if (!profile) return next(new NotFoundError());
    res.status(200).json({
      message: "getDoctor",
      data: { redirect: `/dr/${profile.slug || profile._id}` },
    });
  },
);

const HEADER_SPECIALITIES_LIMIT = 40;

const getSpecialitiesSchema = z.strictObject({
  page: z.coerce.number().int().min(1).optional().default(1),
  query: z.string().optional(),
});

const SPECIALITIES_PER_PAGE = 9;
export const getSpecialities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      success,
      error,
    } = await getSpecialitiesSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const { page, query } = input;
    const payload: Record<string, unknown> = { active: true };
    if (query) payload.name = { $regex: escapeRegex(query), $options: "i" };
    const data = await Speciality.find(payload)
      .sort({
        order: 1,
        _id: 1,
      })
      .limit(SPECIALITIES_PER_PAGE)
      .skip(SPECIALITIES_PER_PAGE * (page - 1))
      .populate([
        { path: "doctorsCountWithMainSpeciality" },
        { path: "doctorsCountWithSideSpeciality" },
        {
          path: "doctors",
          // per speciality (a plain `limit` caps all specialities together)
          perDocumentLimit: 15,
          options: { sort: { order: 1, _id: 1 } },
          select: DOCTOR_CARD_FIELDS,
          populate: [{ path: "province" }, { path: "mainSpeciality", select: ["name", "slug"] }],
        },
      ]);
    const count = await Speciality.countDocuments(payload);
    // each slider row's booking action (Lib/doctorOffer.ts), all rows at once
    const rows = data.map((el) => el.toObject({ virtuals: true }) as Record<string, any>);
    for (const row of rows)
      row.doctors = (Array.isArray(row.doctors) ? row.doctors : []).filter(Boolean);
    await attachDoctorCards(rows.flatMap((row) => row.doctors));
    res.status(200).json({
      message: "getSpecialities",
      data: {
        data: rows,
        pagesCount: Math.ceil(count / SPECIALITIES_PER_PAGE),
      },
    });
  },
);

const getSpecialitySchema = z.strictObject({
  page: z.coerce.number().int().min(1).optional().default(1),
  slug: z.string(),
});
// Speciality page doctors (2026-09): one doctor entity since the legacy
// directory was merged into DoctorProfile - bookable (claimed) profiles
// first, then the rest, each by `order`.
const SPECIALITY_DOCTORS_PER_PAGE = 6;
export const getSpeciality: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      success,
      error,
    } = await getSpecialitySchema.spa({ ...req.query, ...req.params });
    if (!success) return next(new BadInputError());
    const { page, slug } = input;
    const payload = isValidObjectId(slug)
      ? {
          _id: slug,
          active: true,
          slug: { $exists: false },
        }
      : { slug, active: true };
    const data = await Speciality.findOne(payload);
    if (!data) return next(new NotFoundError());
    // Per-row lookups, run only on the current page's rows.
    const rowLookups: PipelineStage.FacetPipelineStage[] = [
      {
        $lookup: {
          from: "specialities",
          localField: "mainSpeciality",
          foreignField: "_id",
          as: "mainSpeciality",
        },
      },
      {
        $unwind: {
          path: "$mainSpeciality",
          preserveNullAndEmptyArrays: true,
        },
      },
      // session settings
      ...(
        [
          ["voicecallsettings", "voiceCallSettings"],
          ["videocallsettings", "videoCallSettings"],
          ["inpersonsettings", "inPersonSettings"],
          ["sipcallsettings", "sipCallSettings"],
          ["textchatsettings", "textChatSettings"],
        ] as const
      ).flatMap(([from, as]): PipelineStage.FacetPipelineStage[] => [
        {
          $lookup: {
            from,
            localField: "_id",
            foreignField: "doctor",
            as,
          },
        },
        { $unwind: { path: `$${as}`, preserveNullAndEmptyArrays: true } },
      ]),
      {
        $lookup: {
          from: "provinces",
          localField: "province",
          foreignField: "_id",
          as: "province",
        },
      },
      { $unwind: { path: "$province", preserveNullAndEmptyArrays: true } },
      // sessionTypes / bookable come after the page is cut (attachDoctorCards
      // below): the shifts alone advertised visit types switched off
    ];
    const pipe: PipelineStage[] = [
      {
        $match: {
          active: true,
          $or: [{ mainSpeciality: data._id }, { specialities: data._id }],
        },
      },
      {
        $addFields: {
          model: { $literal: "DoctorProfile" },
          // bookable (claimed) profiles first
          modelOrder: { $cond: [{ $eq: ["$claimed", false] }, 1, 0] },
        },
      },
      { $project: { ssid: 0 } },
      {
        $facet: {
          data: [
            { $sort: { modelOrder: 1, order: 1, _id: 1 } },
            { $skip: (page - 1) * SPECIALITY_DOCTORS_PER_PAGE },
            { $limit: SPECIALITY_DOCTORS_PER_PAGE },
            { $unset: "modelOrder" },
            ...rowLookups,
          ],
          count: [{ $count: "count" }],
        },
      },
    ];
    const doctors = await DoctorProfile.aggregate(pipe);
    const count = doctors[0].count?.[0]?.count || 0;
    // «اولین نوبت» on each card (Lib/nextSlot.ts), the page in one go
    if (Array.isArray(doctors[0]?.data)) {
      await attachDoctorCards(doctors[0].data);
      await attachNextSlots(doctors[0].data);
    }
    // the conditions this speciality treats (the reverse of a disease page's
    // "related specialities"), as Zocdoc / Practo speciality pages list them
    const diseases = await Disease.find({ specialities: data._id, ...PUBLIC_MEDICAL })
      .sort({ order: 1, _id: 1 })
      .limit(30)
      .select(["name", "slug"]);
    res.status(200).json({
      message: "getSpeciality",
      data: {
        data,
        diseases,
        doctors: doctors[0].data,
        pagesCount: Math.ceil(count / SPECIALITY_DOCTORS_PER_PAGE),
        count,
      },
    });
  },
);

const SYMPTOMS_PER_PAGE = 12;
export const getSymptoms: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { page: _page, query, category, sort: _sort } = req.query;
    const page = Number(_page);
    if (isNaN(page) || !Number.isInteger(page) || page < 1)
      return next(new BadInputError());
    if (query && typeof query !== "string") return next(new BadInputError());
    const sort =
      commentableSortOptions.find((el) => el === _sort) ||
      defaultCommentableSort;
    const payload: Record<string, unknown> = {
      ...PUBLIC_MEDICAL,
      ...(query ? { name: { $regex: escapeRegex(query), $options: "i" } } : {}),
    };
    // same category filter as the diseases list (the header links to it)
    if (typeof category === "string" && category) {
      const cate = await SymptomCategory.findOne(
        isValidObjectId(category)
          ? { _id: category, isActive: true }
          : { slug: category, isActive: true },
      );
      if (!cate) return next(new NotFoundError());
      payload.category = cate._id;
    }
    const data = await Symptom.find(payload)
      .sort(buildCommentableSort(sort))
      .skip(SYMPTOMS_PER_PAGE * (page - 1))
      .limit(SYMPTOMS_PER_PAGE)
      .select({ image: 1, name: 1, summary: 1, slug: 1 });
    const count = await Symptom.countDocuments(payload);
    res.status(200).json({
      message: "getSymptoms",
      data: { data, pagesCount: Math.ceil(count / SYMPTOMS_PER_PAGE) },
    });
  },
);

export const getSymptom: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    const payload = isValidObjectId(slug)
      ? { _id: slug, slug: { $exists: false } }
      : { slug };
    const data = await Symptom.findOne({ ...payload, ...PUBLIC_MEDICAL }).populate([
      { path: "sameAs", match: PUBLIC_MEDICAL },
      { path: "category", match: { isActive: true } },
      // its "by body part" directory pages (Lib/medicalDirectory)
      { path: "part", match: { isActive: { $ne: false } }, select: "name slug translations" },
      reviewerPopulation,
    ]);
    if (!data) return next(new NotFoundError());
    // only what is public is linked: unpublished pages and switched-off
    // specialities would be dead links
    const linkedDiseases = { symptoms: data._id, ...PUBLIC_MEDICAL };
    const diseases = await Disease.find(linkedDiseases);
    const drugIds = await Disease.distinct("drugs", linkedDiseases);
    const specialityIds = await Speciality.distinct("_id", {
      _id: { $in: await Disease.distinct("specialities", linkedDiseases) },
      active: true,
    });
    const drugs = await Drug.find({ _id: { $in: drugIds }, ...PUBLIC_MEDICAL });
    const specialities = await Speciality.find({ _id: { $in: specialityIds } });
    const doctors = await DoctorProfile.find({
      active: true,
      $or: [
        { mainSpeciality: { $in: specialityIds } },
        { specialities: { $in: specialityIds } },
      ],
    })
      .sort({ order: 1, _id: 1 })
      .limit(3)
      .populate([
        { path: "mainSpeciality" },
        { path: "voiceCallSettings" },
        { path: "sipCallSettings" },
        { path: "textChatSettings" },
        { path: "videoCallSettings" },
        { path: "inPersonSettings" },
        { path: "province" },
      ]);
    res.status(200).json({
      message: "getSymptom",
      data: { data, doctors: await doctorCards(doctors), diseases, drugs, specialities },
    });
  },
);

const DISEASES_PER_PAGE = 9;
export const getDiseases: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { page: _page, query, category, sort: _sort } = req.query;
    const page = Number(_page);
    if (isNaN(page) || !Number.isInteger(page) || page < 1)
      return next(new BadInputError());
    if (query && typeof query !== "string") return next(new BadInputError());
    const sort =
      commentableSortOptions.find((el) => el === _sort) ||
      defaultCommentableSort;
    const payload: Record<string, unknown> = {
      ...PUBLIC_MEDICAL,
      ...(query ? { name: { $regex: escapeRegex(query), $options: "i" } } : {}),
    };
    if (typeof category === "string") {
      if (isValidObjectId(category)) {
        const cate = await DiseaseCategory.findOne({
          _id: category,
          isActive: true,
        });
        if (!cate || cate.slug) return next(new NotFoundError());
        payload.category = cate._id;
      } else {
        const cate = await DiseaseCategory.findOne({
          slug: category,
          isActive: true,
        });
        if (!cate) return next(new NotFoundError());
        payload.category = cate._id;
      }
    }
    const data = await Disease.find(payload)
      .limit(DISEASES_PER_PAGE)
      .skip((page - 1) * DISEASES_PER_PAGE)
      .sort(buildCommentableSort(sort))
      // disease tags are retired (Lib/migrateMedicalDirectory): category only
      .populate([{ path: "category", match: { isActive: true } }]);
    // 404 only past the last page; page 1 of an empty list is a valid,
    // empty answer (a new site with no doctors yet, not "page not found")
    if (!data.length && page > 1) return next(new NotFoundError());
    const count = await Disease.countDocuments(payload);
    const categories = await DiseaseCategory.find({ isActive: true });
    res.status(200).json({
      message: "getDiseases",
      data: {
        data,
        pagesCount: Math.ceil(count / DISEASES_PER_PAGE) || 1,
        categories,
      },
    });
  },
);

export const getDisease: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    const payload = isValidObjectId(slug)
      ? { _id: slug, slug: { $exists: false } }
      : { slug };
    const data = await Disease.findOne({ ...payload, ...PUBLIC_MEDICAL }).populate([
      { path: "symptoms", match: PUBLIC_MEDICAL },
      { path: "specialities", match: { active: true } },
      { path: "drugs", match: PUBLIC_MEDICAL },
      { path: "category", match: { isActive: true } },
      { path: "sameAs", match: PUBLIC_MEDICAL },
      // its "by body part" directory pages (Lib/medicalDirectory)
      { path: "parts", match: { isActive: { $ne: false } }, select: "name slug translations" },
      reviewerPopulation,
    ]);
    if (!data) return next(new NotFoundError());
    const specialityIds = data.specialities.map((el) => el._id);
    const doctors = await DoctorProfile.find({
      active: true,
      $or: [
        { mainSpeciality: { $in: data.specialities.map((el) => el._id) } },
        { specialities: { $in: data.specialities.map((el) => el._id) } },
      ],
    })
      .populate([
        { path: "mainSpeciality" },
        { path: "voiceCallSettings" },
        { path: "sipCallSettings" },
        { path: "textChatSettings" },
        { path: "videoCallSettings" },
        { path: "inPersonSettings" },
        { path: "province" },
      ])
      .sort({ order: 1, _id: 1 })
      .limit(3);
    const clinics = await Clinic.aggregate([
      // only public clinics are suggested on a disease page
      { $match: { active: true } },
      {
        $lookup: {
          from: "clinicdoctors",
          localField: "_id",
          foreignField: "clinic",
          as: "clinicDoctors",
          pipeline: [
            {
              $lookup: {
                from: "doctorprofiles",
                localField: "doctor",
                foreignField: "_id",
                as: "doctor",
                pipeline: [
                  {
                    $match: {
                      active: true,
                      $or: [
                        { mainSpeciality: { $in: specialityIds } },
                        { specialities: { $in: specialityIds } },
                      ],
                    },
                  },
                ],
              },
            },
            { $match: { "doctor.0": { $exists: true } } },
          ],
        },
      },
      { $match: { "clinicDoctors.0": { $exists: true } } },
      { $sort: { order: 1, _id: 1 } },
      { $limit: 3 },
      {
        $lookup: {
          from: "provinces",
          localField: "province",
          foreignField: "_id",
          as: "province",
        },
      },
      {
        $unwind: { path: "$province", preserveNullAndEmptyArrays: true },
      },
      {
        $lookup: {
          from: "clinictags",
          localField: "tags",
          foreignField: "_id",
          pipeline: [{ $match: { isActive: true } }],
          as: "tags",
        },
      },
      {
        $lookup: {
          from: "cliniccategories",
          localField: "category",
          foreignField: "_id",
          as: "category",
        },
      },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
    ]);
    res
      .status(200)
      .json({ message: "getDisease", data: { data, clinics, doctors: await doctorCards(doctors) } });
  },
);

const DRUGS_PER_PAGE = 9;
export const getDrugs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { page: _page, query, sort: _sort } = req.query;
    const page = Number(_page);
    if (isNaN(page) || !Number.isInteger(page) || page < 1)
      return next(new BadInputError());
    if (query && typeof query !== "string") return next(new BadInputError());
    const sort =
      commentableSortOptions.find((el) => el === _sort) ||
      defaultCommentableSort;
    const payload: Record<string, unknown> = {
      ...PUBLIC_MEDICAL,
      ...(query ? { name: { $regex: escapeRegex(query), $options: "i" } } : {}),
    };
    const data = await Drug.find(payload)
      .limit(DRUGS_PER_PAGE)
      .skip((page - 1) * DRUGS_PER_PAGE)
      .sort(buildCommentableSort(sort))
      .populate({ path: "tag", match: { isActive: true } });
    const count = await Drug.countDocuments(payload);
    res.status(200).json({
      message: "getDrugs",
      data: { data, pagesCount: Math.ceil(count / DRUGS_PER_PAGE) },
    });
  },
);

export const getDrug: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    const payload = isValidObjectId(slug)
      ? { _id: slug, slug: { $exists: false } }
      : { slug };
    const data = await Drug.findOne({ ...payload, ...PUBLIC_MEDICAL }).populate([
      { path: "sameAs", match: PUBLIC_MEDICAL },
      // its therapeutic class page (/drug/class/<slug>)
      { path: "tag", match: { isActive: true }, select: "name slug translations" },
      reviewerPopulation,
    ]);
    if (!data) return next(new NotFoundError());
    const linkedDiseases = { drugs: data._id, ...PUBLIC_MEDICAL };
    const diseases = await Disease.find(linkedDiseases);
    const specialities = await Speciality.find({
      _id: { $in: await Disease.distinct("specialities", linkedDiseases) },
      active: true,
    });
    const specialityIds = specialities.map((el) => el._id);
    const doctors = await DoctorProfile.find({
      active: true,
      $or: [
        { mainSpeciality: { $in: specialityIds } },
        { specialities: { $in: specialityIds } },
      ],
    })
      .populate([
        { path: "mainSpeciality" },
        { path: "voiceCallSettings" },
        { path: "sipCallSettings" },
        { path: "textChatSettings" },
        { path: "videoCallSettings" },
        { path: "inPersonSettings" },
        { path: "province" },
      ])
      .sort({ order: 1, _id: 1 })
      .limit(3);
    res.status(200).json({
      message: "getDrug",
      data: { data, diseases, doctors: await doctorCards(doctors), specialities },
    });
  },
);

// Tags and accepted insurers are list filters (2026-09): a tag chip on a card
// links to its list narrowed to that tag, and an insurer's page links to the
// centres that accept it. The applied filters come back with their names so
// the page can show a removable chip. Unknown or switched-off -> 404.
const listFilterSchema = {
  tag: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  insurance: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  // «الان باز است» (2026-10, Lib/openingHours.ts): open at this minute,
  // Tehran time
  openNow: z.enum(["1"]).optional(),
};

// The "open now" filter of a centre list: narrows `payload` (with every
// other filter already on it) to the centres open at `now`. Call it last.
const applyOpenNow = async (
  input: { openNow?: string },
  payload: Record<string, unknown>,
  model: Model<any>,
  now: Date,
) => {
  if (!input.openNow) return false;
  payload._id = { $in: await openNowIds(model, payload, now) };
  return true;
};
const applyListFilters = async (
  input: { tag?: string; insurance?: string },
  payload: Record<string, unknown>,
  TagModel: Model<any>,
  { insurances = true }: { insurances?: boolean } = {},
) => {
  const applied: {
    tag?: { _id: unknown; name?: string };
    insurance?: { _id: unknown; name?: string; slug?: string };
  } = {};
  if (input.tag) {
    const tag = await TagModel.findOne({ _id: input.tag, isActive: true })
      .select("name")
      .lean<{ _id: unknown; name?: string }>();
    if (!tag) return null;
    payload.tags = tag._id;
    applied.tag = tag;
  }
  if (input.insurance && insurances) {
    const insurance = await Insurance.findOne({
      _id: input.insurance,
      active: true,
    })
      .select(["name", "slug"])
      .lean<{ _id: unknown; name?: string; slug?: string }>();
    if (!insurance) return null;
    payload.insurances = insurance._id;
    applied.insurance = insurance;
  }
  return applied;
};

const getClinicsSchema = z.strictObject({
  ...listFilterSchema,
  query: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  category: asArray(z.string()).optional(),
  sort: z
    .enum(commentableSortOptions)
    .optional()
    .default(defaultCommentableSort),
});

const CLINICS_PAGE_SIZE = 9;
export const getClinics: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      error,
      success,
    } = await getClinicsSchema.spa(req.query);
    if (!success) return next(new BadInputError());
    const payload: Record<string, unknown> = { active: true };
    if (input.query)
      payload.name = { $regex: escapeRegex(input.query), $options: "i" };
    if (input.category?.length) {
      const categories = await ClinicCategory.find({
        isActive: true,
        $or: [
          {
            slug: { $in: input.category.filter((el) => !isValidObjectId(el)) },
          },
          { _id: { $in: input.category.filter((el) => isValidObjectId(el)) } },
        ],
      });
      // an unknown or switched-off category is a 404 (as on the other lists)
      if (!categories.length) return next(new NotFoundError());
      payload.category = { $in: categories.map((el) => el._id) };
    }
    const filters = await applyListFilters(input, payload, ClinicTag);
    if (!filters) return next(new NotFoundError());
    const now = new Date();
    const openNow = await applyOpenNow(input, payload, Clinic, now);
    const data = await Clinic.find(payload)
      .limit(CLINICS_PAGE_SIZE)
      .skip((input.page - 1) * CLINICS_PAGE_SIZE)
      .sort(buildCommentableSort(input.sort))
      .populate([{ path: "province" }, { path: "category" }, { path: "tags", match: { isActive: true } }]);
    const count = await Clinic.countDocuments(payload);
    const categories = await ClinicCategory.find({ isActive: true });
    const specials = await Clinic.find({ active: true, special: true })
      .populate({ path: "province" })
      .sort({ order: 1, _id: 1 })
      .limit(3);
    res.status(200).json({
      message: "getClinics",
      data: {
        data: withOpenStatus(data, now),
        pagesCount: Math.ceil(count / CLINICS_PAGE_SIZE),
        filters: { ...filters, ...(openNow && { openNow: true }) },
        categories,
        specials: withOpenStatus(specials, now),
      },
    });
  },
);

// A clinic's / hospital's doctors on its public page (2026-10): the active
// members only, with exactly the fields the shared doctor card reads
// (visit types, province, first free slot), like every other doctor list.
// The page used to get the whole DoctorProfile from an aggregate lookup -
// select:false fields included - and rows whose doctor was switched off
// (doctor: missing), which the page then counted as doctors.
const centreDoctorPopulate = {
  path: "doctor",
  match: { active: true },
  select: DOCTOR_CARD_FIELDS,
  populate: [
    { path: "mainSpeciality", select: "name slug active" },
    { path: "voiceCallSettings" },
    { path: "sipCallSettings" },
    { path: "textChatSettings" },
    { path: "videoCallSettings" },
    { path: "inPersonSettings" },
    { path: "province", select: "name slug" },
  ],
};
type CentreMember = { _id: unknown; department?: unknown; doctor?: any };
const centreMembers = async (
  member: Model<any>,
  field: "clinic" | "hospital",
  centre: unknown,
): Promise<CentreMember[]> => {
  const rows = (await member
    .find({ [field]: centre })
    .select("doctor department")
    .populate(centreDoctorPopulate)
    .lean()) as CentreMember[];
  const live = rows.filter((r) => r.doctor && typeof r.doctor === "object");
  // the card's visit types and booking action (Lib/doctorOffer.ts)
  await attachDoctorCards(live.map((r) => r.doctor));
  await attachNextSlots(live.map((r) => r.doctor));
  return live;
};
// the specialities the centre's doctors practise, once each (active ones:
// a chip links to its page)
const centreSpecialities = (members: CentreMember[]) => {
  const seen = new Map<string, unknown>();
  for (const m of members) {
    const sp = m.doctor?.mainSpeciality;
    if (sp && typeof sp === "object" && sp.active !== false && !seen.has(String(sp._id)))
      seen.set(String(sp._id), sp);
  }
  return [...seen.values()];
};
// the centre's own active departments, each with its doctors
const withDepartmentDoctors = (departments: any[], members: CentreMember[]) =>
  (Array.isArray(departments) ? departments : []).map((d) => ({
    ...d,
    doctors: members.filter((m) => m.department && String(m.department) === String(d._id)),
  }));
// the "management" line: the owner's doctor profile, by name, if public
const ownerCard = async (user: unknown) =>
  user
    ? DoctorProfile.findOne({ user, active: true })
        .select("firstName lastName slug")
        .lean()
    : null;

export const getClinic: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;

    const pipe: PipelineStage[] = [
      {
        $match: isValidObjectId(slug)
          ? {
              _id: new mongoose.Types.ObjectId(slug),
              active: true,
              slug: { $exists: false },
            }
          : { slug, active: true },
      },
      {
        $lookup: {
          from: "cliniccategories",
          localField: "category",
          foreignField: "_id",
          as: "category",
        },
      },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "provinces",
          localField: "province",
          foreignField: "_id",
          as: "province",
          // the name and slug: the province's boundary is megabytes
          pipeline: [{ $project: { name: 1, slug: 1, translations: 1 } }],
        },
      },
      { $unwind: { path: "$province", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "clinictags",
          localField: "tags",
          foreignField: "_id",
          pipeline: [{ $match: { isActive: true } }],
          as: "tags",
        },
      },
      {
        $lookup: {
          from: "clinicdepartments",
          localField: "_id",
          foreignField: "clinic",
          as: "departments",
          pipeline: [{ $match: { active: true } }, { $sort: { order: 1, _id: 1 } }],
        },
      },
      {
        $lookup: {
          from: "insurances",
          localField: "insurances",
          foreignField: "_id",
          as: "insurances",
          pipeline: [{ $match: { active: true } }],
        },
      },
    ];

    const data = await Clinic.aggregate(pipe);
    const node = data[0];
    if (!node) return next(new NotFoundError());
    const [members, owner] = await Promise.all([
      centreMembers(ClinicDoctor, "clinic", node._id),
      ownerCard(node.user),
    ]);
    // the panel login is not public
    delete node.user;
    res.status(200).json({
      message: "getClinic",
      data: {
        data: {
          ...withOpenStatusOne(node),
          doctors: members,
          departments: withDepartmentDoctors(node.departments, members),
          // every member counts, not only doctors placed in a department
          specialities: centreSpecialities(members),
          owner: owner || undefined,
        },
      },
    });
  },
);

const getHospitalsSchema = z.strictObject({
  ...listFilterSchema,
  query: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  category: z.string().optional(),
  province: z.string().optional(),
  sort: z
    .enum(commentableSortOptions)
    .optional()
    .default(defaultCommentableSort),
});

const HOSPITALS_PAGE_SIZE = 9;
export const getHospitals: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      success,
      error,
    } = await getHospitalsSchema.spa(req.query);
    if (!success) return next(new BadInputError());
    const {
      category: categoryId,
      page,
      province: provinceId,
      query,
      sort,
    } = input;
    const payload: Record<string, unknown> = { isActive: true };
    if (query) payload.name = { $regex: escapeRegex(query), $options: "i" };
    if (provinceId) {
      let province: IProvince | null = null;
      if (isValidObjectId(provinceId)) {
        province = await Province.findOne({
          _id: provinceId,
          slug: { $exists: false },
          isActive: true,
        });
      } else {
        province = await Province.findOne({
          slug: provinceId,
          isActive: true,
        });
      }
      if (!province) return next(new NotFoundError());
      payload.province = province._id;
    }
    if (categoryId) {
      let category: IHospitalCategory | null = null;
      if (isValidObjectId(categoryId)) {
        category = await HospitalCategory.findOne({
          _id: categoryId,
          slug: { $exists: false },
          isActive: true,
        });
      } else {
        category = await HospitalCategory.findOne({
          slug: categoryId,
          isActive: true,
        });
      }
      if (!category) return next(new NotFoundError());
      payload.category = category._id;
    }
    const filters = await applyListFilters(input, payload, HospitalTag);
    if (!filters) return next(new NotFoundError());
    const now = new Date();
    const openNow = await applyOpenNow(input, payload, Hospital, now);
    const data = await Hospital.find(payload)
      .limit(HOSPITALS_PAGE_SIZE)
      .skip((page - 1) * HOSPITALS_PAGE_SIZE)
      .sort(buildCommentableSort(sort))
      .populate([{ path: "province" }, { path: "tags", match: { isActive: true } }, { path: "category" }]);
    const count = await Hospital.countDocuments(payload);
    const categories = await HospitalCategory.find({ isActive: true }).sort({
      order: 1,
      _id: 1,
    });
    const provinces = await Province.find({ isActive: true }).sort({
      order: 1,
      _id: 1,
    });
    const specials = await Hospital.find({
      special: true,
      isActive: true,
    })
      .sort({ order: 1, _id: 1 })
      .populate({ path: "province" })
      .limit(3);
    res.status(200).json({
      message: "getHospitals",
      data: {
        data: withOpenStatus(data, now),
        categories,
        provinces,
        pagesCount: Math.ceil(count / HOSPITALS_PAGE_SIZE),
        filters: { ...filters, ...(openNow && { openNow: true }) },
        specials: withOpenStatus(specials, now),
      },
    });
  },
);

// A hospital's page (2026-10) shows its own doctors and departments (wards)
// - the HospitalDoctor / HospitalDepartment rows its panel manages - as
// well as the clinics it groups (HospitalClinic). It used to show only the
// doctors of the linked clinics, so a hospital that approved doctors in its
// panel showed none.
export const getHospital: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    const hospital = await Hospital.findOne(
      isValidObjectId(slug)
        ? { _id: slug, isActive: true, slug: { $exists: false } }
        : { slug, isActive: true },
    )
      // the panel login is not public
      .select("-user")
      .populate([
        { path: "province", select: "name slug" },
        { path: "category" },
        { path: "tags", match: { isActive: true } },
        {
          path: "clinics",
          populate: {
            path: "clinic",
            match: { active: true },
            select: "name slug phone summary image",
          },
        },
        { path: "owner", match: { active: true }, select: "firstName lastName slug" },
        { path: "insurances", match: { active: true } },
      ]);
    if (!hospital) return next(new NotFoundError());
    const data = hospital.toObject({ virtuals: true }) as any;
    // a linked clinic that was deleted or switched off is left out
    const clinicRows = (Array.isArray(data.clinics) ? data.clinics : []).filter(
      (c: any) => c?.clinic && typeof c.clinic === "object",
    );
    const [members, departments, clinicMembers] = await Promise.all([
      centreMembers(HospitalDoctor, "hospital", hospital._id),
      HospitalDepartment.find({ hospital: hospital._id, active: true })
        .sort({ order: 1, _id: 1 })
        .lean(),
      Promise.all(
        clinicRows.map((c: any) => centreMembers(ClinicDoctor, "clinic", c.clinic._id)),
      ),
    ]);
    const clinics = clinicRows.map((c: any, i: number) => ({
      ...c,
      clinic: { ...c.clinic, doctors: clinicMembers[i] },
    }));
    // every doctor of the hospital once: its own, then its clinics'
    const all = new Map<string, CentreMember>();
    for (const m of [...members, ...clinicMembers.flat()])
      if (!all.has(String(m.doctor._id))) all.set(String(m.doctor._id), m);
    res.status(200).json({
      message: "getHospital",
      data: {
        data: {
          ...withOpenStatusOne(data),
          clinics,
          doctors: members,
          departments: withDepartmentDoctors(departments, members),
          specialities: centreSpecialities([...all.values()]),
          doctorsCount: all.size,
        },
      },
    });
  },
);

const getParaClinicsSchema = z.strictObject({
  ...listFilterSchema,
  query: z.string().optional(),
  // only labs that offer this test (the test list links here)
  test: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  category: asArray(z.string()).optional(),
  sort: z
    .enum(commentableSortOptions)
    .optional()
    .default(defaultCommentableSort),
});

const PARACLINICS_LIST_PAGE_SIZE = 6;
export const getParaClinics: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      error,
      success,
    } = await getParaClinicsSchema.spa(req.query);
    if (!success) return next(new BadInputError());
    const payload: Record<string, unknown> = { active: true };
    if (input.query)
      payload.name = { $regex: escapeRegex(input.query), $options: "i" };
    // "which labs do this test, at what price" (Halodoc / Vezeeta): the
    // labs with a live offer of it, each with its own price and ready time
    let test: { _id: unknown; name?: string; slug?: string } | null = null;
    const offerOf = new Map<string, { _id: unknown; price: number; readyTime?: string }>();
    if (input.test) {
      test = await Test.findOne(
        isValidObjectId(input.test)
          ? { _id: input.test, isActive: true }
          : { slug: input.test, isActive: true },
      )
        .select("name slug")
        .lean();
      if (!test) return next(new NotFoundError());
      const offers = await ParaClinicTest.find({
        test: test._id,
        isActive: { $ne: false },
        price: { $gte: 1 },
      })
        .select("paraClinic price readyTime")
        .lean();
      for (const o of offers)
        offerOf.set(String(o.paraClinic), { _id: o._id, price: o.price, readyTime: o.readyTime });
      payload._id = { $in: offers.map((o) => o.paraClinic) };
    }
    if (input.category?.length) {
      const categories = await ParaClinicCategory.find({
        isActive: true,
        $or: [
          {
            slug: { $in: input.category.filter((el) => !isValidObjectId(el)) },
          },
          { _id: { $in: input.category.filter((el) => isValidObjectId(el)) } },
        ],
      });
      // an unknown or switched-off category is a 404 (as on the other lists)
      if (!categories.length) return next(new NotFoundError());
      payload.category = { $in: categories.map((el) => el._id) };
    }
    const filters = await applyListFilters(input, payload, ParaClinicTag);
    if (!filters) return next(new NotFoundError());
    const now = new Date();
    const openNow = await applyOpenNow(input, payload, ParaClinic, now);
    const data = await ParaClinic.find(payload)
      .populate([{ path: "province" }, { path: "category" }, { path: "tags", match: { isActive: true } }])
      .sort(buildCommentableSort(input.sort))
      .limit(PARACLINICS_LIST_PAGE_SIZE)
      .skip((input.page - 1) * PARACLINICS_LIST_PAGE_SIZE);
    const count = await ParaClinic.countDocuments(payload);
    const categories = await ParaClinicCategory.find({ isActive: true });
    const specials = await ParaClinic.find({
      active: true,
      special: true,
    })
      .sort({ order: 1, _id: 1 })
      .limit(3);
    // with a test: each lab's offer, and whether it takes online orders
    const rows = test
      ? await Promise.all(
          data.map(async (lab) => ({
            ...lab.toJSON(),
            testOffer: {
              ...offerOf.get(String(lab._id)),
              takesOrders: (await resolveParaClinicModules(lab._id)).includes("incomingOrders"),
            },
          })),
        )
      : data;
    res.status(200).json({
      message: "getParaClinics",
      data: {
        data: withOpenStatus(rows, now),
        test,
        pagesCount: Math.ceil(count / PARACLINICS_LIST_PAGE_SIZE),
        filters: { ...filters, ...(openNow && { openNow: true }) },
        categories,
        specials: withOpenStatus(specials, now),
      },
    });
  },
);

export const getParaClinic: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    const data = await ParaClinic.findOne(
      isValidObjectId(slug)
        ? { _id: slug, active: true, slug: { $exists: false } }
        : { slug, active: true },
    ).populate([
      { path: "district" },
      { path: "province" },
      { path: "city" },
      { path: "category" },
      { path: "tags", match: { isActive: true } },
      { path: "images" },
      {
        path: "tests",
        populate: {
          path: "test",
          match: { isActive: true },
          populate: { path: "category" },
        },
      },
      { path: "insurances", match: { active: true } },
    ]);
    if (!data) return next(new NotFoundError());
    // shown: an offer of an active test, not paused by the lab, with a price
    // (an old offer saved at 0 is not "free")
    const tests = ((data as any).tests || []).filter(
      (t: any) => !!t?.test && t.isActive !== false && Number(t.price) >= 1,
    );
    const modules = await resolveParaClinicModules(data._id);
    res.status(200).json({
      message: "getParaClinic",
      data: {
        data: { ...withOpenStatusOne(data.toObject({ virtuals: true })), tests },
        // a lab whose plan has no online orders cannot be booked here
        takesOrders: modules.includes("incomingOrders"),
      },
    });
  },
);

// Public profile of one pharmacy (2026-09): the pharmacy itself plus what it
// sells right now - its live offers on active catalog products (cheapest
// first) and its active product packages. Only an active pharmacy is shown.
export const getPharmacy: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    const data = await Pharmacy.findOne(
      isValidObjectId(slug)
        ? { _id: slug, active: true, slug: { $exists: false } }
        : { slug, active: true },
    )
      .select("-user")
      .populate([
        { path: "province" },
        { path: "city" },
        { path: "district" },
        // the insurers it accepts (Tamin / Salamat decide where a patient
        // fills a prescription), each linking to its page
        { path: "insurances", match: { active: true }, select: "name slug image isBasic" },
      ]);
    if (!data) return next(new NotFoundError());
    const [offers, packages, modules] = await Promise.all([
      ProductSeller.find({ seller: data._id, isActive: true })
        .populate({ path: "product", populate: { path: "category" } })
        .lean(),
      ProductPackage.find({ owner: data._id, isActive: true })
        .populate({ path: "category" })
        .sort({ order: 1, _id: 1 })
        .lean(),
      resolvePharmacyModules(data._id),
    ]);
    const sold = offers
      // an offer on an inactive / removed catalog product is not for sale
      .filter((o) => (o.product as unknown as { isActive?: boolean })?.isActive)
      .sort(
        (a, b) =>
          (a.price || 0) - (a.discount || 0) - ((b.price || 0) - (b.discount || 0)),
      );
    // stock the pharmacy keeps in its inventory decides "in stock" (2026-10)
    const out = await outOfStockProducts(data._id, [
      ...sold.map((o) => o.product),
      ...packages.flatMap((p) => (Array.isArray(p.products) ? p.products : [])),
    ]);
    const products = sold.map((o) => ({
      ...o,
      inStock: !out.has(String((o.product as { _id?: unknown })?._id ?? o.product)),
    }));
    const productPackages = packages.map((p) => ({
      ...p,
      inStock: !(Array.isArray(p.products) ? p.products : []).some((id) => out.has(String(id))),
    }));
    res.status(200).json({
      message: "getPharmacy",
      data: {
        data: withOpenStatusOne(data.toObject()),
        products,
        productPackages,
        // a pharmacy whose plan has no online orders is a profile to visit
        // or call, not a shop: the cart would refuse its items
        takesOrders: modules.includes("incomingOrders"),
        // where it ships (2026-10, Lib/delivery.ts)
        deliveryArea: (await deliveryAreasOf([data.toObject()])).get(String(data._id)),
      },
    });
  },
);

const getTestsSchema = z.strictObject({
  query: z.string().optional(),
  category: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
});

const TESTS_LIST_PAGE_SIZE = 10;
export const getTests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data: input, error, success } = await getTestsSchema.spa(req.query);
    if (!success) return next(new BadInputError());
    const payload: Record<string, unknown> = { isActive: true };
    if (input.query)
      payload.name = { $regex: escapeRegex(input.query), $options: "i" };
    // the header's test-category menu links here with ?category=
    if (input.category) {
      const cate = await TestCategory.findOne(
        isValidObjectId(input.category)
          ? { _id: input.category, isActive: true }
          : { slug: input.category, isActive: true },
      );
      if (!cate) return next(new NotFoundError());
      payload.category = cate._id;
    }
    const data = await Test.find(payload)
      .sort({ order: 1, _id: 1 })
      .limit(TESTS_LIST_PAGE_SIZE)
      .skip((input.page - 1) * TESTS_LIST_PAGE_SIZE)
      .populate({ path: "category" });
    const count = await Test.countDocuments(payload);
    res.status(200).json({
      message: "getTests",
      data: { data, pagesCount: Math.ceil(count / TESTS_LIST_PAGE_SIZE) },
    });
  },
);

// One lab test's public page (2026-10, /test/<slug>): what it is, how to
// prepare, and the labs that offer it - cheapest first, or best rated -
// each with its price, ready time and whether it can be ordered online
// (Labtests / Practo / Halodoc "who does CBC, at what price"). ?city=
// narrows the labs to one city.
const getTestSchema = z.strictObject({
  city: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  sort: z.enum(["price", "rating"]).optional().default("price"),
});
export const getTest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    const { data: input, success } = await getTestSchema.spa(req.query);
    if (!success) return next(new BadInputError());
    const test = await Test.findOne(
      isValidObjectId(slug)
        ? { _id: slug, isActive: true, slug: { $exists: false } }
        : { slug, isActive: true },
    )
      .populate({ path: "category", match: { isActive: true }, select: "name slug translations" })
      .lean();
    if (!test) return next(new NotFoundError());
    const [rawOffers, cities, related] = await Promise.all([
      liveTestOffers(test._id, { city: input.city }),
      offerCities(test._id),
      test.category
        ? Test.find({
            isActive: true,
            category: (test.category as { _id?: unknown })._id,
            _id: { $ne: test._id },
            slug: { $exists: true, $nin: [null, ""] },
          })
            .select("name slug summary translations")
            .sort({ order: 1, _id: 1 })
            .limit(8)
            .lean()
        : Promise.resolve([]),
    ]);
    const city = input.city
      ? (cities as { _id: unknown }[]).find((c) => String(c._id) === input.city) || null
      : null;
    // an unknown city (or one where nobody offers the test) is a 404, as on
    // the other filtered lists
    if (input.city && !city) return next(new NotFoundError());
    const modules = new Map<string, boolean>();
    const offers = await Promise.all(
      sortTestOffers(rawOffers, input.sort).map(async (o) => {
        const lab = String(o.paraClinic._id);
        if (!modules.has(lab))
          modules.set(lab, (await resolveParaClinicModules(o.paraClinic._id)).includes("incomingOrders"));
        const rating = labRating(o.paraClinic);
        return {
          _id: o._id,
          price: o.price,
          readyTime: o.readyTime,
          takesOrders: modules.get(lab),
          paraClinic: { ...o.paraClinic, averageScore: rating.score, reviewCount: rating.count },
        };
      }),
    );
    res.status(200).json({
      message: "getTest",
      data: {
        data: test,
        offers,
        cities,
        city,
        sort: input.sort,
        // the "best rated" order only means something once labs have reviews
        rated: rawOffers.some((o) => labRating(o.paraClinic).count > 0),
        related,
      },
    });
  },
);

// The pharmacy list (2026-10, /pharmacy), like the clinic and lab lists:
// 24-hour pharmacies, the insurer that pays the prescription (Tamin /
// Salamat decide where a patient fills it) and the city, each a removable
// filter; the facets offered are only the ones some pharmacy has.
const getPharmaciesSchema = z.strictObject({
  query: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  roundTheClock: z.enum(["1"]).optional(),
  // open at this minute, Tehran time (2026-10, Lib/openingHours.ts)
  openNow: z.enum(["1"]).optional(),
  insurance: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  city: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  // "best rated" (2026-10, seller reviews): approved buyer reviews' average
  sort: z.enum(["best"]).optional(),
});
const PHARMACIES_PAGE_SIZE = 12;
export const getPharmacies: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data: input, success } = await getPharmaciesSchema.spa(req.query);
    if (!success) return next(new BadInputError());
    const base: Record<string, unknown> = { active: true };
    const payload: Record<string, unknown> = { ...base };
    if (input.query)
      payload.name = { $regex: escapeRegex(input.query), $options: "i" };
    if (input.roundTheClock) payload.isRoundTheClock = true;
    const [insurance, city] = await Promise.all([
      input.insurance
        ? Insurance.findOne({ _id: input.insurance, active: true })
            .select("name slug translations")
            .lean<{ _id: unknown; name?: string; slug?: string }>()
        : null,
      input.city
        ? City.findById(input.city).select("name translations").lean<{ _id: unknown; name?: string }>()
        : null,
    ]);
    if ((input.insurance && !insurance) || (input.city && !city))
      return next(new NotFoundError());
    if (insurance) payload.insurances = insurance._id;
    if (city) payload.city = city._id;
    const now = new Date();
    const openNow = await applyOpenNow(input, payload, Pharmacy, now);
    const [rows, count, cityIds, insurerIds, roundTheClockCount, openNowCount] = await Promise.all([
      Pharmacy.find(payload)
        .select("-user")
        .populate([
          { path: "province", select: "name translations" },
          { path: "city", select: "name translations" },
          { path: "insurances", match: { active: true }, select: "name slug translations" },
        ])
        .sort(
          input.sort === "best"
            ? { averageScore: -1, commentCount: -1, order: 1, _id: 1 }
            : { order: 1, _id: 1 },
        )
        .skip((input.page - 1) * PHARMACIES_PAGE_SIZE)
        .limit(PHARMACIES_PAGE_SIZE)
        .lean(),
      Pharmacy.countDocuments(payload),
      Pharmacy.distinct("city", { ...base, city: { $ne: null } }),
      Pharmacy.distinct("insurances", base),
      Pharmacy.countDocuments({ ...base, isRoundTheClock: true }),
      // the chip is offered while some pharmacy is open
      openNowIds(Pharmacy, base, now).then((ids) => ids.length),
    ]);
    const [cities, insurances] = await Promise.all([
      cityIds.length
        ? City.find({ _id: { $in: cityIds } }).select("name translations").sort({ name: 1 }).lean()
        : [],
      insurerIds.length
        ? Insurance.find({ _id: { $in: insurerIds }, active: true })
            .select("name slug translations")
            .sort({ order: 1, _id: 1 })
            .lean()
        : [],
    ]);
    res.status(200).json({
      message: "getPharmacies",
      data: {
        // shown with the shared centre card: its image is the avatar
        data: withOpenStatus(rows.map((el: any) => ({ ...el, image: el.avatar || el.banner, tags: [] })), now),
        pagesCount: Math.ceil(count / PHARMACIES_PAGE_SIZE),
        count,
        filters: {
          ...(insurance && { insurance }),
          ...(city && { city }),
          ...(input.roundTheClock && { roundTheClock: true }),
          ...(openNow && { openNow: true }),
        },
        cities,
        insurances,
        roundTheClockCount,
        openNowCount,
      },
    });
  },
);

const getServicesSchema = z.strictObject({
  query: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  category: z.string().optional(),
  packageOnly: z.enum(["1"]).optional(),
  sort: z
    .enum(commentableSortOptions)
    .optional()
    .default(defaultCommentableSort),
});

const SERVICE_LIST_PAGE_SIZE = 12;
export const getServices: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      success,
      error,
    } = await getServicesSchema.spa(req.query);
    if (!success) return next(new BadInputError());
    const { page, category: categoryId, query, packageOnly, sort } = input;
    let category: IServiceCategory | null = null;
    if (categoryId) {
      if (isValidObjectId(categoryId)) {
        category = await ServiceCategory.findOne({
          _id: categoryId,
          slug: { $exists: false },
          isActive: true,
        });
      } else {
        category = await ServiceCategory.findOne({
          slug: categoryId,
          isActive: true,
        });
      }
      if (!category) return next(new NotFoundError());
    }
    const matchPipeline: Exclude<
      PipelineStage,
      PipelineStage.Out | PipelineStage.Merge
    >[] = [{ $match: { isActive: true } }];
    if (category) {
      matchPipeline.push({ $match: { category: category._id } });
    }
    if (query) {
      matchPipeline.push({
        $match: { name: { $regex: escapeRegex(query), $options: "i" } },
      });
    }
    const rowsPipe: PipelineStage.FacetPipelineStage[] = [
      { $sort: buildCommentableSort(sort) },
      { $skip: (page - 1) * SERVICE_LIST_PAGE_SIZE },
      { $limit: SERVICE_LIST_PAGE_SIZE },
      {
        $lookup: {
          from: "servicecategories",
          localField: "category",
          foreignField: "_id",
          as: "category",
        },
      },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "doctorprofiles",
          localField: "owner",
          foreignField: "_id",
          as: "owner",
          pipeline: [
            {
              $lookup: {
                from: "provinces",
                localField: "province",
                foreignField: "_id",
                as: "province",
              },
            },
            {
              $unwind: { path: "$province", preserveNullAndEmptyArrays: true },
            },
          ],
        },
      },
      { $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
      // a deactivated doctor's services leave the public list with them
      { $match: { "owner.active": true } },
    ];
    const pipe: PipelineStage[] = [
      ...(!packageOnly
        ? matchPipeline
        : [{ $match: { _id: { $exists: false } } }]),
      { $addFields: { model: { $literal: "Service" } } },
      {
        $unionWith: {
          coll: "servicepackages",
          pipeline: [
            ...matchPipeline,
            {
              $lookup: {
                from: "services",
                localField: "services",
                foreignField: "_id",
                as: "services",
              },
            },
            { $addFields: { model: { $literal: "ServicePackage" } } },
          ],
        },
      },
      { $facet: { data: rowsPipe, count: [{ $count: "count" }] } },
    ];
    const data = await Service.aggregate(pipe);
    const categories = await ServiceCategory.find(PUBLIC_SERVICE_CATEGORY).sort({
      order: 1,
      _id: 1,
    });
    // a deactivated doctor's services are not offered (as in the list above)
    const specials = (
      await Service.find({ isActive: true, special: true })
        .sort({ order: 1, _id: 1 })
        .limit(12)
        .populate({ path: "owner", match: { active: true }, select: DOCTOR_CARD_FIELDS })
    )
      .filter((el) => !!el.owner)
      .slice(0, 3);
    const count = data[0].count[0]?.count || 0;
    res.status(200).json({
      message: "getServices",
      data: {
        data: data[0].data || [],
        pagesCount: Math.ceil(count / SERVICE_LIST_PAGE_SIZE),
        categories,
        specials,
        count,
      },
    });
  },
);

export const getService: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    const data = await Service.findOne(
      isValidObjectId(slug)
        ? { _id: slug, isActive: true, slug: { $exists: false } }
        : { slug, isActive: true },
    ).populate([
      { path: "images" },
      { path: "specs" },
      {
        path: "sameAs",
        populate: [{ path: "owner" }, { path: "category" }],
      },
      { path: "owner" },
      { path: "category" },
    ]);
    if (!data || !(data.owner as { active?: boolean } | undefined)?.active)
      return next(new NotFoundError());
    res.status(200).json({ message: "getService", data: { data } });
  },
);

export const getServicePackage: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    const data = await ServicePackage.findOne(
      isValidObjectId(slug)
        ? { isActive: true, _id: slug, slug: { $exists: false } }
        : { slug, isActive: true },
    ).populate([
      { path: "images" },
      { path: "specs" },
      {
        path: "sameAs",
        populate: [
          { path: "owner" },
          { path: "category" },
          { path: "services" },
        ],
      },
      { path: "owner" },
      { path: "category" },
      { path: "services" },
    ]);
    if (!data || !(data.owner as { active?: boolean } | undefined)?.active)
      return next(new NotFoundError());
    res.status(200).json({ message: "getServicePackage", data: { data } });
  },
);

const getProductsSchema = z.strictObject({
  query: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  category: z.string().optional(),
  packageOnly: z.enum(["1"]).optional(),
  sort: z
    .enum(commentableSortOptions)
    .optional()
    .default(defaultCommentableSort),
});

const PRODUCTS_LIST_PAGE_SIZE = 12;
export const getProducts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      error,
      success,
    } = await getProductsSchema.spa(req.query);
    if (!success) return next(new BadInputError());
    const { page, category: categoryId, packageOnly, query, sort } = input;
    const matchPipeLine: Exclude<
      PipelineStage,
      PipelineStage.Out | PipelineStage.Merge
    >[] = [{ $match: { isActive: true } }];
    let category: null | IProductCategory = null;
    if (categoryId) {
      if (isValidObjectId(categoryId)) {
        category = await ProductCategory.findOne({
          _id: categoryId,
          slug: { $exists: false },
          isActive: true,
        });
      } else {
        category = await ProductCategory.findOne({
          slug: categoryId,
          isActive: true,
        });
      }
      if (!category) return next(new NotFoundError());
    }
    if (category) matchPipeLine.push({ $match: { category: category._id } });
    if (query)
      matchPipeLine.push({
        $match: { name: { $regex: escapeRegex(query), $options: "i" } },
      });
    const rowsPipe: PipelineStage.FacetPipelineStage[] = [
      { $sort: buildCommentableSort(sort) },
      { $skip: (page - 1) * PRODUCTS_LIST_PAGE_SIZE },
      { $limit: PRODUCTS_LIST_PAGE_SIZE },
      {
        $lookup: {
          from: "productsellers",
          localField: "_id",
          foreignField: "product",
          as: "sellers",
          // only live offers of active pharmacies, cheapest first (the card
          // shows sellers[0] as "from" price, like Halodoc / Digikala)
          pipeline: [
            { $match: { isActive: true } },
            {
              $lookup: {
                from: "pharmacies",
                localField: "seller",
                foreignField: "_id",
                as: "seller",
                pipeline: [{ $match: { active: true } }],
              },
            },
            { $unwind: "$seller" },
            {
              $addFields: {
                finalPrice: {
                  $subtract: ["$price", { $ifNull: ["$discount", 0] }],
                },
              },
            },
            { $sort: { finalPrice: 1, order: 1, _id: 1 } },
          ],
        },
      },
      {
        $lookup: {
          from: "productcategories",
          localField: "category",
          foreignField: "_id",
          as: "category",
        },
      },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "pharmacies",
          localField: "owner",
          foreignField: "_id",
          as: "owner",
        },
      },
      { $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "products",
          localField: "products",
          foreignField: "_id",
          as: "products",
        },
      },
    ];
    const pipe: PipelineStage[] = [
      ...(!!packageOnly
        ? [{ $match: { _id: { $exists: false } } }]
        : matchPipeLine),
      { $addFields: { model: "Product" } },
      {
        $unionWith: {
          coll: "productpackages",
          pipeline: [
            ...matchPipeLine,
            { $addFields: { model: "ProductPackage" } },
          ],
        },
      },
      { $facet: { data: rowsPipe, count: [{ $count: "count" }] } },
    ];
    const data = await Product.aggregate(pipe);
    const count = data[0].count[0]?.count || 0;
    const categories = await ProductCategory.find({ isActive: true }).sort({
      order: 1,
      _id: 1,
    });
    const specials = await ProductSeller.find({ isActive: true, special: true })
      .sort({ order: 1, _id: 1 })
      .limit(3)
      .populate([{ path: "product" }, { path: "seller" }]);
    res.status(200).json({
      message: "getProducts",
      data: {
        data: data[0].data || [],
        count,
        pagesCount: Math.ceil(count / PRODUCTS_LIST_PAGE_SIZE),
        categories,
        specials,
      },
    });
  },
);

export const getProduct: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    const payload = isValidObjectId(slug)
      ? { _id: slug, isActive: true, slug: { $exists: false } }
      : { slug, isActive: true };
    const data = await Product.findOne(payload).populate([
      { path: "category" },
      // its drug decides the "requires prescription" badge (2026-10)
      productRxPopulate,
      {
        path: "images",
        match: { isActive: true },
        options: { sort: { order: 1, _id: 1 } },
      },
      {
        path: "specs",
        match: { isActive: true },
        options: { sort: { order: 1, _id: 1 } },
      },
      {
        path: "sellers",
        match: { isActive: true },
        options: { sort: { order: 1, _id: 1 } },
        populate: {
          path: "seller",
          match: { active: true },
          populate: { path: "province" },
        },
      },
      {
        path: "sameAs",
        options: { sort: { order: 1, _id: 1 } },
        populate: { path: "category" },
      },
    ]);
    if (!data) return next(new NotFoundError());
    // drop offers whose pharmacy is inactive (populate left seller null),
    // and offers that cannot be bought (2026-10): the pharmacy's plan takes
    // no online orders, or its own stock of this product ran out
    const json = data.toJSON() as unknown as { sellers?: { seller?: { _id?: unknown } | null }[] };
    const live = (json.sellers || []).filter((el) => !!el?.seller?._id);
    const buyable = await Promise.all(
      live.map(async (el) => {
        const sellerId = el.seller!._id;
        const [modules, out] = await Promise.all([
          resolvePharmacyModules(sellerId),
          outOfStockProducts(sellerId, [data._id]),
        ]);
        return modules.includes("incomingOrders") && !out.size;
      }),
    );
    json.sellers = live.filter((_, i) => buyable[i]);
    // where each seller ships it (2026-10): a hint, the cart enforces it
    const areas = await deliveryAreasOf(
      json.sellers.map((el) => el.seller as Parameters<typeof deliveryAreasOf>[0][number]),
    );
    json.sellers = json.sellers.map((el) => ({
      ...el,
      deliveryArea: areas.get(String(el.seller!._id)),
    }));
    res.status(200).json({ message: "getProduct", data: { data: json } });
  },
);

export const getProductPackage: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    const data = await ProductPackage.findOne(
      isValidObjectId(slug)
        ? { _id: slug, isActive: true, slug: { $exists: false } }
        : { slug, isActive: true },
    ).populate([
      { path: "specs" },
      { path: "images" },
      {
        path: "sameAs",
        populate: [
          { path: "category" },
          { path: "owner" },
          { path: "products" },
        ],
      },
      { path: "category" },
      { path: "owner" },
      { path: "products", select: "name slug image" },
    ]);
    if (!data) return next(new NotFoundError());
    // "price when bought separately" is this pharmacy's own offer for each
    // product (2026-10), not the catalog's base price nobody pays
    const json = data.toJSON() as any;
    const ownerId = json.owner?._id || json.owner;
    const offers = ownerId
      ? await ProductSeller.find({
          seller: ownerId,
          product: { $in: (json.products || []).map((p: any) => p?._id).filter(Boolean) },
        })
          .select("product price discount")
          .lean<{ product: unknown; price?: number; discount?: number }[]>()
      : [];
    const priceOf = new Map(
      offers.map((o) => [String(o.product), Math.max(0, Number(o.price || 0) - Number(o.discount || 0))]),
    );
    json.products = (json.products || [])
      .filter((p: any) => p && typeof p === "object")
      .map((p: any) => ({ ...p, price: priceOf.get(String(p._id)) ?? 0 }));
    // where its pharmacy ships it (2026-10, Lib/delivery.ts)
    if (json.owner && typeof json.owner === "object")
      json.deliveryArea = (await deliveryAreasOf([json.owner])).get(String(json.owner._id));
    // a package with a prescription-only product ships only in its city
    const rxProducts = await Product.find({ _id: { $in: json.products.map((p: any) => p._id) } })
      .select("prescriptionRequired drug")
      .populate(productRxPopulate)
      .lean();
    json.requiresPrescription = packageNeedsRx({ products: rxProducts });
    res.status(200).json({ message: "getProductPackage", data: { data: json } });
  },
);

export const getDoctorProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    if (!slug) return next(new BadInputError());
    const options = [
      { path: "mainSpeciality" },
      { path: "specialities", match: { active: true } },
      // the services from the catalogue (a suggestion under review shows on
      // the doctor's own page already)
      { path: "serviceCategories", match: { isActive: true }, select: ["title", "slug", "pendingReview"] },
      // the council inquiry's result (the verified tick), not its account
      { path: "mcCode", select: ["mcCode", "title"] },
      { path: "gallery" },
      // a switched-off office is not an address patients should go to
      { path: "offices", match: { active: true } },
      { path: "socials" },
    ];
    // a deactivated doctor is not public (the lists already hide them)
    let data = await DoctorProfile.findOne({ slug, active: true }).populate(options);
    if (!data && isValidObjectId(slug))
      data = await DoctorProfile.findOne({ _id: slug, active: true }).populate(options);
    if (!data) return next(new NotFoundError());
    const faqs = await DoctorFaq.find({
      active: true,
      $or: [{ doctor: null }, { doctor: data._id }],
    }).sort({ order: 1, _id: 1 });
    // the contact section links only to what passes the same checks as the
    // panel's form (Lib/contactLinks.ts): older or hand-edited values that
    // do not are left out, never linked as typed
    const doctor = data.toJSON() as Record<string, any>;
    doctor.website = normalizeWebsite(doctor.website) || undefined;
    doctor.landLine = normalizeLandLine(doctor.landLine) || undefined;
    doctor.socials = (Array.isArray(doctor.socials) ? doctor.socials : [])
      .map((s: { media?: string; target?: string }) => ({ ...s, target: normalizeSocial(s?.media, s?.target) }))
      .filter((s: { target: string | null }) => !!s.target);
    res
      .status(200)
      .json({ message: "getDoctorProfile", data: { doctor, faqs } });
  },
);

export const getDoctorProfileById: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await DoctorProfile.findOne({
      _id: nodeId,
      active: true,
    }).populate([
      { path: "shifts", populate: { path: "office" } },
      { path: "mainSpeciality" },
      { path: "voiceCallSettings" },
      { path: "sipCallSettings" },
      { path: "textChatSettings" },
      { path: "videoCallSettings" },
      { path: "inPersonSettings" },
    ]);
    if (!node) return next(new NotFoundError());
    // Effective visit tax (2026-09, see Lib/taxSettings.ts) - attached here
    // (not stored on the doc) so Components/Booking/Finalize/FinalizeBookingPage.tsx's
    // checkout view can show it without needing admin access: the
    // *TaxSettings admin-CRUD routes themselves are admin-only
    // (Routers/autoRouter.ts), same reasoning as
    // Controllers/cartController.ts's getCartSummary.
    // the same resolver the booking uses (Lib/taxSettings.ts
    // getVisitTaxPercent): 0 unless the doctor is registered with Moadian,
    // then the office's place of service, the doctor, the platform default
    const visitTaxPercent = await getVisitTaxPercent(node._id);
    const officeTaxPercents: Record<string, number> = {};
    const shifts = ((node as unknown as { shifts?: { office?: { _id?: unknown; clinic?: unknown; hospital?: unknown } }[] }).shifts || []);
    for (const shift of shifts) {
      const office = shift.office;
      if (!office?._id || (!office.clinic && !office.hospital)) continue;
      const key = String(office._id);
      if (key in officeTaxPercents) continue;
      officeTaxPercents[key] = await getVisitTaxPercent(node._id, office);
    }
    res.status(200).json({
      message: "getDoctorProfileById",
      data: {
        ...node.toObject({ virtuals: true }),
        visitTaxPercent,
        officeTaxPercents,
      },
    });
  },
);

export const getDoctorAvailabilities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const doctor = await DoctorProfile.findOne({ _id: nodeId, active: true });
    if (!doctor) return next(new NotFoundError());
    const data = await DoctorAvailability.find({ doctor: doctor._id });
    res.status(200).json({ message: "getDoctorAvailabilities", data });
  },
);

const getInsurancesSchema = z.strictObject({
  ...listFilterSchema,
  query: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  category: z.string().optional(),
  sort: z
    .enum(commentableSortOptions)
    .optional()
    .default(defaultCommentableSort),
});

const INSURANCES_PAGE_SIZE = 9;

export const getInsurances: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      success,
      error,
    } = await getInsurancesSchema.spa(req.query);
    if (!success) return next(new BadInputError());
    const { category: categoryId, page, query, sort } = input;
    const payload: Record<string, unknown> = { active: true };
    if (query) payload.name = { $regex: escapeRegex(query), $options: "i" };
    if (categoryId) {
      let category: IInsuranceCategory | null = null;
      if (isValidObjectId(categoryId)) {
        category = await InsuranceCategory.findOne({
          _id: categoryId,
          slug: { $exists: false },
          isActive: true,
        });
      } else {
        category = await InsuranceCategory.findOne({
          slug: categoryId,
          isActive: true,
        });
      }
      if (!category) return next(new NotFoundError());
      payload.category = category._id;
    }
    const filters = await applyListFilters(input, payload, InsuranceTag, {
      insurances: false,
    });
    if (!filters) return next(new NotFoundError());
    const rows = await Insurance.find(payload)
      .limit(INSURANCES_PAGE_SIZE)
      .skip((page - 1) * INSURANCES_PAGE_SIZE)
      .sort(buildCommentableSort(sort))
      .populate([{ path: "tags", match: { isActive: true } }, { path: "category" }]);
    const networks = await getInsuranceNetworks(rows.map((el) => el._id));
    const data = rows.map((el) => ({
      ...el.toJSON(),
      network: networks.get(String(el._id)),
    }));
    const count = await Insurance.countDocuments(payload);
    const totalCount = await Insurance.countDocuments({ active: true });
    const categories = await InsuranceCategory.find({ isActive: true }).sort({
      order: 1,
      _id: 1,
    });
    res.status(200).json({
      message: "getInsurances",
      data: {
        data,
        totalCount,
        pagesCount: Math.ceil(count / INSURANCES_PAGE_SIZE),
        stats: await getSiteStats(),
        filters,
        categories,
      },
    });
  },
);

export const getInsurance: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    const data = await Insurance.findOne(
      isValidObjectId(nodeId)
        ? // an insurer with a slug is only served at its slug URL
          { _id: nodeId, active: true, slug: { $exists: false } }
        : { active: true, slug: nodeId },
    ).populate([
      { path: "category" },
      {
        path: "plans",
        match: { isActive: true },
        options: { sort: { order: 1, _id: 1 } },
      },
      { path: "tags", match: { isActive: true } },
    ]);
    if (!data) return next(new NotFoundError());
    const network = (await getInsuranceNetworks([data._id])).get(
      String(data._id),
    );
    // a plan is asked for through the insurer's own sales pipeline: its
    // public inquiry form (/f/<slug>, the CRM's webform) when it has one on
    const crm = await BizCrmSettings.findOne({
      ownerKind: "insurance",
      ownerId: data._id,
      "webform.enabled": true,
    })
      .select("webform.slug")
      .lean<{ webform?: { slug?: string } }>();
    res.status(200).json({
      message: "getInsurance",
      data: {
        data: {
          ...data.toJSON(),
          network,
          requestForm: crm?.webform?.slug || null,
        },
      },
    });
  },
);

export const getFaqs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const categories = await FaqCategory.find({ isActive: true }).sort({
      order: 1,
      _id: 1,
    });
    // a switched-off category hides its questions (they used to stay under
    // "all"); a question with no category is always listed
    const data = await Faq.find({
      isActive: true,
      $or: [
        { category: null },
        { category: { $in: categories.map((el) => el._id) } },
      ],
    }).sort({ order: 1, _id: 1 });
    res.status(200).json({ message: "getFaqs", data: { data, categories } });
  },
);

// Active booking-flow descriptions (2026-09) - see Models/BookingDescription.ts.
// Returned as a flat list sorted by `order` (then _id as a stable
// tiebreaker, matching getFaqs above); the frontend (app/book/page.tsx)
// groups the list by `segment` (Doctor/Clinic/Pharmacy).
export const getBookingDescriptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await BookingDescription.find({ isActive: true }).sort({
      order: 1,
      _id: 1,
    });
    res
      .status(200)
      .json({ message: "getBookingDescriptions", data: { data } });
  },
);

export const getOffice: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Office.findById(nodeId);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getOffice", data });
  },
);

export const getDoctorInsurance: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await DoctorInsurance.findById(nodeId);
    if (!node) return next(new NotFoundError());
    const data = await Insurance.findOne({ _id: node.insurance, active: true });
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getDoctorInsurance", data });
  },
);

const SEARCH_LIMIT = 5;
const searchNodeSchema = z.strictObject({ query: z.string().min(1).trim() });
// a form's category picker loads its first options before anyone types
// (2026-10): an empty query lists them instead of failing
const pickerQuerySchema = z.object({ query: z.string().trim().optional().default("") });
export const searchClinics: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await searchNodeSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await Clinic.find({
      name: { $regex: escapeRegex(data.query), $options: "i" },
      active: true,
    })
      .sort({ order: 1, _id: 1 })
      .limit(SEARCH_LIMIT);
    res.status(200).json({ message: "searchClinics", data: nodes });
  },
);

export const searchSpecialities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await searchNodeSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await Speciality.find({
      name: { $regex: escapeRegex(data.query), $options: "i" },
      active: true,
    })
      .sort({ order: 1, _id: 1 })
      .limit(SEARCH_LIMIT);
    res.status(200).json({ message: "searchSpecialities", data: nodes });
  },
);

export const searchInsurances: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await searchNodeSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await Insurance.find({
      name: { $regex: escapeRegex(data.query), $options: "i" },
      active: true,
    })
      .select(["name", "slug", "image"])
      .sort({ order: 1, _id: 1 })
      .limit(SEARCH_LIMIT);
    res.status(200).json({ message: "searchInsurances", data: nodes });
  },
);

// the address form's city picker (a plain list the form filters as you
// type): active cities with their province - all of them when no query
const searchCitiesSchema = z.strictObject({
  query: z.string().trim().optional().default(""),
});
export const searchCities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await searchCitiesSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await City.find({
      name: { $regex: escapeRegex(data.query), $options: "i" },
      isActive: true,
    })
      .select(["name", "province"])
      .populate({ path: "province", select: "name" })
      .sort({ order: 1, _id: 1 })
      .limit(data.query ? SEARCH_LIMIT : 2000);
    res.status(200).json({ message: "searchCities", data: nodes });
  },
);

export const searchDiseases: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await searchNodeSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await Disease.find({
      name: { $regex: escapeRegex(data.query), $options: "i" },
      ...PUBLIC_MEDICAL,
    })
      .sort({ order: 1, _id: 1 })
      .limit(SEARCH_LIMIT);
    res.status(200).json({ message: "searchDiseases", data: nodes });
  },
);

export const searchServiceCategories: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await searchNodeSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    // the reviewed catalogue, ی/ي, ک/ك and half-spaces alike
    const nodes = await ServiceCategory.find({
      ...PUBLIC_SERVICE_CATEGORY,
      title: { $regex: looseServiceRegex(data.query), $options: "i" },
    })
      .sort({ order: 1, _id: 1 })
      .limit(SEARCH_LIMIT);
    res.status(200).json({ message: "searchServiceCategories", data: nodes });
  },
);

// Results below are shaped to match exactly what each entity's list-page
// card component reads (see Components/<Entity>/<Entity>Card.tsx on the
// frontend), so the same card can be reused as-is inside the global search
// dropdown: populated category/province/tags/owner where the card needs a
// name off of them, plus the synthetic `model` field ProductCard/ServiceCard
// use to tell a package apart from its base entity.
const GLOBAL_SEARCH_DOCTORS_PER_SPECIALITY = 6;

// How a typed text finds a doctor (2026-10, doctor profile audit): the full
// name as people type it ("سارا محمدی" matched neither the first nor the last
// name alone), either name, the council code (Paziresh24 / Doctolib search
// by it), and the doctors of a speciality whose name matches ("قلب").
const doctorQueryMatch = (
  query: string,
  specialityIds: unknown[] = [],
  serviceIds: unknown[] = [],
) => {
  const text = query.trim().replace(/\s+/g, " ");
  const regex = { $regex: escapeRegex(text), $options: "i" };
  return [
    { firstName: regex },
    { lastName: regex },
    {
      $expr: {
        $regexMatch: {
          input: {
            $concat: [{ $ifNull: ["$firstName", ""] }, " ", { $ifNull: ["$lastName", ""] }],
          },
          regex: escapeRegex(text),
          options: "i",
        },
      },
    },
    ...(/^\d{3,}$/.test(text) ? [{ medicalSystemCode: text }] : []),
    ...(specialityIds.length
      ? [{ mainSpeciality: { $in: specialityIds } }, { specialities: { $in: specialityIds } }]
      : []),
    // the doctors who list a matching catalogue service ("بوتاکس")
    ...(serviceIds.length ? [{ serviceCategories: { $in: serviceIds } }] : []),
  ];
};

// the reviewed catalogue services a typed text names
const matchedServiceIds = (query: string) =>
  ServiceCategory.find({
    ...PUBLIC_SERVICE_CATEGORY,
    title: { $regex: looseServiceRegex(query.trim()), $options: "i" },
  }).distinct("_id");

export const globalSearch: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await searchNodeSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const regex = { $regex: escapeRegex(data.query), $options: "i" };
    // searching a speciality ("قلب") also finds the doctors who practise it
    const matchedSpecialityIds = await Speciality.find({ active: true, name: regex }).distinct("_id");
    const matchedServices = await matchedServiceIds(data.query);
    const [
      blogs,
      rawProducts,
      rawProductPackages,
      diseases,
      clinics,
      paraClinics,
      hospitals,
      tests,
      rawServices,
      rawServicePackages,
      specialities,
      symptoms,
      rawInsurances,
      doctorProfiles,
      drugs,
      rawPharmacies,
    ] = await Promise.all([
      Blog.find({ title: regex, published: true })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select(["title", "slug", "summary", "image", "readTime", "readMinutes"]),
      Product.find({ name: regex, isActive: true })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select([
          "name",
          "slug",
          "image",
          "category",
          "averageScore",
          "commentCount",
        ])
        .populate([
          { path: "category", select: ["name"] },
          {
            path: "sellers",
            // live offers only: a card must not show a withdrawn price
            match: { isActive: true },
            select: ["price", "discount", "seller"],
            populate: { path: "seller", select: ["name"] },
          },
        ])
        .lean(),
      ProductPackage.find({ name: regex, isActive: true })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select([
          "name",
          "slug",
          "image",
          "category",
          "owner",
          "products",
          "price",
          "discount",
          "averageScore",
          "commentCount",
        ])
        .populate([
          { path: "category", select: ["name"] },
          { path: "owner", select: ["name"] },
          { path: "products", select: ["name"] },
        ])
        .lean(),
      Disease.find({ name: regex, ...PUBLIC_MEDICAL })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select([
          "name",
          "slug",
          "summary",
          "tag",
          "category",
          "symptoms",
          "drugs",
        ])
        .populate([
          { path: "tag", select: ["name", "level"], match: { isActive: true } },
          { path: "category", select: ["name"] },
        ]),
      Clinic.find({ name: regex, active: true })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select([
          "name",
          "slug",
          "image",
          "category",
          "isRoundTheClock",
          "averageScore",
          "province",
          "tags",
        ])
        .populate([
          { path: "category", select: ["name"] },
          { path: "province", select: ["name"] },
          { path: "tags", select: ["name"], match: { isActive: true } },
        ]),
      ParaClinic.find({ name: regex, active: true })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select(["name", "slug", "image", "province", "tags", "averageScore", "commentCount"])
        .populate([
          { path: "province", select: ["name"] },
          { path: "tags", select: ["name"], match: { isActive: true } },
        ]),
      Hospital.find({ name: regex, isActive: true })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select([
          "name",
          "slug",
          "image",
          "commentCount",
          "averageScore",
          "province",
          "bedCount",
          "tags",
        ])
        .populate([
          { path: "province", select: ["name"] },
          { path: "tags", select: ["name"], match: { isActive: true } },
        ]),
      Test.find({ name: regex, isActive: true })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select(["name", "slug", "summary", "category"])
        .populate({ path: "category", select: ["name"] }),
      Service.find({ name: regex, isActive: true })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select([
          "name",
          "slug",
          "image",
          "price",
          "discount",
          "averageScore",
          "commentCount",
          "category",
          "owner",
        ])
        .populate([
          { path: "category", select: ["title"] },
          {
            path: "owner",
            select: ["firstName", "lastName", "avatar", "province"],
            populate: { path: "province", select: ["name"] },
          },
        ])
        .lean(),
      ServicePackage.find({ name: regex, isActive: true })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select([
          "name",
          "slug",
          "image",
          "price",
          "discount",
          "averageScore",
          "commentCount",
          "category",
          "owner",
          "services",
        ])
        .populate([
          { path: "category", select: ["title"] },
          {
            path: "owner",
            select: ["firstName", "lastName", "avatar", "province"],
            populate: { path: "province", select: ["name"] },
          },
          { path: "services", select: ["name"] },
        ])
        .lean(),
      Speciality.find({ name: regex, active: true })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select(["name", "slug"])
        .populate([
          { path: "doctorsCountWithMainSpeciality" },
          { path: "doctorsCountWithSideSpeciality" },
          {
            path: "doctors",
            // per speciality (a plain `limit` caps all of them together)
            perDocumentLimit: GLOBAL_SEARCH_DOCTORS_PER_SPECIALITY,
            options: { sort: { order: 1, _id: 1 } },
            select: ["firstName", "lastName", "slug", "province"],
            populate: { path: "province", select: ["name"] },
          },
        ]),
      Symptom.find({ name: regex, ...PUBLIC_MEDICAL })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select(["name", "slug", "summary"]),
      Insurance.find({ name: regex, active: true })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select([
          "name",
          "slug",
          "image",
          "category",
          "tags",
          "membersCount",
          "establishment",
          "averageScore",
        ])
        .populate([
          { path: "category", select: ["name"] },
          { path: "tags", select: ["name"], match: { isActive: true } },
        ]),
      DoctorProfile.find({
        active: true,
        $or: doctorQueryMatch(data.query, matchedSpecialityIds, matchedServices),
      })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        // everything the shared doctor card shows (score, reviews, visit
        // types, province) - the card is the same as on the homepage
        .select(DOCTOR_CARD_FIELDS)
        .populate([
          { path: "mainSpeciality", select: ["name", "slug"] },
          { path: "voiceCallSettings" },
          { path: "sipCallSettings" },
          { path: "textChatSettings" },
          { path: "videoCallSettings" },
          { path: "inPersonSettings" },
          { path: "province" },
        ]),
      Drug.find({ name: regex, ...PUBLIC_MEDICAL })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select(["name", "slug", "brand", "dosage", "tag"])
        .populate({ path: "tag", select: ["name"], match: { isActive: true } }),
      Pharmacy.find({ name: regex, active: true })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select(["name", "slug", "avatar", "province", "averageScore", "commentCount"])
        .populate({ path: "province", select: ["name"] })
        .lean(),
    ]);
    // shown with the paraclinic card: `image` is the pharmacy's avatar
    const pharmacies = rawPharmacies.map((el: any) => ({
      ...el,
      image: el.avatar,
      tags: [],
    }));
    const products = rawProducts.map((el) => ({ ...el, model: "Product" }));
    const productPackages = rawProductPackages.map((el) => ({
      ...el,
      model: "ProductPackage",
    }));
    const networks = await getInsuranceNetworks(rawInsurances.map((el) => el._id));
    const insurances = rawInsurances.map((el) => ({
      ...el.toJSON(),
      network: networks.get(String(el._id)),
    }));
    const services = rawServices.map((el) => ({ ...el, model: "Service" }));
    const servicePackages = rawServicePackages.map((el) => ({
      ...el,
      model: "ServicePackage",
    }));
    res.status(200).json({
      message: "globalSearch",
      data: {
        blogs,
        products,
        productPackages,
        diseases,
        clinics,
        paraClinics,
        hospitals,
        tests,
        services,
        servicePackages,
        specialities,
        symptoms,
        insurances,
        doctorProfiles: await doctorCards(doctorProfiles),
        drugs,
        pharmacies,
      },
    });
  },
);

const bookingSorts = [
  "Best",
  "Worst",
  "MostRecommended",
  "LeastRecommended",
  // the soonest free slot first (doctors only, 2026-10); org lists read it
  // as "Best"
  "Earliest",
] as const;

type BookingSort = (typeof bookingSorts)[number];

const bookingSortToColId: Record<BookingSort, Record<string, 1 | -1>> = {
  Best: { averageRatings: -1 },
  Worst: { averageRatings: 1 },
  MostRecommended: { recommendationsCount: -1 },
  LeastRecommended: { recommendationsCount: 1 },
  Earliest: { earliestKey: 1, averageRatings: -1 },
};

// Clinics (and any org type carrying the generic Comment averageScore /
// commentCount fields) don't have a separate feedback aggregation like
// doctors do, so sort directly on those persisted fields instead.
const orgBookingSortToColId: Record<BookingSort, Record<string, 1 | -1>> = {
  Best: { averageScore: -1 },
  Worst: { averageScore: 1 },
  MostRecommended: { commentCount: -1 },
  LeastRecommended: { commentCount: 1 },
  Earliest: { averageScore: -1 },
};

const filterBookingSchema = z
  .strictObject({
    clinic: asArray(z.string().regex(/^[0-9a-fA-F]{24}$/)).optional(),
    sessionType: asArray(z.enum(doctorSessionTypes)).optional(),
    "location.coords.lat": z.coerce.number().min(-90).max(90).optional(),
    "location.coords.lng": z.coerce.number().min(-180).max(180).optional(),
    "location.radius": z.coerce.number().min(1).max(50).optional(),
    province: z.string().optional(),
    city: z.string().optional(),
    district: asArray(z.string()).optional(),
    speciality: asArray(z.string().regex(/^[0-9a-fA-F]{24}$/)).optional(),
    disease: asArray(z.string().regex(/^[0-9a-fA-F]{24}$/)).optional(),
    // accepted insurers (DoctorInsurance) - "who takes my insurance"
    insurance: asArray(z.string().regex(/^[0-9a-fA-F]{24}$/)).optional(),
    service: asArray(z.string()).optional(),
    tier: asArray(z.enum(doctorProfileTiers)).optional(),
    gender: asArray(z.enum(genders)).optional(),
    "date.start": z.coerce.number().int().optional(),
    "date.end": z.coerce.number().int().optional(),
    "time.start": z.coerce
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .optional(),
    "time.end": z.coerce
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .optional(),
    onlyAvailable: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    ePresc: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    query: z.string().max(50).optional(),
    sort: z.enum(bookingSorts),
    page: z.coerce.number().int().min(1),
  })
  .superRefine((parsed, ctx) => {
    const geoFields = [
      parsed["location.coords.lat"],
      parsed["location.coords.lng"],
      parsed["location.radius"],
    ];
    const geoCount = geoFields.filter((v) => typeof v === "number").length;
    if (geoCount !== 0 && geoCount !== 3) {
      ctx.addIssue({
        code: "custom",
        message: "Bad Geospatial Data",
      });
    }
    if (geoCount !== 0 && (parsed.district || parsed.city || parsed.province)) {
      ctx.addIssue({ code: "custom", message: "Conflicting Geo Data" });
    }
    if (
      typeof parsed["time.start"] === "number" &&
      typeof parsed["time.end"] === "number" &&
      parsed["time.end"] <= parsed["time.start"]
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Bad Time Data",
      });
    }
    if (
      typeof parsed["date.start"] === "number" &&
      typeof parsed["date.end"] === "number" &&
      parsed["date.end"] <= parsed["date.start"]
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Bad Date Data",
      });
    }
  });

const FILTER_BOOKING_PAGE_SIZE = 6;

// sort key: the instant of the doctor's first cached free bound (none: last)
const earliestSortStages = (): PipelineStage.FacetPipelineStage[] => {
  const now = tehranParts();
  const today = startOfTehranDay();
  const fromMinute = (now.hour + 1) * 60;
  return [
    {
      $lookup: {
        from: "doctoravailabilities",
        localField: "_id",
        foreignField: "doctor",
        as: "firstFree",
        pipeline: [
          { $match: { date: { $gte: today } } },
          {
            $project: {
              date: 1,
              bounds: {
                $filter: {
                  input: "$bounds",
                  as: "b",
                  cond: { $or: [{ $gt: ["$date", today] }, { $gte: ["$$b.start", fromMinute] }] },
                },
              },
            },
          },
          { $match: { "bounds.0": { $exists: true } } },
          { $sort: { date: 1 } },
          { $limit: 1 },
          { $project: { date: 1, first: { $min: "$bounds.start" } } },
        ],
      },
    },
    {
      $addFields: {
        earliestKey: {
          $ifNull: [
            {
              $add: [
                { $toLong: { $first: "$firstFree.date" } },
                { $multiply: [{ $first: "$firstFree.first" }, 60000] },
              ],
            },
            Number.MAX_SAFE_INTEGER,
          ],
        },
      },
    },
    { $project: { firstFree: 0 } },
  ];
};


export const filterBooking2: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success, error } = await filterBookingSchema.safeParseAsync(
      req.query,
    );
    if (!success) {
      console.log(error);
      return next(new BadInputError());
    }
    const {
      "date.end": dateEnd,
      "date.start": dateStart,
      "location.coords.lat": lat,
      "location.coords.lng": lng,
      "location.radius": rad,
      "time.end": timeEnd,
      "time.start": timeStart,
      clinic: clinics,
      disease: diseases,
      ePresc: ePresc,
      gender: gender,
      onlyAvailable: onlyAvbailable,
      query,
      service: serviceCategories,
      sessionType: sessionTypes,
      speciality: specialties,
      sort,
      page,
      district: districtIds,
      city: cityId,
      province: provinceId,
      insurance: insuranceIds,
    } = data;
    const pipe: PipelineStage[] = [{ $match: { active: true } }];
    if (insuranceIds?.length) {
      // the booking quote's rule: the doctor's own list or the clinic /
      // hospital of their office (Lib/insuranceNetwork.ts)
      // filtered to online visits only: a centre's insurers do not apply
      const accepting = await doctorIdsAccepting(insuranceIds, {
        centres: !sessionTypes?.length || sessionTypes.includes("inPerson"),
      });
      pipe.push({ $match: { _id: { $in: accepting } } });
    }
    // "issues e-prescriptions": doctors connected to Tamin (they have saved
    // Tamin credentials) - the filter used to be read and then ignored
    if (ePresc) {
      const taminDoctors = await DoctorTaminCred.distinct("doctor");
      pipe.push({ $match: { _id: { $in: taminDoctors } } });
    }
    //GEO

    let geo: IPolygon[] | undefined;
    if (provinceId) {
      if (!cityId) {
        if (!isValidObjectId(provinceId)) return next(new BadInputError());
        const province = await Province.findById(provinceId);
        if (!province) return next(new BadInputError());
        geo = [province.geometry];
      } else {
        if (!districtIds?.length) {
          if (!isValidObjectId(cityId)) return next(new BadInputError());
          const city = await City.findById(cityId);
          if (!city) return next(new BadInputError());
          geo = [city.geometry];
        } else {
          const districts = await District.find({ _id: { $in: districtIds } });
          geo = districts
            .filter((el) => !!el.geometry)
            .map((el) => el.geometry);
        }
      }
    }
    if (provinceId) {
      // inside the area's shape OR registered in that province / city /
      // district - a profile without map coordinates used to vanish
      const declared = districtIds?.length
        ? { district: { $in: districtIds.filter((d) => isValidObjectId(d)).map((d) => new mongoose.Types.ObjectId(d)) } }
        : cityId && isValidObjectId(cityId)
          ? { city: new mongoose.Types.ObjectId(cityId) }
          : { province: new mongoose.Types.ObjectId(provinceId) };
      pipe.push({
        $match: {
          $or: [
            declared,
            // an area without a drawn shape only matches by reference
            ...(geo || [])
              .filter(Boolean)
              .map((g) => ({ location: { $geoWithin: { $geometry: g } } })),
          ],
        },
      });
    }
    if (
      typeof lat === "number" &&
      typeof lng === "number" &&
      typeof rad === "number"
    ) {
      pipe.push({
        $match: {
          location: {
            $geoWithin: {
              $centerSphere: [[lng, lat], (rad * 1000) / 6378137],
            },
          },
        },
      });
    }
    if (!!gender?.length) {
      pipe.push({ $match: { gender: { $in: gender } } });
    }
    // no "education" (tier) filter: only the admin could set a tier, so
    // choosing one hid almost every doctor
    //Clinic
    if (clinics?.length) {
      pipe.push(
        {
          $lookup: {
            from: "clinicdoctors",
            localField: "_id",
            foreignField: "doctor",
            as: "clinics",
          },
        },
        {
          $match: {
            clinics: {
              $elemMatch: {
                clinic: {
                  $in: clinics.map((el) => new mongoose.Types.ObjectId(el)),
                },
              },
            },
          },
        },
      );
    }
    //Disease An Speciality
    if (diseases?.length || specialties?.length) {
      const specPipe: PipelineStage[] = [];
      if (specialties) {
        specPipe.push({
          $match: {
            _id: {
              $in: specialties.map((el) => new mongoose.Types.ObjectId(el)),
            },
          },
        });
      }
      if (diseases?.length) {
        specPipe.push(
          {
            $lookup: {
              from: "diseases",
              localField: "_id",
              foreignField: "specialities",
              as: "diseases",
            },
          },
          {
            $match: {
              "diseases._id": {
                $in: diseases.map((el) => new mongoose.Types.ObjectId(el)),
              },
            },
          },
        );
      }
      specPipe.push({ $project: { _id: 1 } });
      const filteredSpecialities = (await Speciality.aggregate(specPipe)).map(
        (el) => el._id,
      );
      pipe.push({
        $match: {
          $or: [
            { mainSpeciality: { $in: filteredSpecialities } },
            { specialities: { $in: filteredSpecialities } },
          ],
        },
      });
    }
    //Service
    if (serviceCategories?.length) {
      pipe.push(
        {
          $lookup: {
            from: "services",
            localField: "_id",
            foreignField: "owner",
            as: "services",
            pipeline: [
              {
                $match: {
                  category: {
                    $in: serviceCategories.map(
                      (el) => new mongoose.Types.ObjectId(el),
                    ),
                  },
                },
              },
            ],
          },
        },
        // a priced service of that type, or the type listed on the profile
        {
          $match: {
            $or: [
              { "services.0": { $exists: true } },
              {
                serviceCategories: {
                  $in: serviceCategories.map((el) => new mongoose.Types.ObjectId(el)),
                },
              },
            ],
          },
        },
      );
    }
    //Session
    // a doctor who really takes that visit type: switched on with a price
    // and held by a shift at an active office (Lib/doctorOffer.ts) - the
    // shifts alone listed doctors whose video visits were switched off
    if (sessionTypes?.length) {
      const offering = await doctorsOffering(sessionTypes);
      pipe.push({ $match: { _id: { $in: offering } } });
    }
    if (
      dateEnd ||
      dateStart ||
      timeEnd !== undefined ||
      timeStart !== undefined ||
      onlyAvbailable
    ) {
      const availabilityPipe: Exclude<
        PipelineStage,
        PipelineStage.Merge | PipelineStage.Out
      >[] = [];
      if (dateEnd) {
        // through the whole Tehran day of dateEnd (Lib/tehranTime.ts)
        const endDay = parseTehranDay(dateEnd);
        if (endDay)
          availabilityPipe.push({ $match: { date: { $lt: addTehranDays(endDay, 1) } } });
      }
      if (dateStart) {
        const startDay = parseTehranDay(dateStart);
        if (startDay) availabilityPipe.push({ $match: { date: { $gte: startDay } } });
      }
      if (timeStart !== undefined) {
        availabilityPipe.push({ $match: { start: { $gte: timeStart } } });
      }
      if (timeEnd !== undefined) {
        availabilityPipe.push({ $match: { end: { $lte: timeEnd } } });
      }
      pipe.push({
        $lookup: {
          from: "doctoravailabilities",
          localField: "_id",
          foreignField: "doctor",
          as: "availabilities",
          pipeline: !!availabilityPipe.length ? availabilityPipe : undefined,
        },
      });
      if (onlyAvbailable) {
        pipe.push({ $match: { "availabilities.0": { $exists: true } } });
      }
    }
    if (query?.trim()) {
      // full name, council code, or a matching speciality's doctors - the
      // same matching as the header search (doctorQueryMatch)
      const matched = await Speciality.find({
        active: true,
        name: { $regex: escapeRegex(query.trim()), $options: "i" },
      }).distinct("_id");
      const services = await matchedServiceIds(query);
      pipe.push({ $match: { $or: doctorQueryMatch(query, matched, services) } as never });
    }
    // today and the next two Tehran days
    const now = startOfTehranDay();
    const end = addTehranDays(now, 3);
    //Population
    let rowPipe: PipelineStage.FacetPipelineStage[] = [
      {
        // collection of the DoctorFeedBack model (the model name itself,
        // used here before, matched nothing: every doctor sorted as 0)
        $lookup: {
          from: "doctorfeedbacks",
          localField: "_id",
          foreignField: "doctor",
          as: "feedbacks",
          pipeline: [
            { $match: { status: "Approved" } },
            { $project: { overalScore: 1, suggest: 1 } },
          ],
        },
      },
      {
        $addFields: {
          averageRatings: { $ifNull: [{ $avg: "$feedbacks.overalScore" }, 0] },
          feedacksCount: { $size: "$feedbacks" },
          recommendationsCount: {
            $size: {
              $filter: {
                input: "$feedbacks",
                as: "feedback",
                cond: { $eq: ["$$feedback.suggest", true] },
              },
            },
          },
        },
      },
      // "earliest available" is ordered below, outside this pipeline, by
      // the same nextSlot the cards show (Lib/nextSlot.ts earliestOrder)
      { $sort: { ...bookingSortToColId[sort === "Earliest" ? "Best" : sort], order: 1, _id: 1 } },
      { $skip: (page - 1) * FILTER_BOOKING_PAGE_SIZE },
      { $limit: FILTER_BOOKING_PAGE_SIZE },
      // the card needs the counts, not every feedback document
      { $project: { feedbacks: 0 } },
      {
        $lookup: {
          from: "specialities",
          localField: "mainSpeciality",
          foreignField: "_id",
          as: "mainSpeciality",
        },
      },
      {
        $unwind: { preserveNullAndEmptyArrays: true, path: "$mainSpeciality" },
      },
      {
        $lookup: {
          from: "provinces",
          localField: "province",
          foreignField: "_id",
          as: "province",
        },
      },
      { $unwind: { preserveNullAndEmptyArrays: true, path: "$province" } },
      {
        $lookup: {
          from: "cities",
          localField: "city",
          foreignField: "_id",
          as: "city",
        },
      },
      { $unwind: { preserveNullAndEmptyArrays: true, path: "$city" } },
      {
        $lookup: {
          from: "districts",
          localField: "district",
          foreignField: "_id",
          as: "district",
        },
      },
      { $unwind: { preserveNullAndEmptyArrays: true, path: "$district" } },
      {
        $lookup: {
          from: "doctoravailabilities",
          localField: "_id",
          foreignField: "doctor",
          as: "availabilities",
          pipeline: [{ $match: { date: { $lt: end, $gte: now } } }],
        },
      },
    ];
    // "near me": the closest by travel time, not by rating (Lib/nearbyTravel.ts)
    let arrange: ReturnType<typeof travelPage>["arrange"] | undefined;
    let precise: Map<string, NextSlot | null> | undefined;
    if (sort === "Earliest" && !(typeof lat === "number" && typeof lng === "number")) {
      // "earliest available" (2026-10): the cached availability gives every
      // matching doctor a lower bound (it ignores the visit type and
      // inactive offices, so the real first slot is never earlier); the
      // real one - the card's own nextSlot - is computed for a bounded
      // window of the best candidates, batched (Lib/nextSlot.ts), and the
      // window grows until the page is provably in order
      const ranked = await DoctorProfile.aggregate<{ _id: mongoose.Types.ObjectId; earliestKey: number }>([
        ...pipe,
        ...rowPipe.slice(0, 2),
        ...earliestSortStages(),
        { $sort: { earliestKey: 1, averageRatings: -1, order: 1, _id: 1 } },
        { $project: { _id: 1, earliestKey: 1 } },
      ]);
      const order = await earliestOrder(ranked, page * FILTER_BOOKING_PAGE_SIZE, { sessionTypes });
      precise = order.slots;
      const ids = order.ids.slice((page - 1) * FILTER_BOOKING_PAGE_SIZE, page * FILTER_BOOKING_PAGE_SIZE);
      const rank = new Map(ids.map((id, i) => [id, i]));
      arrange = ((list: { _id: unknown }[]) =>
        [...list].sort((a, b) => (rank.get(String(a._id)) ?? 99) - (rank.get(String(b._id)) ?? 99))) as never;
      rowPipe = [
        { $match: { _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } } },
        ...rowPipe.filter((stage) => !("$sort" in stage || "$skip" in stage || "$limit" in stage)),
      ];
    } else if (typeof lat === "number" && typeof lng === "number") {
      const places = await DoctorProfile.aggregate([...pipe, { $project: { location: 1 } }]);
      const near = travelPage(await rankByTravel({ lat, lng }, places), page, FILTER_BOOKING_PAGE_SIZE);
      arrange = near.arrange;
      rowPipe = [
        { $match: { _id: { $in: near.ids } } },
        ...rowPipe.filter((stage) => !("$sort" in stage || "$skip" in stage || "$limit" in stage)),
      ];
    }
    pipe.push({ $facet: { rows: rowPipe, count: [{ $count: "total" }] } });
    //Execute
    const result = await DoctorProfile.aggregate(pipe);
    if (arrange && result[0]) result[0].rows = arrange(result[0].rows || []);
    const rows: {
      _id: mongoose.Types.ObjectId;
      sessionTypes?: string[];
      officeAddress?: string;
    }[] = result[0]?.rows ?? [];
    if (rows.length) {
      // visit types the doctor really offers and the booking action, the
      // same rule as every other card (Lib/doctorOffer.ts)
      await attachDoctorCards(rows);
      const ids = rows.map((el) => el._id);
      // the practice address for the card (profile address is optional)
      const offices = await Office.find({ doctor: { $in: ids }, active: true })
        .sort({ _id: 1 })
        .select({ doctor: 1, address: 1 });
      for (const row of rows)
        row.officeAddress =
          offices.find((el) => el.doctor?.toString() === row._id.toString() && !!el.address)
            ?.address || undefined;
    }
    // «اولین نوبت» on each card, for the whole page at once (Lib/nextSlot.ts);
    // the earliest sort computed it already
    if (rows.length) {
      const missing = precise ? rows.filter((r) => !precise!.has(String(r._id))) : rows;
      if (precise)
        for (const r of rows) if (precise.has(String(r._id))) Object.assign(r, { nextSlot: precise.get(String(r._id)) });
      if (missing.length) await attachNextSlots(missing, { sessionTypes });
    }
    res.status(200).json({ message: "filterBooking2", data: result[0] });
  },
);

const filterBookingPharmacySchema = z
  .strictObject({
    sort: z.enum(bookingSorts),
    page: z.coerce.number().int().min(1),
    query: z.string().optional(),
    productQuery: z.string().optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radius: z.coerce.number().min(1).max(50).optional(),
    district: asArray(z.string().regex(/^[0-9a-fA-F]{24}$/)).optional(),
    city: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    province: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    category: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    // what a patient filters a pharmacy by in Iran (2026-10): open at night
    // (شبانه‌روزی) and the insurer that pays for the prescription
    roundTheClock: z.enum(["1"]).optional(),
    // open at this minute, Tehran time (Lib/openingHours.ts)
    openNow: z.enum(["1"]).optional(),
    insurance: asArray(z.string().regex(/^[0-9a-fA-F]{24}$/)).optional(),
  })
  .superRefine((parsed, ctx) => {
    const geoFileds = [parsed.lat, parsed.lng, parsed.radius];
    const geoCount = geoFileds.filter((v) => typeof v === "number").length;
    if (geoCount !== 0 && geoCount !== 3) {
      ctx.addIssue({ code: "custom", message: "Bad Geo Data" });
    }
    if (geoCount !== 0 && (parsed.district || parsed.city || parsed.province)) {
      ctx.addIssue({ code: "custom", message: "Conflicting geo Data" });
    }
  });

export const filterBookingPharmacy: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success, error } =
      await filterBookingPharmacySchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const {
      page,
      // NOTE: Pharmacy currently has no rating/comment fields (it isn't
      // part of the generic Comment system the way Clinic is), so the
      // Best/Worst/MostRecommended/LeastRecommended sort has no backing
      // metric to sort by yet. `sort` is still validated for API
      // compatibility with the other booking endpoints, but only a stable
      // `_id` order is applied below until Pharmacy gets a rating field.
      category: categoryId,
      district: districtIds,
      city: cityId,
      province: provinceId,
      lat,
      lng,
      productQuery,
      query,
      radius,
      roundTheClock,
      insurance,
      openNow,
    } = data;

    const now = new Date();
    const pipe: PipelineStage[] = [{ $match: { active: true } }];
    if (roundTheClock) pipe.push({ $match: { isRoundTheClock: true } });
    if (openNow) pipe.push({ $match: { _id: { $in: await openNowIds(Pharmacy, { active: true }, now) } } });
    if (insurance?.length)
      pipe.push({
        $match: { insurances: { $in: insurance.map((id) => new mongoose.Types.ObjectId(id)) } },
      });
    let geo: IPolygon[] | undefined;
    if (provinceId) {
      if (!cityId) {
        if (!isValidObjectId(provinceId)) return next(new BadInputError());
        const province = await Province.findById(provinceId);
        if (!province) return next(new BadInputError());
        geo = [province.geometry];
      } else {
        if (!districtIds?.length) {
          if (!isValidObjectId(cityId)) return next(new BadInputError());
          const city = await City.findById(cityId);
          if (!city) return next(new BadInputError());
          geo = [city.geometry];
        } else {
          const districts = await District.find({ _id: { $in: districtIds } });
          geo = districts
            .filter((el) => !!el.geometry)
            .map((el) => el.geometry);
        }
      }
    }
    if (provinceId) {
      // inside the area's shape OR registered in that province / city /
      // district - a profile without map coordinates used to vanish
      const declared = districtIds?.length
        ? { district: { $in: districtIds.filter((d) => isValidObjectId(d)).map((d) => new mongoose.Types.ObjectId(d)) } }
        : cityId && isValidObjectId(cityId)
          ? { city: new mongoose.Types.ObjectId(cityId) }
          : { province: new mongoose.Types.ObjectId(provinceId) };
      pipe.push({
        $match: {
          $or: [
            declared,
            // an area without a drawn shape only matches by reference
            ...(geo || [])
              .filter(Boolean)
              .map((g) => ({ location: { $geoWithin: { $geometry: g } } })),
          ],
        },
      });
    }
    if (
      typeof lat === "number" &&
      typeof lng === "number" &&
      typeof radius === "number"
    ) {
      pipe.push({
        $match: {
          location: {
            $geoWithin: {
              $centerSphere: [[lng, lat], (radius * 1000) / 6378137],
            },
          },
        },
      });
    }
    if (query)
      pipe.push({
        $match: { name: { $regex: escapeRegex(query), $options: "i" } },
      });
    if (categoryId || productQuery) {
      const productPipe: Exclude<
        PipelineStage,
        PipelineStage.Merge | PipelineStage.Out
      >[] = [];
      // only what is for sale: a live offer of an active catalog product
      productPipe.push(
        { $match: { isActive: true } },
        {
          $lookup: {
            from: "products",
            localField: "product",
            foreignField: "_id",
            as: "product",
          },
        },
        { $unwind: { path: "$product" } },
        { $match: { "product.isActive": true } },
      );
      pipe.push({
        $lookup: {
          from: "productsellers",
          localField: "_id",
          foreignField: "seller",
          as: "productSellers",
          pipeline: productPipe,
        },
      });
      if (productQuery)
        pipe.push(
          {
            $match: {
              "productSellers.product.name": {
                $regex: escapeRegex(productQuery),
                $options: "i",
              },
            },
          },
          { $match: { "productSellers.0": { $exists: true } } },
        );
      if (categoryId) {
        pipe.push(
          {
            $match: {
              "productSellers.product.category": new mongoose.Types.ObjectId(
                categoryId,
              ),
            },
          },
          { $match: { "productSellers.0": { $exists: true } } },
        );
      }
    }

    // "near me": the closest by travel time (Lib/nearbyTravel.ts)
    let near: ReturnType<typeof travelPage> | undefined;
    if (typeof lat === "number" && typeof lng === "number") {
      const places = await Pharmacy.aggregate([...pipe, { $project: { location: 1 } }]);
      near = travelPage(await rankByTravel({ lat, lng }, places), page, FILTER_BOOKING_PAGE_SIZE);
    }
    pipe.push({
      $facet: {
        rows: near
          ? [{ $match: { _id: { $in: near.ids } } }]
          : [
              { $sort: { _id: 1 } },
              { $skip: (page - 1) * FILTER_BOOKING_PAGE_SIZE },
              { $limit: FILTER_BOOKING_PAGE_SIZE },
            ],
        count: [{ $count: "total" }],
      },
    });
    const result = await Pharmacy.aggregate(pipe);
    if (near && result[0]) result[0].rows = near.arrange(result[0].rows || []);
    if (result[0]) result[0].rows = withOpenStatus(result[0].rows || [], now);
    res.status(200).json({ message: "FilterBookingPharmacy", data: result[0] });
  },
);

const filterBookingClinicSchema = z
  .strictObject({
    query: z.string().optional(),
    sort: z.enum(bookingSorts),
    page: z.coerce.number().int().min(1),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radius: z.coerce.number().min(1).max(50).optional(),
    district: asArray(z.string()).optional(),
    city: z.string().optional(),
    province: z.string().optional(),
    sessionType: asArray(z.enum(doctorSessionTypes)).optional(),
    speciality: asArray(z.string()).optional(),
    disease: asArray(z.string()).optional(),
    service: asArray(z.string()).optional(),
    insurance: asArray(z.string().regex(/^[0-9a-fA-F]{24}$/)).optional(),
    // open at this minute, Tehran time (Lib/openingHours.ts)
    openNow: z.enum(["1"]).optional(),
  })
  .superRefine((parsed, ctx) => {
    const geoFileds = [parsed.lat, parsed.lng, parsed.radius];
    const geoCount = geoFileds.filter((v) => typeof v === "number").length;
    if (geoCount !== 0 && geoCount !== 3) {
      ctx.addIssue({ code: "custom", message: "Bad Geo Data" });
    }
    if (geoCount !== 0 && (parsed.district || parsed.city || parsed.province)) {
      ctx.addIssue({ code: "custom", message: "Conflicting geo Data" });
    }
  });

export const filterBookingClinic: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      error,
      success,
    } = await filterBookingClinicSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const {
      page,
      sort,
      province: provinceId,
      city: cityId,
      district: districtIds,
      lat,
      lng,
      radius,
      query,
      disease: diseaseIds,
      service: serviceIds,
      sessionType: sessionTypes,
      speciality: specialityIds,
      insurance: insuranceIds,
      openNow,
    } = input;

    const now = new Date();
    const pipe: PipelineStage[] = [{ $match: { active: true } }];
    if (openNow) pipe.push({ $match: { _id: { $in: await openNowIds(Clinic, { active: true }, now) } } });
    if (insuranceIds?.length)
      pipe.push({
        $match: {
          insurances: {
            $in: insuranceIds.map((el) => new mongoose.Types.ObjectId(el)),
          },
        },
      });
    let geo: IPolygon[] | undefined;
    if (provinceId) {
      if (!cityId) {
        if (!isValidObjectId(provinceId)) return next(new BadInputError());
        const province = await Province.findById(provinceId);
        if (!province) return next(new BadInputError());
        geo = [province.geometry];
      } else {
        if (!districtIds?.length) {
          if (!isValidObjectId(cityId)) return next(new BadInputError());
          const city = await City.findById(cityId);
          if (!city) return next(new BadInputError());
          geo = [city.geometry];
        } else {
          const districts = await District.find({ _id: { $in: districtIds } });
          geo = districts
            .filter((el) => !!el.geometry)
            .map((el) => el.geometry);
        }
      }
    }
    if (provinceId) {
      // inside the area's shape OR registered in that province / city /
      // district - a profile without map coordinates used to vanish
      const declared = districtIds?.length
        ? { district: { $in: districtIds.filter((d) => isValidObjectId(d)).map((d) => new mongoose.Types.ObjectId(d)) } }
        : cityId && isValidObjectId(cityId)
          ? { city: new mongoose.Types.ObjectId(cityId) }
          : { province: new mongoose.Types.ObjectId(provinceId) };
      pipe.push({
        $match: {
          $or: [
            declared,
            // an area without a drawn shape only matches by reference
            ...(geo || [])
              .filter(Boolean)
              .map((g) => ({ location: { $geoWithin: { $geometry: g } } })),
          ],
        },
      });
    }
    if (
      typeof lat === "number" &&
      typeof lng === "number" &&
      typeof radius === "number"
    ) {
      pipe.push({
        $match: {
          location: {
            $geoWithin: {
              $centerSphere: [[lng, lat], (radius * 1000) / 6378137],
            },
          },
        },
      });
    }

    let filteredSpecialities: mongoose.Types.ObjectId[] | undefined;
    if (diseaseIds || specialityIds) {
      const specPipe: PipelineStage[] = [];
      if (specialityIds) {
        specPipe.push({
          $match: {
            _id: {
              $in: specialityIds.map((el) => new mongoose.Types.ObjectId(el)),
            },
          },
        });
      }
      if (diseaseIds?.length) {
        specPipe.push(
          {
            $lookup: {
              from: "diseases",
              localField: "_id",
              foreignField: "specialities",
              as: "diseases",
            },
          },
          {
            $match: {
              "diseases._id": {
                $in: diseaseIds.map((el) => new mongoose.Types.ObjectId(el)),
              },
            },
          },
        );
      }
      specPipe.push({ $project: { _id: 1 } });
      filteredSpecialities = (await Speciality.aggregate(specPipe)).map(
        (el) => el._id,
      );
    }
    if (diseaseIds || serviceIds || sessionTypes || specialityIds) {
      const doctorPipe: Exclude<
        PipelineStage,
        PipelineStage.Merge | PipelineStage.Out
      >[] = [];
      if (sessionTypes) {
        doctorPipe.push({
          $lookup: {
            from: "doctorshifts",
            localField: "_id",
            foreignField: "doctor",
            as: "shifts",
          },
        });
      }
      if (serviceIds) {
        doctorPipe.push({
          $lookup: {
            from: "services",
            localField: "_id",
            foreignField: "owner",
            as: "services",
          },
        });
      }
      pipe.push({
        $lookup: {
          from: "clinicdoctors",
          localField: "_id",
          foreignField: "clinic",
          as: "clinicDoctors",
          pipeline: [
            {
              $lookup: {
                from: "doctorprofiles",
                localField: "doctor",
                foreignField: "_id",
                as: "doctor",
                pipeline: doctorPipe,
              },
            },
            { $unwind: { path: "$doctor", preserveNullAndEmptyArrays: true } },
          ],
        },
      });
    }
    if (!!filteredSpecialities)
      pipe.push(
        {
          $addFields: {
            specialities: {
              $reduce: {
                input: "$clinicDoctors",
                initialValue: [],
                in: {
                  $setUnion: [
                    "$$value",
                    {
                      $concatArrays: [
                        {
                          $cond: [
                            {
                              $ifNull: ["$$this.doctor.mainSpeciality", false],
                            },
                            ["$$this.doctor.mainSpeciality"],
                            [],
                          ],
                        },
                        {
                          $ifNull: ["$$this.doctor.specialities", []],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        { $match: { specialities: { $in: filteredSpecialities } } },
      );
    if (serviceIds) {
      pipe.push(
        {
          $addFields: {
            serviceCategories: {
              $reduce: {
                input: "$clinicDoctors",
                initialValue: [],
                in: {
                  $setUnion: [
                    "$$value",
                    {
                      $map: {
                        input: { $ifNull: ["$$this.doctor.services", []] },
                        as: "service",
                        in: "$$service.category",
                      },
                    },
                    // and the services listed on the doctor's profile
                    { $ifNull: ["$$this.doctor.serviceCategories", []] },
                  ],
                },
              },
            },
          },
        },
        {
          $match: {
            serviceCategories: {
              $in: serviceIds.map((el) => new mongoose.Types.ObjectId(el)),
            },
          },
        },
      );
    }
    if (sessionTypes) {
      pipe.push(
        {
          $addFields: {
            sessionTypes: {
              $reduce: {
                input: "$clinicDoctors",
                initialValue: [],
                in: {
                  $setUnion: [
                    "$$value",
                    {
                      $reduce: {
                        input: { $ifNull: ["$$this.doctor.shifts", []] },
                        initialValue: [],
                        in: {
                          $setUnion: [
                            "$$value",
                            { $ifNull: ["$$this.sessionTypes", []] },
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
        { $match: { sessionTypes: { $in: sessionTypes } } },
      );
    }
    if (query)
      pipe.push({
        $match: { name: { $regex: escapeRegex(query), $options: "i" } },
      });
    pipe.push({
      $unset: [
        "clinicDoctors",
        "sessionTypes",
        "serviceCategories",
        "specialities",
        "user",
      ],
    });
    // "near me": the closest by travel time, not by rating (Lib/nearbyTravel.ts)
    let near: ReturnType<typeof travelPage> | undefined;
    if (typeof lat === "number" && typeof lng === "number") {
      const places = await Clinic.aggregate([...pipe, { $project: { location: 1 } }]);
      near = travelPage(await rankByTravel({ lat, lng }, places), page, FILTER_BOOKING_PAGE_SIZE);
    }
    pipe.push({
      $facet: {
        rows: near
          ? [{ $match: { _id: { $in: near.ids } } }]
          : [
              { $sort: { ...orgBookingSortToColId[sort], _id: 1 } },
              { $skip: (page - 1) * FILTER_BOOKING_PAGE_SIZE },
              { $limit: FILTER_BOOKING_PAGE_SIZE },
            ],
        count: [{ $count: "total" }],
      },
    });
    const result = await Clinic.aggregate(pipe);
    if (near && result[0]) result[0].rows = near.arrange(result[0].rows || []);
    if (result[0]) result[0].rows = withOpenStatus(result[0].rows || [], now);
    res.status(200).json({ message: "filterBookingClinic", data: result[0] });
  },
);

const resolveLocationSchema = z.strictObject({
  lng: z.coerce.number().min(-180).max(180),
  lat: z.coerce.number().min(-90).max(90),
});
export const resolveLocation: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success, error } = await resolveLocationSchema.safeParseAsync(
      req.query,
    );
    if (!success) {
      console.log(error);
      return next(new BadInputError());
    }
    const districts = await District.find({
      geometry: {
        $geoIntersects: {
          $geometry: { type: "Point", coordinates: [data.lng, data.lat] },
        },
      },
      isActive: true,
    }).sort({ order: 1 });
    const cities = await City.find({
      geometry: {
        $geoIntersects: {
          $geometry: { type: "Point", coordinates: [data.lng, data.lat] },
        },
      },
      isActive: true,
    }).sort({ order: 1 });
    const provinces = await Province.find({
      geometry: {
        $geoIntersects: {
          $geometry: { type: "Point", coordinates: [data.lng, data.lat] },
        },
      },
      isActive: true,
    }).sort({ order: 1 });
    res.status(200).json({
      message: "resolveLocation",
      data: {
        district: districts[0] || null,
        city: cities[0] || null,
        province: provinces[0] || null,
      },
    });
  },
);

const searchZonesSchema = z.strictObject({ query: z.string().min(3).trim() });
export const searchZones: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, error, success } = await searchZonesSchema.safeParseAsync(
      req.query,
    );
    if (!success) return next(new BadInputError());
    const provinces = await Province.find({
      isActive: true,
      name: { $regex: escapeRegex(data.query), $options: "i" },
    });
    const cities = await City.find({
      isActive: true,
      name: { $regex: escapeRegex(data.query), $options: "i" },
    });
    const districts = await District.find({
      isActive: true,
      name: { $regex: escapeRegex(data.query), $options: "i" },
    });
    res
      .status(200)
      .json({ message: "searchZones", data: { provinces, cities, districts } });
  },
);

// no query: every province (the pharmacy delivery-area picker, 2026-10)
const getProvincesSchema = z.strictObject({ query: z.string().trim().optional().default("") });
export const getProvinces: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      success,
      error,
    } = await getProvincesSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    // a picker list: the drawn shapes are not sent
    const data = await Province.find({
      name: { $regex: escapeRegex(input.query), $options: "i" },
      isActive: true,
    }).select("-geometry");
    res.status(200).json({ message: "getProvinces", data });
  },
);

const getCitiesSchema = z.strictObject({
  query: z.string().min(2).trim(),
  province: z.string(),
});
export const getCities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      error,
      success,
    } = await getCitiesSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(input.province)) return next(new BadInputError());
    const province = await Province.findOne({
      _id: input.province,
      isActive: true,
    });
    if (!province) return next(new NotFoundError("استان"));
    const data = await City.find({
      province: province._id,
      name: { $regex: escapeRegex(input.query), $options: "i" },
      isActive: true,
    });
    res.status(200).json({ message: "getCities", data });
  },
);

const getDistrictsSchema = z.strictObject({
  query: z.string().min(2).trim(),
  city: z.string(),
});
export const getDistricts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      error,
      success,
    } = await getDistrictsSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(input.city)) return next(new BadInputError());
    const city = await City.findOne({ _id: input.city, isActive: true });
    if (!city) return next(new NotFoundError());
    const data = await District.find({
      city: city._id,
      name: { $regex: escapeRegex(input.query), $options: "i" },
      isActive: true,
    });
    res.status(200).json({ message: "getDistricts", data });
  },
);

export const getProductCategories: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await pickerQuerySchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await ProductCategory.find({
      // a deactivated category is not offered in pickers
      isActive: true,
      name: { $regex: escapeRegex(data.query), $options: "i" },
    })
      .sort({ order: 1, _id: 1 })
      .limit(SEARCH_LIMIT);
    res.status(200).json({ message: "getProductCategories", data: nodes });
  },
);

export const getClinicCategories: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await pickerQuerySchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await ClinicCategory.find({
      // a deactivated category is not offered in pickers
      isActive: true,
      name: { $regex: escapeRegex(data.query), $options: "i" },
    })
      .sort({ order: 1, _id: 1 })
      .limit(SEARCH_LIMIT);
    res.status(200).json({ message: "getClinicCategories", data: nodes });
  },
);

// Mirrors getHospitalCategories above - used by InsuranceManageDetailsTab's
// "category" select (2026-09).
export const getInsuranceCategoryOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await pickerQuerySchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await InsuranceCategory.find({
      // a deactivated category is not offered in pickers
      isActive: true,
      name: { $regex: escapeRegex(data.query), $options: "i" },
    })
      .sort({ order: 1, _id: 1 })
      .limit(SEARCH_LIMIT);
    res
      .status(200)
      .json({ message: "getInsuranceCategoryOptions", data: nodes });
  },
);

export const getHospitalCategories: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await pickerQuerySchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await HospitalCategory.find({
      // a deactivated category is not offered in pickers
      isActive: true,
      name: { $regex: escapeRegex(data.query), $options: "i" },
    })
      .sort({ order: 1, _id: 1 })
      .limit(SEARCH_LIMIT);
    res.status(200).json({ message: "getHospitalCategories", data: nodes });
  },
);

export const getParaClinicCategories: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await pickerQuerySchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await ParaClinicCategory.find({
      // a deactivated category is not offered in pickers
      isActive: true,
      name: { $regex: escapeRegex(data.query), $options: "i" },
    })
      .sort({ order: 1, _id: 1 })
      .limit(SEARCH_LIMIT);
    res.status(200).json({ message: "getParaClinicCategories", data: nodes });
  },
);

const submitAContactRequestSchema = z.strictObject({
  name: z.string(),
  phone: z.string(),
  email: z.string().optional(),
  subject: z.enum(contactRequestSubjects),
  content: z.string(),
});

export const submitAContactRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success, error } = await submitAContactRequestSchema.spa(
      req.body,
    );
    if (!success) return next(new BadInputError());
    await ContactRequest.create(data);
    res.status(200).json({ message: "submitAContactRequest" });
  },
);

export const getPolicy: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await PrivacySection.find({
      isActive: true,
      page: "Policy",
    }).sort({ order: 1, _id: 1 });
    res.status(200).json({ message: "getPolicy", data: { data } });
  },
);

export const getPrivacy: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await PrivacySection.find({
      isActive: true,
      page: "Privacy",
    }).sort({ order: 1, _id: 1 });
    res.status(200).json({ message: "getPrivacy", data: { data } });
  },
);

export const getAbout: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const whys = await AboutWhy.find({ isActive: true }).sort({
      order: 1,
      _id: 1,
    });
    const partners = await AboutPartner.find({ isActive: true }).sort({
      order: 1,
      _id: 1,
    });
    const team = await AboutTeam.find({ isActive: true }).sort({
      order: 1,
      _id: 1,
    });
    const staticImages = await getStaticImages();
    const stats = await getSiteStats();
    res.status(200).json({
      message: "getAbout",
      data: { whys, partners, team, staticImages, stats },
    });
  },
);

export const getOnboarding: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await Testify.find({ isActive: true }).sort({
      order: 1,
      _id: 1,
    });
    const staticImages = await getStaticImages();
    res
      .status(200)
      .json({ message: "getOnboarding", data: { data, staticImages } });
  },
);

const getListPageMetaSchema = z.strictObject({
  path: z.enum(pageMetaListResourceTypes),
});

export const getListPageMeta: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      error,
      success,
    } = getListPageMetaSchema.safeParse(req.query);
    if (!success) return next(new BadInputError());
    const data = await PageMeta.findOne({ resourceType: input.path });
    res.status(200).json({ message: "getListPageMeta", data: { data } });
  },
);

const getNodePageMetaSchema = z.strictObject({
  path: z.enum(pageMetaNodeResourceTypes),
  nodeSlug: z.string().min(1),
});

export const getNodePageMeta: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      error,
      success,
    } = getNodePageMetaSchema.safeParse(req.query);
    if (!success) return next(new BadInputError());
    if (!isNodeResourceType(input.path)) return next(new BadInputError());
    const data = await PageMeta.findOne({
      resourceType: decodeURIComponent(input.path),
      slug: decodeURIComponent(input.nodeSlug),
    });
    res.status(200).json({ message: "getNodePageMeta", data: { data } });
  },
);

const getAdvertisementsSchema = z.strictObject({
  position: z.enum(advertisementPositions),
  // pass this on node pages (e.g. a disease detail page) to prefer an ad
  // targeted at that specific document, falling back to the generic ad for
  // this position when none is targeted at it
  resourceId: z
    .string()
    .refine((value) => isValidObjectId(value))
    .optional(),
});

export const getAdvertisements: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      error,
      success,
    } = getAdvertisementsSchema.safeParse(req.query);
    if (!success) return next(new BadInputError());
    const data = await findAdvertisementsForPosition({
      position: input.position,
      resource: input.resourceId,
    });
    res.status(200).json({ message: "getAdvertisements", data: { data } });
  },
);

// every single-node public page that gets its own dedicated sitemap file,
// e.g. /sitemap/drug.xml. Mirrors Models/PageMeta's pageMetaNodeResourceTypes,
// but keeps "doctor" (legacy Doctor model, /doctor/[slug]) and "dr"
// (DoctorProfile model, /dr/[slug]) as two separate types since both routes
// are currently live and backed by different models.
export const sitemapNodeTypes = [
  "drug",
  "disease",
  "symptom",
  "speciality",
  "dr",
  "clinic",
  "hospital",
  "paraClinic",
  "insurance",
  "service",
  "servicePackage",
  "product",
  "productPackage",
  "pharmacy",
  "blog",
  // one page per lab test (2026-10, /test/<slug>)
  "test",
] as const;

export type SitemapNodeType = (typeof sitemapNodeTypes)[number];

export const isSitemapNodeType = (value: string): value is SitemapNodeType =>
  (sitemapNodeTypes as readonly string[]).includes(value);

// same "what counts as publicly visible" filter each list/detail controller
// above already applies for that model.
const sitemapNodeConfig: Record<
  SitemapNodeType,
  { model: mongoose.Model<any>; filter: Record<string, unknown> }
> = {
  drug: { model: Drug, filter: PUBLIC_MEDICAL },
  disease: { model: Disease, filter: PUBLIC_MEDICAL },
  symptom: { model: Symptom, filter: PUBLIC_MEDICAL },
  speciality: { model: Speciality, filter: { active: true } },
  dr: { model: DoctorProfile, filter: { active: true } },
  clinic: { model: Clinic, filter: { active: true } },
  hospital: { model: Hospital, filter: { isActive: true } },
  paraClinic: { model: ParaClinic, filter: { active: true } },
  insurance: { model: Insurance, filter: { active: true } },
  service: { model: Service, filter: { isActive: true } },
  servicePackage: { model: ServicePackage, filter: { isActive: true } },
  product: { model: Product, filter: { isActive: true } },
  productPackage: { model: ProductPackage, filter: { isActive: true } },
  pharmacy: { model: Pharmacy, filter: { active: true } },
  blog: { model: Blog, filter: { published: true } },
  test: { model: Test, filter: { isActive: true } },
};

// sitemaps.org allows up to 50,000 <url> entries per file, but this project
// caps each sitemap file at 10,000: once a node type has more publicly-
// visible documents than that, the frontend index starts requesting extra
// pages (sitemap/doctor.xml, sitemap/doctor02.xml, sitemap/doctor03.xml, ...).
export const SITEMAP_PAGE_SIZE = 10000;

// the sitemap lists only what search engines may index (2026-10): a page
// type the super admin marked noindex in «سئوی خودکار» has no URLs, and a
// record whose own SEO entry is noindex is left out.
const sitemapPagePath = (type: SitemapNodeType) =>
  type === "blog" ? "/mag/[blogSlug]" : `/${type}/[slug]`;

const sitemapNodeQuery = async (type: SitemapNodeType) => {
  const { filter } = sitemapNodeConfig[type];
  const path = sitemapPagePath(type);
  if (await SeoTemplate.exists({ resourceType: path, noIndex: true }))
    return { _id: { $exists: false } };
  const hidden = await PageMeta.distinct("slug", { resourceType: path, noIndex: true });
  return { ...filter, slug: { $exists: true, $nin: [null, "", ...hidden] } };
};

// returns { slug, lastmod } for one page (SITEMAP_PAGE_SIZE documents) of
// one node type, for the frontend to turn into a <urlset>.
export const getSitemapNodes: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { type } = req.params;
    if (!isSitemapNodeType(type)) return next(new BadInputError());
    const { page: _page } = req.query;
    const page = _page === undefined ? 1 : Number(_page);
    if (isNaN(page) || !Number.isInteger(page) || page < 1)
      return next(new BadInputError());
    const { model } = sitemapNodeConfig[type];
    const items = await model
      .find(await sitemapNodeQuery(type))
      .select({ slug: 1 })
      .sort({ _id: 1 })
      .skip((page - 1) * SITEMAP_PAGE_SIZE)
      .limit(SITEMAP_PAGE_SIZE)
      .lean();
    res.status(200).json({
      message: "getSitemapNodes",
      data: {
        items: items.map((item) => ({
          slug: item.slug as string,
          // no model here tracks updatedAt; the ObjectId's embedded
          // creation time is the closest thing we have to a lastmod.
          lastmod: (item._id as mongoose.Types.ObjectId)
            .getTimestamp()
            .toISOString(),
        })),
      },
    });
  },
);

// lightweight count so the sitemap index can work out how many
// SITEMAP_PAGE_SIZE-sized pages a node type needs, without pulling every
// slug just to count them.
export const getSitemapNodeCount: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { type } = req.params;
    if (!isSitemapNodeType(type)) return next(new BadInputError());
    const { model } = sitemapNodeConfig[type];
    const count = await model.countDocuments(await sitemapNodeQuery(type));
    res.status(200).json({ message: "getSitemapNodeCount", data: { count } });
  },
);


// One inline ad placed inside an article (2026-09). Articles used to fetch it
// from the admin-only /auto endpoint, so every visitor got an error box; only
// an active, unexpired ad is public now (both settings were ignored).
export const getInlineAd: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new NotFoundError());
    const data = await InlineAdvertisement.findOne({
      _id: nodeId,
      active: true,
      $or: [{ expiration: { $exists: false } }, { expiration: null }, { expiration: { $gt: new Date() } }],
    }).select("target image title subTitle");
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getInlineAd", data: { data } });
  },
);
