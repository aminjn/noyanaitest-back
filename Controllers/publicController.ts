import { NextFunction, Request, RequestHandler, Response } from "express";
import fs from "fs";
import path from "path";
import catchAsync from "../Lib/catchAsync";
import Blog, { IBlog } from "../Models/Blog";
import { pageLimit } from "../Lib/enums";
import BlogCategory, { IBlogCategory } from "../Models/BlogCategory";
import { isPositiveInt } from "../Lib/validators";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import mongoose, { isValidObjectId, ObjectId, PipelineStage } from "mongoose";
import TextContent from "../Models/TextContent";
import Speciality, { ISpeciality } from "../Models/Speciality";
import ParaClinicTag from "../Models/ParaClinicTag";
import ParaClinicCategory from "../Models/ParaClinicCategory";
import DoctorProfile, { doctorProfileTiers } from "../Models/DoctorProfile";
import { getDoctorVisitTaxPercent } from "../Lib/taxSettings";
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
import DoctorInsurance from "../Models/DoctorInsurance";
import ClinicDoctor from "../Models/ClinicDoctor";
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
import Clinic, { IClinic } from "../Models/Clinic";
import ClinicTag from "../Models/ClinicTag";
import HospitalTag from "../Models/HospitalTag";
import InsuranceTag from "../Models/InsuranceTag";
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
import DoctorAvailability from "../Models/DoctorAvailability";
import Pharmacy from "../Models/Pharmacy";
import ProductCategory, { IProductCategory } from "../Models/ProductCategory";
import ClinicCategory from "../Models/ClinicCategory";
import DiseaseCategory from "../Models/DiseaseCategory";
import SpecialityCategory from "../Models/SpecialityCategory";
import HospitalCategory, {
  IHospitalCategory,
} from "../Models/HospitalCategory";
import Hospital from "../Models/Hospital";
import ParaClinic from "../Models/Paraclinic";
import Test from "../Models/Test";
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

const asArray = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => {
    if (v == null) return undefined;
    return Array.isArray(v) ? v : [v];
  }, z.array(schema));

export const getSite: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    // Optional ?keys=a,b,c query param: when provided, only those fields are
    // returned instead of the entire TextContent document. This exists so
    // pages can request just the content keys they actually use instead of
    // the whole (currently ~1200 key) blob. Omitting the param preserves the
    // exact previous behavior (full document), so every existing caller
    // (root layout's full fetch, admin panel, etc.) is unaffected.
    const { keys } = req.query;
    let projection: string | undefined;
    if (typeof keys === "string" && keys.trim()) {
      const validPaths = new Set(Object.keys(TextContent.schema.paths));
      const requested = keys
        .split(",")
        .map((k) => k.trim())
        .filter((k) => validPaths.has(k));
      if (requested.length) projection = requested.join(" ");
    }

    let query = TextContent.findOneAndUpdate(
      {},
      {},
      { upsert: true, new: true },
    );
    if (projection) query = query.select(projection);
    const textContent = await query;
    res.status(200).json({ message: "getSite", data: { textContent } });
  },
);

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
    const advertisements = await findAdvertisementsForPosition({
      position: ["home1", "home2", "home3", "home4", "home5", "home6"],
      limit: 2,
    });
    const popularDoctors = await DoctorProfile.find({
      active: true,
      popular: true,
    })
      .sort({ order: 1 })
      .populate([
        { path: "mainSpeciality" },
        { path: "voiceCallSettings" },
        { path: "sipCallSettings" },
        { path: "textChatSettings" },
        { path: "videoCallSettings" },
        { path: "inPersonSettings" },
        { path: "province" },
      ]);
    const services = await Service.find({
      isActive: true,
      isHome: true,
    })
      .populate({ path: "owner" })
      .sort({ order: 1 });
    const faqs = await Faq.find({ isActive: true, isHome: true }).sort({
      order: 1,
    });
    const blogs = await Blog.find({ published: true, home: true })
      .sort({
        order: 1,
        _id: 1,
      })
      .populate({ path: "category" });
    const staticImages = await getStaticImages();
    res.status(200).json({
      message: "getHome",
      data: {
        examples,
        introduction,
        specialities,
        advertisements,
        popularDoctors,
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
      specialityCategories,
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
      ServiceCategory.find({ isActive: true }).sort({ order: 1, _id: 1 }),
      SpecialityCategory.find({ isActive: true }).sort({ order: 1, _id: 1 }),
      SymptomCategory.find({ isActive: true }).sort({ order: 1, _id: 1 }),
      InsuranceCategory.find({ isActive: true }).sort({ order: 1, _id: 1 }),
    ]);
    res.status(200).json({
      message: "getHeader",
      data: {
        blogCategories,
        productCategories,
        diseaseCategories,
        clinicCategories,
        paraClinicCategories,
        hospitalCategories,
        testCategories,
        serviceCategories,
        specialityCategories,
        symptomCategories,
        insuranceCategories,
      },
    });
  },
);

