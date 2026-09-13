import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import Comment, {
  CommentableDocumentPath,
  commentableDocumentPaths,
} from "../Models/Comment";
import { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
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

const getCommentsSchema = z.strictObject({
  page: z.coerce.number().int().min(1).optional().default(1),
  star: z.enum(commentFilters).optional(),
});
export const getComments: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { name: _name, nodeId } = req.params;
    const {
      data: input,
      error,
      success,
    } = await getCommentsSchema.spa(req.query);
    if (!success) return next(new BadInputError(error.message));
    const { page, star } = input;
    const name = commentableDocumentPaths.find((p) => p === _name);
    if (!name || !isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await pathToNode[name].findById(nodeId);
    if (!node) return next(new BadInputError());
    const pipe: PipelineStage[] = [
      { $match: { resource: node._id, status: "Approved" } },
      {
        $facet: {
          data: [
            ...(star
              ? [
                  {
                    $match: {
                      score: isNaN(Number(star)) ? { $lte: 2 } : Number(star),
                    },
                  },
                ]
              : []),
            { $skip: (page - 1) * COMMENT_PAGE_SIZE },
            { $limit: COMMENT_PAGE_SIZE },
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
          filteredCount: [
            ...(star
              ? [
                  {
                    $match: {
                      score: isNaN(Number(star)) ? { $lte: 2 } : Number(star),
                    },
                  },
                ]
              : []),
            { $count: "count" },
          ],
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
    for (const { _id, count } of data[0]?.scores) {
      scores[_id] = count;
    }
    res.status(200).json({
      message: "getComments",
      data: {
        data: data[0]?.data,
        average: data[0]?.avg?.[0]?.averageScore || 0,
        count,
        scores,
        pagesCount: Math.ceil(filteredCount / COMMENT_PAGE_SIZE) || 1,
      },
    });
  },
);

const submitACommentSchema = z.strictObject({
  content: z.string(),
  score: z.coerce.number().min(1).max(5).int(),
});

export const submitAComment: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { name: _name, nodeId } = req.params;
    const name = commentableDocumentPaths.find((p) => p === _name);
    if (!name || !isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success, error } = await submitACommentSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError(error.message));
    const node = await pathToNode[name].findById(nodeId);
    if (!node) return next(new NotFoundError());
    await Comment.create({
      author: req.user._id,
      resource: node._id,
      refPath: name,
      content: data.content,
      score: data.score,
    });
    res.status(200).json({ message: "submitAComment" });
  },
);

export const toggleVote: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    console.log("Hit");

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
