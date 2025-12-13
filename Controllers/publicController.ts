import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import Blog, { IBlog } from "../Models/Blog";
import { pageLimit } from "../Lib/enums";
import BlogCategory, { IBlogCategory } from "../Models/BlogCategory";
import { isPositiveInt } from "../Lib/validators";
import { BadInputError, NotFoundError } from "../Lib/AppError";
import mongoose, { isValidObjectId } from "mongoose";
import TextContent from "../Models/TextContent";
import Speciality, { ISpeciality } from "../Models/Speciality";
import DoctorProfile from "../Models/DoctorProfile";
import DoctorSession, {
  doctorSessionTypes,
  patientStatuses,
} from "../Models/DoctorSession";
import { getSessionDateKey, isLat, isLng, isPoint } from "../Lib/helpers";
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

export const getSite: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const textContent = await TextContent.findOneAndUpdate(
      {},
      {},
      { upsert: true, new: true }
    );
    res.status(200).json({ message: "getSite", data: { textContent } });
  }
);

export const getBlogs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { category: _category, page: _page, sort: _sort } = req.query;
    let page: number = 1;
    if (_page) {
      if (!isPositiveInt(_page)) return next(new NotFoundError());
      page = Number(page);
    }
    const sorts = ["order", "date"] as const;
    const sort = sorts.find((el) => el === _sort) || "order";
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
    const blogs = await Blog.find(query)
      .sort({
        ...(sort === "order"
          ? {
              order: -1,
            }
          : {
              publishedAt: -1,
            }),
        _id: -1,
      })
      .limit(pageLimit)
      .skip((page - 1) * pageLimit)
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
    res
      .status(200)
      .json({ message: "getBlogs", data: { blogs, categories, blogsCount } });
  }
);

export const getBlog: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    let blog: IBlog | null | undefined;
    const population = {
      path: "related",
      options: { sort: { order: -1, _id: -1 } },
      select: ["_id", "title", "order", "image", "summary", "slug"],
      match: { published: true },
    };
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
  }
);

export const getSpecialityOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await Speciality.find({ active: true }).sort({
      order: -1,
      _id: -1,
    });
    res.status(200).json({ message: "getSpecialityOptions", data: { data } });
  }
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
  }
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
  }
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
  }
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
  }
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
  }
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
  }
);

const boundsSchema = z.strictObject({
  bounds: z
    .tuple([isPoint, isPoint])
    .refine(
      ([[minLng, minLat], [maxLng, maxLat]]) =>
        minLng < maxLng && minLat < maxLat
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
  }
);

export const getShortLink: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { token } = req.params;
    const data = await ShortLink.findOne({ token });
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getShortLink", data });
  }
);

export const getRedirect: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { path } = req.query;
    if (typeof path !== "string") return next(new BadInputError());
    const data = await Redirection.findOne({ old: path });
    res.status(200).json({ message: "getRedirect", data });
  }
);

const DOCTORS_PER_PAGE = 25;
export const getDoctors: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { page: _page } = req.query;
    const page = Number(_page);
    if (isNaN(page) || !Number.isInteger(page) || page < 1)
      return next(new BadInputError());
    const profiles = await DoctorProfile.find({ active: true })
      .sort({
        order: 1,
        _id: 1,
      })
      .limit(DOCTORS_PER_PAGE)
      .skip((page - 1) * DOCTORS_PER_PAGE)
      .populate({ path: "mainSpeciality" });
    const profilesCount = await DoctorProfile.countDocuments({
      active: true,
    });
    let data: IDoctor[] | undefined;
    if (profiles.length !== DOCTORS_PER_PAGE) {
      const onlyWithProfilePagesCount = Math.floor(
        profilesCount / DOCTORS_PER_PAGE
      );
      const doctorPage = page - onlyWithProfilePagesCount;
      data = await Doctor.find({ active: true })
        .sort({ order: 1, _id: 1 })
        .limit(DOCTORS_PER_PAGE - profiles.length)
        .skip((doctorPage - 1) * DOCTORS_PER_PAGE)
        .populate({ path: "speciality", select: { name: 1, slug: 1 } })
        .select({ name: 1, image: 1, slug: 1 });
      if (!data.length && !profiles.length) return next(new NotFoundError());
    }
    const doctorCount = await Doctor.countDocuments({ active: true });
    res.status(200).json({
      message: "getDoctors",
      data: {
        data: data || [],
        profiles,
        pagesCount: Math.ceil((doctorCount + profilesCount) / DOCTORS_PER_PAGE),
      },
    });
  }
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
  }
);

