import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import Blog, { IBlog } from "../Models/Blog";
import { pageLimit } from "../Lib/enums";
import BlogCategory, { IBlogCategory } from "../Models/BlogCategory";
import { isPositiveInt } from "../Lib/validators";
import { BadInputError, NotFoundError } from "../Lib/AppError";
import mongoose, { isValidObjectId } from "mongoose";
import TextContent from "../Models/TextContent";
import Speciality from "../Models/Speciality";
import DoctorProfile from "../Models/DoctorProfile";
import DoctorSession from "../Models/DoctorSession";
import { getSessionDateKey, isLat, isLng, isPoint } from "../Lib/helpers";
import * as z from "zod";

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