export const getSpecialityDoctors: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const speciality = await Speciality.findById(nodeId);
    if (!speciality) return next(new NotFoundError());
    const doctors = await DoctorProfile.find({
      active: true,
      $or: [
        { mainSpeciality: speciality._id },
        { specialities: speciality._id },
      ],
    }).populate([
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
      .json({ message: "getSpecialityDoctors", data: { doctors } });
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
    if (!success) return next(new BadInputError(error.message));
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
    const categories = await BlogCategory.find().sort({ order: -1 });
    const blogsCount = await Blog.countDocuments(query);
    const recommended = await Blog.find({
      published: true,
      recommended: true,
    }).sort({ order: 1, _id: 1 });
    const chosen = await Blog.find({ published: true, chosen: true })
      .sort({ order: 1, _id: 1 })
      .limit(2)
      .populate({ path: "category" });
    //TODO: change this
    const mostViewed = await Blog.find({ published: true })
      .sort({ order: 1, _id: 1 })
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
    if (!success) return next(new BadInputError(error.message));
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
        options: { sort: { order: -1, _id: -1 } },
        select: ["_id", "title", "order", "image", "summary", "slug"],
        match: { published: true },
      },
      { path: "category" },
      { path: "tags" },
    ];
    if (isValidObjectId(nodeId)) {
      blog = await Blog.findById(nodeId).populate(population);
      if (blog?.slug) return next(new NotFoundError());
    } else {
      blog = await Blog.findOne({ slug: nodeId }).populate(population);
    }
    if (!blog) return next(new NotFoundError());
    const thisWeek = await Blog.find({
      thisWeekSpecial: true,
      published: true,
    })
      .sort({ order: -1, _id: -1 })
      .select(["_id", "title", "order", "image", "summary", "slug"]);
    res.status(200).json({ message: "getBlog", data: { blog, thisWeek } });
  },
);

export const getSpecialityOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await Speciality.find({ active: true }).sort({
      order: -1,
      _id: -1,
    });
    res.status(200).json({ message: "getSpecialityOptions", data: { data } });
  },
);

export const getServiceCategoryOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await ServiceCategory.find({ isActive: true }).sort({
      order: -1,
      _id: -1,
    });
    res
      .status(200)
      .json({ message: "getServiceCategoryOptions", data: { data } });
  },
);

export const getParaClinicTagOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await ParaClinicTag.find({ isActive: true }).sort({
      order: -1,
      _id: -1,
    });
    res
      .status(200)
      .json({ message: "getParaClinicTagOptions", data: { data } });
  },
);

export const getClinicTagOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await ClinicTag.find({ isActive: true }).sort({
      order: -1,
      _id: -1,
    });
    res.status(200).json({ message: "getClinicTagOptions", data: { data } });
  },
);

export const getHospitalTagOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await HospitalTag.find({ isActive: true }).sort({
      order: -1,
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
      order: -1,
      _id: -1,
    });
    res.status(200).json({ message: "getInsuranceTagOptions", data: { data } });
  },
);

const DOCTORS_PER_PAGE_BOOKING = 25;
export const getBookingPage: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { page: _page } = req.query;
    const page = Number.isInteger(Number(_page)) ? Number(_page) : 1;
    const data = await DoctorProfile.find({ active: true })
      .populate({
        path: "mainSpeciality",
      })
      .sort({ order: 1, _id: 1 })
      .limit(DOCTORS_PER_PAGE_BOOKING)
      .skip((page - 1) * DOCTORS_PER_PAGE_BOOKING);
    res.status(200).json({ message: "getBookingPage", data });
  },
);

export const getUpcomingWeekAvailabelSessions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const now = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    const data = await DoctorSession.aggregate([
      {
        $match: {
          doctor: new mongoose.Types.ObjectId(nodeId),
          date: {
            $gte: getSessionDateKey(now),
            $lte: getSessionDateKey(nextWeek),
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
    const then = new Date(stamp);
    then.setHours(0);
    then.setMinutes(0);
    then.setMilliseconds(0);
    then.setSeconds(0);
    const data = await DoctorSession.aggregate([
      {
        $match: {
          doctor: new mongoose.Types.ObjectId(nodeId),
          date: getSessionDateKey(then),
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

export const getDoctorConfig: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await DoctorProfile.findById(nodeId);
    if (!node) return next(new NotFoundError());
    const sipCall = await SipCallSettings.findOne({ doctor: node._id });
    const voiceCall = await VoiceCallSettings.findOne({ doctor: node._id });
    const videoCall = await VideoCallSettings.findOne({ doctor: node._id });
    const inPerson = await InPersonSettings.findOne({ doctor: node._id });
    const textChat = await TextChatSettings.findOne({ doctor: node._id });
    const insurances = await DoctorInsurance.find({
      doctor: node._id,
    }).populate({ path: "insurance" });
    const clinics = await ClinicDoctor.find({ doctor: node._id });
    const offices = await Office.find({ doctor: node._id });
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
    const keys = [];
    const then = new Date();
    then.setHours(0);
    then.setMinutes(0);
    then.setSeconds(0);
    then.setMilliseconds(0);
    then.setDate(then.getDate() + 1);
    for (let i = 0; i < CHECK_FOR_AVAILABLE_SESSION_SPAN; ++i) {
      keys.push(getSessionDateKey(then));
      then.setDate(then.getDate() + 1);
    }
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

const boundsSchema = z.strictObject({
  bounds: z
    .tuple([isPoint, isPoint])
    .refine(
      ([[minLng, minLat], [maxLng, maxLat]]) =>
        minLng < maxLng && minLat < maxLat,
    ),
});

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
    const doctors = await DoctorProfile.find({
      active: true,
      location: {
        $geoWithin: { $geometry: { type: "Polygon", coordinates: [poly] } },
      },
    })
      .populate({
        path: "mainSpeciality",
      })
      .sort({ order: 1, _id: 1 })
      .limit(DOCTORS_PER_PAGE_BOOKING);
    res.status(200).json({ message: "searchInMap", data: { doctors } });
  },
);

export const getShortLink: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { token } = req.params;
    const data = await ShortLink.findOne({ token });
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getShortLink", data });
  },
);

export const getRedirect: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { path } = req.query;
    if (typeof path !== "string") return next(new BadInputError());
    const data = await Redirection.findOne({ old: path });
    res.status(200).json({ message: "getRedirect", data });
  },
);

const DOCTORS_PER_PAGE = 25;
// Public doctors list (2026-09): scoped to the Doctor model only - see
// AUDIT notes on Doctor vs. DoctorProfile being two separate entities.
// DoctorProfile (registered doctors' own dashboards/profiles) used to be
// interleaved into this same paginated list; that's been split off so
// app/doctors no longer mixes the two collections together.
export const getDoctors: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { page: _page } = req.query;
    const page = Number(_page);
    if (isNaN(page) || !Number.isInteger(page) || page < 1)
      return next(new BadInputError());
    const data = await Doctor.find({ active: true })
      .sort({ order: 1, _id: 1 })
      .limit(DOCTORS_PER_PAGE)
      .skip((page - 1) * DOCTORS_PER_PAGE)
      .populate({ path: "speciality", select: { name: 1, slug: 1 } })
      .select({ name: 1, image: 1, slug: 1 });
    if (!data.length) return next(new NotFoundError());
    const doctorCount = await Doctor.countDocuments({ active: true });
    res.status(200).json({
      message: "getDoctors",
      data: {
        data,
        pagesCount: Math.ceil(doctorCount / DOCTORS_PER_PAGE),
      },
    });
  },
);

export const getDoctor: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    if (!slug) return next(new BadInputError());
    let data: IDoctor | undefined | null;
    const options = [{ path: "speciality" }, { path: "gallery" }];
    data = await Doctor.findOne({ slug }).populate(options);
    if (!data) data = await Doctor.findOne({ name: slug }).populate(options);
    if (!data) return next(new NotFoundError());
    const faqs = await DoctorFaq.find({ active: true, doctor: null }).sort({
      order: 1,
      _id: 1,
    });
    res.status(200).json({ message: "getDoctor", data: { data, faqs } });
  },
);

