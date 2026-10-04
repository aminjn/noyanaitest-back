import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import Comment, {
  CommentableDocumentPath,
  commentableDocumentPaths,
  reviewBasisOf,
} from "../Models/Comment";
import AppError, {
  BadInputError,
  MiddlewareError,
  NotFoundError,
} from "../Lib/AppError";
import { findReviewBasis } from "../Lib/reviewVerification";
import mongoose, { isValidObjectId, Model, PipelineStage } from "mongoose";

import * as z from "zod";
import Blog from "../Models/Blog";
import Disease from "../Models/Disease";
import Drug from "../Models/Drug";
import Symptom from "../Models/Symptom";
import Product from "../Models/Product";
import Clinic from "../Models/Clinic";
import ProductPackage from "../Models/ProductPackage";
import ServicePackage from "../Models/ServicePackage";
import Service from "../Models/Service";
import ParaClinic from "../Models/Paraclinic";
import Hospital from "../Models/Hospital";
import Insurance from "../Models/Insurance";
import DoctorProfile from "../Models/DoctorProfile";

const pathToNode: Record<CommentableDocumentPath, Model<any>> = {
  Blog,
  Comment,
  Disease,
  Drug,
  Symptom,
  Product,
  Clinic,
  ProductPackage,
  Service,
  ServicePackage,
  ParaClinic,
  Hospital,
  Insurance,
  DoctorProfile,
};

const COMMENT_PAGE_SIZE = 4;

const commentFilters = ["5", "4", "3", "low"] as const;

// fields that never leave the server in a public list
const publicCommentProjection = {
  moderatedBy: 0,
  rejectReason: 0,
  verifiedBy: 0,
  verifiedOrder: 0,
  "reply.by": 0,
  averageScore: 0,
  commentCount: 0,
};

const getCommentsSchema = z.strictObject({
  page: z.coerce.number().int().min(1).optional().default(1),
  star: z.enum(commentFilters).optional(),
});
// Rated paths (centres, items) list and score only verified reviews; open
// Q&A paths (blog, disease, drug...) list every approved comment, no stars.
export const getComments: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { name: _name, nodeId } = req.params;
    const {
      data: input,
      error,
      success,
    } = await getCommentsSchema.spa(req.query);
    if (!success) return next(new BadInputError(error.message));
    const { page } = input;
    const name = commentableDocumentPaths.find((p) => p === _name);
    if (!name || !isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await pathToNode[name].findById(nodeId);
    if (!node) return next(new BadInputError());
    const basis = reviewBasisOf(name);
    const rated = !!basis;
    const star = rated ? input.star : undefined;
    const starMatch: PipelineStage.FacetPipelineStage[] = star
      ? [
          {
            $match: {
              score: isNaN(Number(star)) ? { $lte: 2 } : Number(star),
            },
          },
        ]
      : [];
    const pipe: PipelineStage[] = [
      {
        $match: {
          resource: node._id,
          status: "Approved",
          ...(rated ? { verified: true } : {}),
        },
      },
      {
        $facet: {
          data: [
            ...starMatch,
            { $sort: { createdAt: -1 } },
            { $skip: (page - 1) * COMMENT_PAGE_SIZE },
            { $limit: COMMENT_PAGE_SIZE },
            { $project: publicCommentProjection },
            {
              $lookup: {
                from: "users",
                localField: "author",
                foreignField: "_id",
                as: "author",
                pipeline: [{ $project: { username: 1, avatar: 1 } }],
              },
            },
            { $unwind: { path: "$author", preserveNullAndEmptyArrays: true } },
          ],
          filteredCount: [...starMatch, { $count: "count" }],
          count: [{ $count: "count" }],
          avg: [{ $group: { _id: null, averageScore: { $avg: "$score" } } }],
          scores: [{ $group: { _id: "$score", count: { $sum: 1 } } }],
        },
      },
    ];
    const data = await Comment.aggregate(pipe);
    const count = data[0]?.count?.[0]?.count || 0;
    const filteredCount = data[0]?.filteredCount?.[0]?.count || 0;
    const scores: any = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    if (rated)
      for (const { _id, count } of data[0]?.scores || []) {
        if (_id >= 1 && _id <= 5) scores[_id] = count;
      }
    const rows = Array.isArray(data[0]?.data) ? data[0].data : [];
    res.status(200).json({
      message: "getComments",
      data: {
        data: rated ? rows : rows.map(({ score, ...rest }: any) => rest),
        average: rated ? data[0]?.avg?.[0]?.averageScore || 0 : 0,
        count,
        scores,
        pagesCount: Math.ceil(filteredCount / COMMENT_PAGE_SIZE) || 1,
        // what the form needs: does this page take star ratings, and what
        // proves a reviewer ("visit" | "purchase"; null = open Q&A)
        rated,
        basis,
      },
    });
  },
);