const SPECIALITIES_PER_PAGE = 25;
export const getSpecialities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { page: _page } = req.query;
    const page = Number(_page);
    if (isNaN(Number(page)) || !Number.isInteger(page) || page < 1)
      return next(new BadInputError());
    const data = await Speciality.find({ active: true })
      .sort({
        order: 1,
        _id: 1,
      })
      .limit(SPECIALITIES_PER_PAGE)
      .skip(SPECIALITIES_PER_PAGE * (page - 1))
      .populate([
        { path: "doctorsCountWithMainSpeciality" },
        { path: "doctorsCountWithSideSpeciality" },
      ]);
    if (!data.length) return next(new NotFoundError());
    const count = await Speciality.countDocuments({ active: true });
    res.status(200).json({
      message: "getSpecialities",
      data: { data, pagesCount: Math.ceil(count / SPECIALITIES_PER_PAGE) },
    });
  }
);

const SPECIALITY_DOCTORS_PER_PAGE = 25;
export const getSpeciality: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { page: _page } = req.query;
    const page = Number(_page);
    if (isNaN(page) || !Number.isInteger(page) || page < 1)
      return next(new BadInputError());
    const { slug } = req.params;
    if (!slug) return next(new NotFoundError());
    let data: undefined | null | ISpeciality;
    data = await Speciality.findOne({ slug });
    if (!data) data = await Speciality.findOne({ name: slug });
    if (!data) return next(new NotFoundError());
    const doctors = await DoctorProfile.find({
      active: true,
      $or: [{ mainSpeciality: data._id }, { specialities: data._id }],
    })
      .limit(SPECIALITY_DOCTORS_PER_PAGE)
      .skip((page - 1) * SPECIALITY_DOCTORS_PER_PAGE)
      .populate({ path: "mainSpeciality" })
      .sort({ order: 1, _id: 1 });
    const count = await DoctorProfile.countDocuments({
      active: true,
      $or: [{ mainSpeciality: data._id }, { specialities: data._id }],
    });
    res.status(200).json({
      message: "getSpeciality",
      data: {
        data,
        doctors,
        pagesCount: Math.ceil(count / SPECIALITY_DOCTORS_PER_PAGE),
      },
    });
  }
);

const SYMPTOMS_PER_PAGE = 25;
export const getSymptoms: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { page: _page } = req.query;
    const page = Number(_page);
    if (isNaN(page) || !Number.isInteger(page) || page < 1)
      return next(new BadInputError());
    const data = await Symptom.find()
      .sort({ order: 1, _id: 1 })
      .skip(SYMPTOMS_PER_PAGE * (page - 1))
      .limit(SYMPTOMS_PER_PAGE)
      .select({ image: 1, name: 1, summary: 1 });
    if (!data.length) return next(new NotFoundError());
    const count = await Symptom.countDocuments();
    res.status(200).json({
      message: "getSymptoms",
      data: { data, pagesCount: Math.ceil(count / SYMPTOMS_PER_PAGE) },
    });
  }
);

export const getSymptom: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    let data = await Symptom.findOne({ slug });
    if (!data) data = await Symptom.findOne({ name: slug });
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getSymptom", data });
  }
);

const DISEASES_PER_PAGE = 25;
export const getDiseases: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { page: _page } = req.query;
    const page = Number(_page);
    if (isNaN(page) || !Number.isInteger(page) || page < 1)
      return next(new BadInputError());
    const data = await Disease.find()
      .limit(DISEASES_PER_PAGE)
      .skip((page - 1) * DISEASES_PER_PAGE)
      .sort({ order: 1, _id: 1 });
    if (!data.length) return next(new NotFoundError());
    const count = await Disease.countDocuments();
    res.status(200).json({
      message: "getDiseases",
      data: { data, pagesCount: Math.ceil(count / DISEASES_PER_PAGE) },
    });
  }
);

export const getDisease: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    const options = [
      { path: "symptoms" },
      { path: "specialities" },
      { path: "drugs" },
    ];
    let data = await Disease.findOne({ slug }).populate(options);
    if (!data) data = await Disease.findOne({ name: slug }).populate(options);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getDisease", data });
  }
);

const DRUGS_PER_PAGE = 25;
export const getDrugs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { page: _page } = req.query;
    const page = Number(_page);
    if (isNaN(page) || !Number.isInteger(page) || page < 1)
      return next(new BadInputError());
    const data = await Drug.find()
      .limit(DRUGS_PER_PAGE)
      .skip((page - 1) * DRUGS_PER_PAGE)
      .sort({ order: 1, _id: 1 });
    if (!data.length) return next(new NotFoundError());
    const count = await Drug.countDocuments();
    res.status(200).json({
      message: "getDrugs",
      data: { data, pagesCount: Math.ceil(count / DRUGS_PER_PAGE) },
    });
  }
);

export const getDrug: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { slug } = req.params;
    let data = await Drug.findOne({ slug });
    if (!data) data = await Drug.findOne({ name: slug });
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getDrug", data });
  }
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
  }
);

export const getInsurance: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Insurance.findById(nodeId);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getInsurance", data });
  }
);

export const getOffice: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Office.findById(nodeId);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getOffice", data });
  }
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
  }
);