const getSpecialitiesSchema = z.strictObject({
  page: z.coerce.number().int().min(1).optional().default(1),
  query: z.string().optional(),
  category: asArray(z.string()).optional(),
});

const SPECIALITIES_PER_PAGE = 9;
export const getSpecialities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      success,
      error,
    } = await getSpecialitiesSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError(error.message));
    const { page, query, category } = input;
    const payload: Record<string, unknown> = { active: true };
    if (query) payload.name = { $regex: escapeRegex(query), $options: "i" };
    if (category?.length) {
      const categories = await SpecialityCategory.find({
        $or: [
          { slug: { $in: category.filter((el) => !isValidObjectId(el)) } },
          { _id: { $in: category.filter((el) => isValidObjectId(el)) } },
        ],
      });
      payload.category = { $in: categories.map((el) => el._id) };
    }
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
          options: { limit: 15, sort: { order: 1, _id: 1 } },
          populate: { path: "province" },
        },
      ]);
    // if (!data.length) return next(new NotFoundError());
    const categories = await SpecialityCategory.find({ isActive: true });
    const count = await Speciality.countDocuments(payload);
    res.status(200).json({
      message: "getSpecialities",
      data: {
        data,
        pagesCount: Math.ceil(count / SPECIALITIES_PER_PAGE),
        categories,
      },
    });
  },
);

