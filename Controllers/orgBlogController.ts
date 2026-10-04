import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import path from "path";
import fs from "fs/promises";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  MiddlewareError,
  NotFoundError,
  PathNotFoundError,
} from "../Lib/AppError";
import { nodesWithAcl, NodeWithAcl } from "./aclController";
import Blog from "../Models/Blog";
import BlogCategory from "../Models/BlogCategory";

// Lets an organization panel (doctor/clinic/pharmacy/insurance/paraClinic)
// write blog posts for the public /mag section, mirroring the admin blog
// editor closely enough to reuse the same CreateForm/Table UI. Kept generic
// (keyed off req.params.name / req[name], same style as aclController) so
// one controller + router serves all 5 org types instead of duplicating this
// per org router.
//
// Moderation: org-submitted posts are never allowed to self-publish. Every
// create/edit forces published=false; only an admin can flip that switch
// from the existing admin blog panel (/auto/blog), which is intentionally
// left untouched.

const objectIdField = z
  .string()
  .refine((val) => isValidObjectId(val), { message: "invalid id" });

// Blog.author is a free-text display string (pre-existing field, shown as
// "نویسنده" in the admin table). We denormalize the org's display name into
// it at creation time so admin doesn't need to populate/join anything to see
// who submitted a post.
const getOrgDisplayName = (name: NodeWithAcl, org: any): string | undefined => {
  if (name === "doctor") {
    return (
      [org?.firstName, org?.lastName].filter(Boolean).join(" ") || undefined
    );
  }
  return org?.name || undefined;
};

const buildBlogImageFilename = (
  name: NodeWithAcl,
  orgId: string,
  file: Express.Multer.File,
) =>
  `Blog__${name}__${orgId}__${new Date().getTime()}.${file.originalname
    .split(".")
    .findLast(() => true)}`;

export const getMyBlogs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const data = await Blog.find({
      authorType: name,
      authorOrg: req[name]._id,
    })
      .populate({ path: "category" })
      .sort({ _id: -1 });
    res.status(200).json({ message: "getMyBlogs", data });
  },
);

export const getMyBlog: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Blog.findOne({
      _id: nodeId,
      authorType: name,
      authorOrg: req[name]._id,
    }).populate({ path: "category" });
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyBlog", data });
  },
);

const mutateBlogSchema = z.strictObject({
  title: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  readTime: z.string().optional(),
  category: objectIdField.optional(),
});

export const createMyBlog: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const { data, success } = await mutateBlogSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    // a post with no title can't be reviewed or listed
    if (!data.title?.trim())
      return next(new AppError("یکی از فیلدهای الزامی خالی است", 400));
    let image: string | undefined;
    if (req.file) {
      image = buildBlogImageFilename(name, req[name]._id.toString(), req.file);
      await fs.writeFile(
        path.join(process.cwd(), "Public", image),
        req.file.buffer,
      );
    }
    await Blog.create({
      ...data,
      image,
      author: getOrgDisplayName(name, req[name]),
      authorType: name,
      authorOrg: req[name]._id,
      published: false,
      reviewStatus: "pending",
    });
    res.status(200).json({ message: "createMyBlog" });
  },
);

export const editMyBlog: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await mutateBlogSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const node = await Blog.findOne({
      _id: nodeId,
      authorType: name,
      authorOrg: req[name]._id,
    });
    if (!node) return next(new NotFoundError());
    let image: string | undefined;
    if (req.file) {
      image = buildBlogImageFilename(name, req[name]._id.toString(), req.file);
      await fs.writeFile(
        path.join(process.cwd(), "Public", image),
        req.file.buffer,
      );
    }
    // Any edit takes the post back out of the public feed until an admin
    // reviews it again, so a post can't be quietly changed after approval.
    if (data.title !== undefined && !data.title.trim())
      return next(new AppError("یکی از فیلدهای الزامی خالی است", 400));
    // ...and goes back into the admin's review queue (a rejected post
    // that was fixed is reviewed again)
    await Blog.findByIdAndUpdate(node._id, {
      $set: {
        ...data,
        ...(image ? { image } : {}),
        published: false,
        reviewStatus: "pending",
      },
      $unset: { rejectReason: 1 },
    });
    res.status(200).json({ message: "editMyBlog" });
  },
);

export const deleteMyBlog: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await Blog.findOne({
      _id: nodeId,
      authorType: name,
      authorOrg: req[name]._id,
    });
    if (!node) return next(new NotFoundError());
    await Blog.findByIdAndDelete(node._id);
    res.status(200).json({ message: "deleteMyBlog" });
  },
);

// Read-only, shared across all org types: lets the panel populate a category
// picker without needing access to the admin-only /auto/blogcategory route.
export const getBlogCategories: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await BlogCategory.find().sort({ order: 1 });
    res.status(200).json({ message: "getBlogCategories", data: { data } });
  },
);
