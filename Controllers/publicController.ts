import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import Blog, { IBlog } from "../Models/Blog";
import { pageLimit } from "../Lib/enums";
import BlogCategory, { IBlogCategory } from "../Models/BlogCategory";
import { isPositiveInt } from "../Lib/validators";
import { NotFoundError } from "../Lib/AppError";
import { isValidObjectId } from "mongoose";

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
      select: ["_id", "title", "order", "image", "summary"],
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
      .select(["_id", "title", "order", "image", "summary"]);
    res.status(200).json({ message: "getBlog", data: { blog, thisWeek } });
  }
);