const getSpecialitySchema = z.strictObject({
  page: z.coerce.number().int().min(1).optional().default(1),
  slug: z.string(),
});
const SPECIALITY_DOCTORS_PER_PAGE = 6;
export const getSpeciality: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      success,
      error,
    } = await getSpecialitySchema.spa({ ...req.query, ...req.params });
    if (!success) return next(new BadInputError(error.message));
    const { page, slug } = input;
    const payload = isValidObjectId(slug)
      ? {
          _id: slug,
          active: true,
          slug: { $exists: false },
        }
      : { slug, active: true };
    const data = await Speciality.findOne(payload).populate({
      path: "category",
    });
    if (!data) return next(new NotFoundError());
    const pipe: PipelineStage[] = [
      { $match: { active: true } },
      {
        $match: {
          $or: [{ mainSpeciality: data._id }, { specialities: data._id }],
        },
      },
      {
        $facet: {
          data: [
            { $sort: { order: 1, _id: 1 } },
            { $skip: (page - 1) * SPECIALITY_DOCTORS_PER_PAGE },
            { $limit: SPECIALITY_DOCTORS_PER_PAGE },
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
            {
              $lookup: {
                from: "voicecallsettings",
                localField: "_id",
                foreignField: "doctor",
                as: "voiceCallSettings",
              },
            },
            {
              $unwind: {
                path: "$voiceCallSettings",
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $lookup: {
                from: "videocallsettings",
                localField: "_id",
                foreignField: "doctor",
                as: "videoCallSettings",
              },
            },
            {
              $unwind: {
                path: "$videoCallSettings",
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $lookup: {
                from: "inpersonsettings",
                localField: "_id",
                foreignField: "doctor",
                as: "inPersonSettings",
              },
            },
            {
              $unwind: {
                path: "$inPresonsettings",
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $lookup: {
                from: "sipcallsettings",
                localField: "_id",
                foreignField: "doctor",
                as: "sipCallSettings",
              },
            },
            {
              $unwind: {
                path: "$sipCallsettings",
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $lookup: {
                from: "textchatsettings",
                localField: "_id",
                foreignField: "doctor",
                as: "textChatSettings",
              },
            },
            {
              $unwind: {
                path: "$textChatsettings",
                preserveNullAndEmptyArrays: true,
              },
            },
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
                from: "doctorshifts",
                localField: "_id",
                foreignField: "doctor",
                as: "shifts",
              },
            },
            {
              $addFields: {
                sessionTypes: {
                  $reduce: {
                    input: { $ifNull: ["$shifts", []] },
                    initialValue: [],
                    in: {
                      $setUnion: [
                        "$$value",
                        { $ifNull: ["$$this.sessionTypes", []] },
                      ],
                    },
                  },
                },
              },
            },
            { $unset: "shifts" },
          ],
          count: [{ $count: "count" }],
        },
      },
    ];
    const doctors = await DoctorProfile.aggregate(pipe);
    const count = doctors[0].count?.[0]?.count || 0;
    res.status(200).json({
      message: "getSpeciality",
      data: {
        data,
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
    const { page: _page, query, sort: _sort } = req.query;
    const page = Number(_page);
    if (isNaN(page) || !Number.isInteger(page) || page < 1)
      return next(new BadInputError());
    if (query && typeof query !== "string") return next(new BadInputError());
    const sort =
      commentableSortOptions.find((el) => el === _sort) ||
      defaultCommentableSort;
    const payload = query
      ? { name: { $regex: escapeRegex(query), $options: "i" } }
      : {};
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
    const data = await Symptom.findOne(payload).populate([
      { path: "sameAs" },
      { path: "category" },
    ]);
    if (!data) return next(new NotFoundError());
    const diseases = await Disease.find({ symptoms: data._id });
    const drugIds = await Disease.distinct("drugs", { symptoms: data._id });
    const specialityIds = await Disease.distinct("specialities", {
      symptoms: data._id,
    });
    const drugs = await Drug.find({ _id: { $in: drugIds } });
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
      data: { data, doctors, diseases, drugs, specialities },
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
    const payload: Record<string, unknown> = query
      ? { name: { $regex: escapeRegex(query), $options: "i" } }
      : {};
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
      .populate([{ path: "tag" }, { path: "category" }]);
    if (!data.length) return next(new NotFoundError());
    const count = await Disease.countDocuments(payload);
    const categories = await DiseaseCategory.find({ isActive: true });
    res.status(200).json({
      message: "getDiseases",
      data: {
        data,
        pagesCount: Math.ceil(count / DISEASES_PER_PAGE),
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
    const data = await Disease.findOne(payload).populate([
      { path: "symptoms" },
      { path: "specialities" },
      { path: "drugs" },
      { path: "category" },
      { path: "sameAs" },
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
      .json({ message: "getDisease", data: { data, clinics, doctors } });
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
    const payload: Record<string, unknown> = query
      ? { name: { $regex: escapeRegex(query), $options: "i" } }
      : {};
    const data = await Drug.find(payload)
      .limit(DRUGS_PER_PAGE)
      .skip((page - 1) * DRUGS_PER_PAGE)
      .sort(buildCommentableSort(sort))
      .populate({ path: "tag" });
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
    const data = await Drug.findOne(payload).populate({ path: "sameAs" });
    if (!data) return next(new NotFoundError());
    const diseases = await Disease.find({ drugs: data._id });
    const specialityIds = await Disease.distinct("specialities", {
      drugs: data._id,
    });
    const specialities = await Speciality.find({ _id: { $in: specialityIds } });
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
      data: { data, diseases, doctors, specialities },
    });
  },
);

const getClinicsSchema = z.strictObject({
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
    if (!success) return next(new BadInputError(error.message));
    const payload: Record<string, unknown> = { active: true };
    if (input.query)
      payload.name = { $regex: escapeRegex(input.query), $options: "i" };
    if (input.category?.length) {
      const categories = await ClinicCategory.find({
        $or: [
          {
            slug: { $in: input.category.filter((el) => !isValidObjectId(el)) },
          },
          { _id: { $in: input.category.filter((el) => isValidObjectId(el)) } },
        ],
      });
      payload.category = { $in: categories.map((el) => el._id) };
    }
    const data = await Clinic.find(payload)
      .limit(CLINICS_PAGE_SIZE)
      .skip((input.page - 1) * CLINICS_PAGE_SIZE)
      .sort(buildCommentableSort(input.sort))
      .populate([{ path: "province" }, { path: "category" }, { path: "tags" }]);
    const count = await Clinic.countDocuments(payload);
    const categories = await ClinicCategory.find({ isActive: true });
    const specials = await Clinic.find({ active: true, special: true })
      .populate({ path: "province" })
      .sort({ order: 1, _id: 1 })
      .limit(3);
    res.status(200).json({
      message: "getClinics",
      data: {
        data,
        pagesCount: Math.ceil(count / CLINICS_PAGE_SIZE),
        categories,
        specials,
      },
    });
  },
);

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
        },
      },
      { $unwind: { path: "$province", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "clinictags",
          localField: "tags",
          foreignField: "_id",
          as: "tags",
        },
      },
      {
        $lookup: {
          from: "clinicdepartments",
          localField: "_id",
          foreignField: "clinic",
          as: "departments",
          pipeline: [
            { $match: { active: true } },
            {
              $lookup: {
                from: "clinicdoctors",
                localField: "_id",
                foreignField: "department",
                as: "doctors",
                pipeline: [
                  {
                    $lookup: {
                      from: "doctorprofiles",
                      localField: "doctor",
                      foreignField: "_id",
                      as: "doctor",
                      pipeline: [
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
                      ],
                    },
                  },
                  {
                    $unwind: {
                      path: "$doctor",
                      preserveNullAndEmptyArrays: true,
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      {
        $lookup: {
          from: "insurances",
          localField: "insurances",
          foreignField: "_id",
          as: "insurances",
        },
      },
      {
        $lookup: {
          from: "clinicdoctors",
          localField: "_id",
          foreignField: "clinic",
          as: "doctors",
          pipeline: [
            {
              $lookup: {
                from: "doctorprofiles",
                localField: "doctor",
                foreignField: "_id",
                as: "doctor",
                pipeline: [
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
                ],
              },
            },
            { $unwind: { path: "$doctor", preserveNullAndEmptyArrays: true } },
          ],
        },
      },
      {
        $addFields: {
          specialityIds: {
            $reduce: {
              input: "$departments",
              initialValue: [],
              in: {
                $setUnion: [
                  "$$value",
                  {
                    $map: {
                      input: "$$this.doctors",
                      as: "doctor",
                      in: "$$doctor.doctor.mainSpeciality._id",
                    },
                  },
                ],
              },
            },
          },
        },
      },
      {
        $lookup: {
          from: "specialities",
          localField: "specialityIds",
          foreignField: "_id",
          as: "specialities",
        },
      },
      {
        $unset: "specialityIds",
      },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "user",
          pipeline: [
            {
              $lookup: {
                from: "doctorprofiles",
                localField: "_id",
                foreignField: "user",
                as: "owner",
              },
            },
            { $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
          ],
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $set: {
          owner: "$user.owner",
        },
      },
      {
        $unset: "user",
      },
    ];

    const data = await Clinic.aggregate(pipe);

    if (!data[0]) return next(new NotFoundError());
    res.status(200).json({ message: "getClinic", data: { data: data[0] } });
  },
);

const getHospitalsSchema = z.strictObject({
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
    if (!success) return next(new BadInputError(error.message));
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
    const data = await Hospital.find(payload)
      .limit(HOSPITALS_PAGE_SIZE)
      .skip((page - 1) * HOSPITALS_PAGE_SIZE)
      .sort(buildCommentableSort(sort))
      .populate([{ path: "province" }, { path: "tags" }, { path: "category" }]);
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
        data,
        categories,
        provinces,
        pagesCount: Math.ceil(count / HOSPITALS_PAGE_SIZE),
        specials,
      },
    });
  },
);

export const getHospital: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    const data = await Hospital.findOne(
      isValidObjectId(slug)
        ? { _id: slug, isActive: true, slug: { $exists: false } }
        : { slug, isActive: true },
    ).populate([
      { path: "province" },
      { path: "category" },
      { path: "tags" },
      {
        path: "clinics",
        populate: {
          path: "clinic",
          populate: {
            path: "doctors",
            populate: { path: "doctor", populate: { path: "mainSpeciality" } },
          },
        },
      },
      { path: "owner" },
      { path: "insurances" },
    ]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getHospital", data: { data } });
  },
);

const getParaClinicsSchema = z.strictObject({
  query: z.string().optional(),
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
    if (!success) return next(new BadInputError(error.message));
    const payload: Record<string, unknown> = { active: true };
    if (input.query)
      payload.name = { $regex: escapeRegex(input.query), $options: "i" };
    if (input.category?.length) {
      const categories = await ParaClinicCategory.find({
        $or: [
          {
            slug: { $in: input.category.filter((el) => !isValidObjectId(el)) },
          },
          { _id: { $in: input.category.filter((el) => isValidObjectId(el)) } },
        ],
      });
      payload.category = { $in: categories.map((el) => el._id) };
    }
    const data = await ParaClinic.find(payload)
      .populate([{ path: "province" }, { path: "category" }, { path: "tags" }])
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
    res.status(200).json({
      message: "getParaClinics",
      data: {
        data,
        pagesCount: Math.ceil(count / PARACLINICS_LIST_PAGE_SIZE),
        categories,
        specials,
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
      { path: "tags" },
      { path: "images" },
      {
        path: "tests",
        populate: { path: "test", populate: { path: "category" } },
      },
      { path: "insurances" },
    ]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getParaClinic", data: { data } });
  },
);

const getTestsSchema = z.strictObject({
  query: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
});

const TESTS_LIST_PAGE_SIZE = 10;
export const getTests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data: input, error, success } = await getTestsSchema.spa(req.query);
    if (!success) return next(new BadInputError(error.message));
    const payload: Record<string, unknown> = { isActive: true };
    if (input.query)
      payload.name = { $regex: escapeRegex(input.query), $options: "i" };
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
    if (!success) return next(new BadInputError(error.message));
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
    const categories = await ServiceCategory.find({ isActive: true }).sort({
      order: 1,
      _id: 1,
    });
    const specials = await Service.find({ isActive: true, special: true })
      .sort({ order: 1, _id: 1 })
      .limit(3)
      .populate({ path: "owner" });
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
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getService", data: { data } });
  },
);

export const getServicePackage: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    console.log(slug);
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
    if (!data) return next(new NotFoundError());
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
    if (!success) return next(new BadInputError(error.message));
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
          pipeline: [
            { $sort: { order: 1, _id: 1 } },
            {
              $lookup: {
                from: "pharmacies",
                localField: "seller",
                foreignField: "_id",
                as: "seller",
                pipeline: [{ $sort: { order: 1, _id: 1 } }],
              },
            },
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
        populate: { path: "seller", populate: { path: "province" } },
      },
      {
        path: "sameAs",
        options: { sort: { order: 1, _id: 1 } },
        populate: { path: "category" },
      },
    ]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getProduct", data: { data } });
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
    ]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getProductPackage", data: { data } });
  },
);