// GET /comment/:name/:nodeId/eligibility - can the signed-in user leave a
// (verified) review here, and if not, why (the form explains and links to
// booking / buying instead of failing on submit).
export const getCommentEligibility: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { name: _name, nodeId } = req.params;
    const name = commentableDocumentPaths.find((p) => p === _name);
    if (!name || !isValidObjectId(nodeId)) return next(new BadInputError());
    const resource = new mongoose.Types.ObjectId(nodeId);
    const basis = reviewBasisOf(name);
    if (name === "DoctorProfile")
      return res.status(200).json({
        message: "getCommentEligibility",
        data: { rated: true, basis: "visit", eligible: false, reason: "doctorVisit" },
      });
    if (!basis)
      return res.status(200).json({
        message: "getCommentEligibility",
        data: { rated: false, basis: null, eligible: true, reason: null },
      });
    const found = await findReviewBasis(req.user._id, name, resource);
    let reason: string | null = null;
    if (!found)
      reason = (await Comment.exists({ author: req.user._id, resource, verified: true }))
        ? "alreadyReviewed"
        : basis === "visit"
          ? "noVisit"
          : "noPurchase";
    res.status(200).json({
      message: "getCommentEligibility",
      data: {
        rated: true,
        basis,
        eligible: !!found,
        reason,
        // the month the badge will show
        at: found?.at ?? null,
      },
    });
  },
);

const submitACommentSchema = z.strictObject({
  content: z.string().trim().min(1).max(2000),
  score: z.coerce.number().min(1).max(5).int().optional(),
});

export const submitAComment: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { name: _name, nodeId } = req.params;
    const name = commentableDocumentPaths.find((p) => p === _name);
    if (!name || !isValidObjectId(nodeId)) return next(new BadInputError());
    // a doctor's rating comes only from verified post-visit reviews
    // (DoctorFeedback): a generic comment would recompute the same
    // averageScore from open comments and wipe the verified one
    if (name === "DoctorProfile")
      return next(new BadInputError("نظر درباره‌ی پزشک فقط پس از ویزیت و از صفحه‌ی نوبت ثبت می‌شود"));
    const { data, success, error } = await submitACommentSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError(error.message));
    const node = await pathToNode[name].findById(nodeId);
    if (!node) return next(new NotFoundError());
    const basisKind = reviewBasisOf(name);
    // open Q&A: text only, no stars
    if (!basisKind) {
      await Comment.create({
        author: req.user._id,
        resource: node._id,
        refPath: name,
        content: data.content,
      });
      return res.status(200).json({ message: "submitAComment" });
    }
    // verified review: one per completed visit / delivered order line
    if (!data.score) return next(new BadInputError("امتیاز را انتخاب کنید"));
    const basis = await findReviewBasis(req.user._id, name, node._id);
    if (!basis)
      return next(
        new AppError(
          (await Comment.exists({ author: req.user._id, resource: node._id, verified: true }))
            ? "شما برای این مورد نظر ثبت کرده‌اید؛ هر ویزیت یا خرید یک نظر دارد"
            : basisKind === "visit"
              ? "فقط بیمارانی که در این مرکز ویزیت شده‌اند می‌توانند نظر و امتیاز ثبت کنند"
              : "فقط خریدارانی که سفارششان تحویل شده می‌توانند نظر و امتیاز ثبت کنند",
          400,
        ),
      );
    try {
      await Comment.create({
        author: req.user._id,
        resource: node._id,
        refPath: name,
        content: data.content,
        score: data.score,
        verified: true,
        verifiedKind: basis.kind,
        verifiedBy: basis.ref,
        verifiedOrder: basis.order,
        verifiedAt: basis.at,
      });
    } catch (err: any) {
      if (err?.code === 11000)
        return next(
          new AppError("شما برای این مورد نظر ثبت کرده‌اید؛ هر ویزیت یا خرید یک نظر دارد", 400),
        );
      throw err;
    }
    res.status(200).json({ message: "submitAComment" });
  },
);

export const toggleVote: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const result = await Comment.updateOne(
      { _id: nodeId, status: "Approved" },
      [
        {
          $set: {
            upvotes: {
              $cond: [
                {
                  $in: [req.user._id, "$upvotes"],
                },
                {
                  $filter: {
                    input: "$upvotes",
                    as: "id",
                    cond: {
                      $ne: ["$$id", req.user._id],
                    },
                  },
                },
                {
                  $concatArrays: ["$upvotes", [req.user._id]],
                },
              ],
            },
          },
        },
      ],
    );
    if (result.matchedCount === 0) return next(new NotFoundError());
    res.status(200).json({ message: "toggleVote" });
  },
);