export const getDoctorProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    if (!slug) return next(new BadInputError());
    const options = [
      { path: "mainSpeciality" },
      { path: "mcCode" },
      { path: "gallery" },
      { path: "offices" },
      { path: "socials" },
    ];
    let data = await DoctorProfile.findOne({ slug }).populate(options);
    if (!data)
      data = await DoctorProfile.findOne({ _id: slug }).populate(options);
    if (!data) return next(new NotFoundError());
    const faqs = await DoctorFaq.find({
      active: true,
      $or: [{ doctor: null }, { doctor: data._id }],
    }).sort({ order: 1, _id: 1 });
    res
      .status(200)
      .json({ message: "getDoctorProfile", data: { doctor: data, faqs } });
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
      { path: "phoneConsultSettings" },
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
    const visitTaxPercent = await getDoctorVisitTaxPercent(node._id);
    res.status(200).json({
      message: "getDoctorProfileById",
      data: { ...node.toObject({ virtuals: true }), visitTaxPercent },
    });
  },
);

export const getDoctorAvailabilities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const doctor = await DoctorProfile.findById(nodeId);
    if (!doctor) return next(new NotFoundError());
    const data = await DoctorAvailability.find({ doctor: doctor._id });
    res.status(200).json({ message: "getDoctorAvailabilities", data });
  },
);

const getInsurancesSchema = z.strictObject({
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
    if (!success) return next(new BadInputError(error.message));
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
    const data = await Insurance.find(payload)
      .limit(HOSPITALS_PAGE_SIZE)
      .skip((page - 1) * HOSPITALS_PAGE_SIZE)
      .sort(buildCommentableSort(sort))
      .populate([{ path: "tags" }, { path: "category" }]);
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
        ? { _id: nodeId, active: true }
        : { active: true, slug: nodeId },
    ).populate([
      { path: "category" },
      {
        path: "plans",
        match: { isActive: true },
        options: { sort: { order: 1, _id: 1 } },
      },
    ]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getInsurance", data: { data } });
  },
);

export const getFaqs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await Faq.find({ isActive: true }).sort({ order: 1, _id: 1 });
    const categories = await FaqCategory.find({ isActive: true }).sort({
      order: 1,
      _id: 1,
    });
    res.status(200).json({ message: "getFaqs", data: { data, categories } });
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
    const data = await Insurance.findById(node.insurance);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getDoctorInsurance", data });
  },
);

const SEARCH_LIMIT = 5;
const searchNodeSchema = z.strictObject({ query: z.string().min(1).trim() });
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

export const searchDiseases: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await searchNodeSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await Disease.find({
      name: { $regex: escapeRegex(data.query), $options: "i" },
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
    const nodes = await ServiceCategory.find({
      title: { $regex: escapeRegex(data.query), $options: "i" },
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

export const globalSearch: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await searchNodeSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const regex = { $regex: escapeRegex(data.query), $options: "i" };
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
      insurances,
      doctorProfiles,
      drugs,
    ] = await Promise.all([
      Blog.find({ title: regex, published: true })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select(["title", "slug", "summary", "image", "readTime"]),
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
      Disease.find({ name: regex })
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
          { path: "tag", select: ["name", "level"] },
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
          { path: "tags", select: ["name"] },
        ]),
      ParaClinic.find({ name: regex, active: true })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select(["name", "slug", "image", "province", "tags"])
        .populate([
          { path: "province", select: ["name"] },
          { path: "tags", select: ["name"] },
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
          { path: "tags", select: ["name"] },
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
            options: {
              limit: GLOBAL_SEARCH_DOCTORS_PER_SPECIALITY,
              sort: { order: 1, _id: 1 },
            },
            select: ["firstName", "lastName", "slug", "province"],
            populate: { path: "province", select: ["name"] },
          },
        ]),
      Symptom.find({ name: regex })
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
          "centersCount",
          "doctorsCount",
          "establishment",
          "averageScore",
        ])
        .populate([
          { path: "category", select: ["name"] },
          { path: "tags", select: ["name"] },
        ]),
      DoctorProfile.find({
        active: true,
        $or: [{ firstName: regex }, { lastName: regex }],
      })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select(["firstName", "lastName", "slug", "avatar", "mainSpeciality"])
        .populate([
          { path: "mainSpeciality", select: ["name", "slug"] },
          { path: "voiceCallSettings" },
          { path: "sipCallSettings" },
          { path: "textChatSettings" },
          { path: "videoCallSettings" },
          { path: "inPersonSettings" },
          { path: "province" },
        ]),
      Drug.find({ name: regex })
        .sort({ order: 1, _id: 1 })
        .limit(SEARCH_LIMIT)
        .select(["name", "slug", "brand", "dosage", "tag"])
        .populate({ path: "tag", select: ["name"] }),
    ]);
    const products = rawProducts.map((el) => ({ ...el, model: "Product" }));
    const productPackages = rawProductPackages.map((el) => ({
      ...el,
      model: "ProductPackage",
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
        doctorProfiles,
        drugs,
      },
    });
  },
);

const bookingSorts = [
  "Best",
  "Worst",
  "MostRecommended",
  "LeastRecommended",
] as const;

type BookingSort = (typeof bookingSorts)[number];

const bookingSortToColId: Record<BookingSort, Record<string, 1 | -1>> = {
  Best: { averageRatings: -1 },
  Worst: { averageRatings: 1 },
  MostRecommended: { recommendationsCount: -1 },
  LeastRecommended: { recommendationsCount: 1 },
};

// Clinics (and any org type carrying the generic Comment averageScore /
// commentCount fields) don't have a separate feedback aggregation like
// doctors do, so sort directly on those persisted fields instead.
const orgBookingSortToColId: Record<BookingSort, Record<string, 1 | -1>> = {
  Best: { averageScore: -1 },
  Worst: { averageScore: 1 },
  MostRecommended: { commentCount: -1 },
  LeastRecommended: { commentCount: 1 },
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

export const filterBooking: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success, error } = await filterBookingSchema.safeParseAsync(
      req.query,
    );
    if (!success) {
      console.log(error);
      return next(new AppError(error.message, 400));
    }
    const {
      "date.end": dateEnd,
      "date.start": dateStart,
      "location.coords.lat": lat,
      "location.coords.lng": lng,
      "location.radius": radius,
      "time.end": timeEnd,
      "time.start": timeStart,
      clinic: clinics,
      disease: diseases,
      district: districts,
      ePresc: ePresc,
      gender: gender,
      onlyAvailable: onlyAvbailable,
      query,
      service: serviceCategories,
      sessionType: sessionTypes,
      speciality: specialties,
      tier: tiers,
      page,
    } = data;
    // console.log({ data });
    let diseaseSpecs;
    if (diseases?.length) {
      // console.log(diseases.length);
      const targetDiseases = await Disease.find(
        { _id: { $in: diseases } },
        { specialities: 1 },
      ).lean();
      diseaseSpecs = targetDiseases
        .reduce(
          (acc, el) => [...acc, ...(el.specialities as any)],
          [] as mongoose.Types.ObjectId[],
        )
        .map((el) => el.toString());
    }
    const shouldApplySpecialities = !!specialties || !!diseaseSpecs;
    const effectiveSpecialities = new Set([
      ...(specialties || []),
      ...(diseaseSpecs || []),
    ]);
    let serviceDocs;
    if (serviceCategories?.length) {
      // console.log("Service Filter");
      const doctorsWithServices = await Service.distinct("owner", {
        category: { $in: [serviceCategories] },
        owner: { $ne: null, $exists: true },
      }).lean();
      serviceDocs = doctorsWithServices.map((el) => el.toString());
    }
    // console.log({ serviceDocs });
    let clinicDocs;
    if (clinics) {
      console.log("Clinics Filter");
      const doctorsInClinics = await ClinicDoctor.distinct("doctor", {
        clinic: { $in: clinics },
        doctor: { $ne: null, $exists: true },
      });
      clinicDocs = new Set(doctorsInClinics.map((el) => el.toString()));
    }
    // console.log({ clinicDocs });
    const shouldSearchSessions =
      onlyAvbailable || !!dateStart || !!dateEnd || !!timeStart || !!timeEnd;
    let doctorsWithSession;
    if (shouldSearchSessions) {
      console.log("session filter");
      //TODO: the session logic needs to change
      const sessionQuery: any = {};
      if (onlyAvbailable) sessionQuery.booking = null;
      sessionQuery.date = {
        $gte: getSessionDateKey(dateStart ? new Date(dateStart) : new Date()),
      };
      if (dateEnd)
        sessionQuery.date = {
          ...sessionQuery.date,
          $lte: getSessionDateKey(new Date(dateEnd)),
        };
      if (serviceDocs) {
        sessionQuery.doctor = { $in: serviceDocs };
      }
      if (typeof timeStart === "number") {
        sessionQuery.start = { $gte: timeStart };
      }
      if (typeof timeEnd === "number") {
        sessionQuery.end = { $lte: timeEnd };
      }
      if (sessionTypes?.length) {
        for (const st of sessionTypes) {
          sessionQuery[st] = true;
        }
      }
      const sessions = await DoctorSession.distinct(
        "doctor",
        sessionQuery,
      ).lean();
      doctorsWithSession = new Set(sessions.map((el) => el.toString()));
    }
    const shouldApplyDoctorPool = !!doctorsWithSession || !!clinicDocs;
    const docPool = [doctorsWithSession, clinicDocs].reduce(
      (acc, el) => acc.filter((x) => el?.has(x)),
      Array.from(doctorsWithSession || clinicDocs || []),
    );
    const doctorQuery: any = { active: true };
    if (shouldApplyDoctorPool) doctorQuery._id = { $in: docPool };
    if (shouldApplySpecialities)
      doctorQuery.$or = [
        { manSpeciality: { $in: effectiveSpecialities } },
        { specialties: { $in: effectiveSpecialities } },
      ];
    if (gender) doctorQuery.gender = gender;
    if (tiers) doctorQuery.tier = { $in: tiers };
    //TODO: add pagination
    const doctors = await DoctorProfile.find(doctorQuery)
      .populate([{ path: "shifts" }, { path: "mainSpeciality" }])
      .limit(FILTER_BOOKING_PAGE_SIZE);
    res.status(200).json({ message: "filterBooking", data: doctors });
  },
);

export const filterBooking2: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success, error } = await filterBookingSchema.safeParseAsync(
      req.query,
    );
    if (!success) {
      console.log(error);
      return next(new AppError(error.message, 400));
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
      tier: tiers,
      sort,
      page,
      district: districtIds,
      city: cityId,
      province: provinceId,
    } = data;
    const pipe: PipelineStage[] = [{ $match: { active: true } }];
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
    if (geo?.length) {
      pipe.push({
        $match: {
          $or: geo.map((g) => ({ location: { $geoWithin: { $geometry: g } } })),
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
    if (!!tiers) {
      pipe.push({ $match: { tier: { $in: tiers } } });
    }
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
        { $match: { "services.0": { $exists: true } } },
      );
    }
    //Session
    if (sessionTypes?.length) {
      pipe.push(
        {
          $lookup: {
            from: "doctorshifts",
            localField: "_id",
            foreignField: "doctor",
            as: "shifts",
          },
        },
        { $match: { "shifts.sessionTypes": { $in: sessionTypes } } },
      );
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
        const endDate = new Date(dateEnd);
        endDate.setHours(0, 0, 0, 0);
        availabilityPipe.push({ $match: { date: { $lte: endDate } } });
      }
      if (dateStart) {
        const startDate = new Date(dateStart);
        startDate.setHours(0, 0, 0, 0);
        availabilityPipe.push({ $match: { date: { $gte: startDate } } });
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
    if (query) {
      pipe.push({
        $match: {
          $or: [
            { firstName: { $regex: escapeRegex(query), $options: "i" } },
            { lastName: { $regex: escapeRegex(query), $options: "i" } },
          ],
        },
      });
    }
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setDate(now.getDate() + 2);
    //Population
    const rowPipe: PipelineStage.FacetPipelineStage[] = [
      {
        $lookup: {
          from: "DoctorFeedBack",
          localField: "_id",
          foreignField: "doctor",
          as: "feedbacks",
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
      { $sort: { ...bookingSortToColId[sort], order: 1, _id: 1 } },
      { $skip: (page - 1) * FILTER_BOOKING_PAGE_SIZE },
      { $limit: FILTER_BOOKING_PAGE_SIZE },
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
          pipeline: [{ $match: { date: { $lte: end, $gte: now } } }],
        },
      },
    ];
    pipe.push({ $facet: { rows: rowPipe, count: [{ $count: "total" }] } });
    //Execute
    const result = await DoctorProfile.aggregate(pipe);
    // console.log(result);
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
    district: asArray(z.string()).optional(),
    city: z.string().optional(),
    province: z.string().optional(),
    category: z.string().optional(),
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
    if (!success) return next(new BadInputError(error.message));
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
    } = data;

    const pipe: PipelineStage[] = [{ $match: { active: true } }];
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
    if (geo?.length) {
      pipe.push({
        $match: {
          $or: geo.map((g) => ({ location: { $geoWithin: { $geometry: g } } })),
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
      productPipe.push(
        {
          $lookup: {
            from: "products",
            localField: "product",
            foreignField: "_id",
            as: "product",
          },
        },
        {
          $unwind: {
            preserveNullAndEmptyArrays: true,
            path: "$product",
          },
        },
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

    pipe.push({
      $facet: {
        rows: [
          { $sort: { _id: 1 } },
          { $skip: (page - 1) * FILTER_BOOKING_PAGE_SIZE },
          { $limit: FILTER_BOOKING_PAGE_SIZE },
        ],
        count: [{ $count: "total" }],
      },
    });
    const result = await Pharmacy.aggregate(pipe);
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
    if (!success) return next(new BadInputError(error.message));
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
    } = input;

    const pipe: PipelineStage[] = [{ $match: { active: true } }];
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
    if (geo?.length) {
      pipe.push({
        $match: {
          $or: geo.map((g) => ({ location: { $geoWithin: { $geometry: g } } })),
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
    pipe.push({
      $facet: {
        rows: [
          { $sort: { ...orgBookingSortToColId[sort], _id: 1 } },
          { $skip: (page - 1) * FILTER_BOOKING_PAGE_SIZE },
          { $limit: FILTER_BOOKING_PAGE_SIZE },
        ],
        count: [{ $count: "total" }],
      },
    });
    const result = await Clinic.aggregate(pipe);
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
      return next(new BadInputError(error.message));
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
    if (!success) return next(new BadInputError(error.message));
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

const getProvincesSchema = z.strictObject({ query: z.string().min(2).trim() });
export const getProvinces: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      data: input,
      success,
      error,
    } = await getProvincesSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError(error.message));
    const data = await Province.find({
      name: { $regex: escapeRegex(input.query), $options: "i" },
      isActive: true,
    });
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
    if (!success) return next(new BadInputError(error.message));
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
    if (!success) return next(new BadInputError(error.message));
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
    const { data, success } = await searchNodeSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await ProductCategory.find({
      name: { $regex: escapeRegex(data.query), $options: "i" },
    })
      .sort({ order: 1, _id: 1 })
      .limit(SEARCH_LIMIT);
    res.status(200).json({ message: "getProductCategories", data: nodes });
  },
);

export const getClinicCategories: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await searchNodeSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await ClinicCategory.find({
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
    const { data, success } = await searchNodeSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await InsuranceCategory.find({
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
    const { data, success } = await searchNodeSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await HospitalCategory.find({
      name: { $regex: escapeRegex(data.query), $options: "i" },
    })
      .sort({ order: 1, _id: 1 })
      .limit(SEARCH_LIMIT);
    res.status(200).json({ message: "getHospitalCategories", data: nodes });
  },
);

export const getParaClinicCategories: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await searchNodeSchema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError());
    const nodes = await ParaClinicCategory.find({
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
    if (!success) return next(new BadInputError(error.message));
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
    res.status(200).json({
      message: "getAbout",
      data: { whys, partners, team, staticImages },
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
    if (!success) return next(new BadInputError(error.message));
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
    if (!success) return next(new BadInputError(error.message));
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
    if (!success) return next(new BadInputError(error.message));
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
  "doctor",
  "dr",
  "clinic",
  "hospital",
  "paraClinic",
  "insurance",
  "service",
  "servicePackage",
  "product",
  "productPackage",
  "blog",
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
  drug: { model: Drug, filter: {} },
  disease: { model: Disease, filter: {} },
  symptom: { model: Symptom, filter: {} },
  speciality: { model: Speciality, filter: { active: true } },
  doctor: { model: Doctor, filter: { active: true } },
  dr: { model: DoctorProfile, filter: { active: true } },
  clinic: { model: Clinic, filter: { active: true } },
  hospital: { model: Hospital, filter: { active: true } },
  paraClinic: { model: ParaClinic, filter: { active: true } },
  insurance: { model: Insurance, filter: { active: true } },
  service: { model: Service, filter: { isActive: true } },
  servicePackage: { model: ServicePackage, filter: { isActive: true } },
  product: { model: Product, filter: { isActive: true } },
  productPackage: { model: ProductPackage, filter: { isActive: true } },
  blog: { model: Blog, filter: { published: true } },
};

// returns { slug, lastmod } for every publicly-visible document of one node
// type, for the frontend to turn into a <urlset>. No pagination: sitemaps
// need every URL, and this only selects two small fields.
export const getSitemapNodes: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { type } = req.params;
    if (!isSitemapNodeType(type)) return next(new BadInputError());
    const { model, filter } = sitemapNodeConfig[type];
    const items = await model
      .find({ ...filter, slug: { $exists: true, $nin: [null, ""] } })
      .select({ slug: 1 })
      .sort({ _id: 1 })
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
