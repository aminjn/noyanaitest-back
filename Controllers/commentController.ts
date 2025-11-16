import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import Comment, {
  CommentableDocumentPath,
  commentableDocumentPaths,
} from "../Models/Comment";
import { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import { isValidObjectId, Model } from "mongoose";

import * as z from "zod";
import Blog from "../Models/Blog";
import Disease from "../Models/Disease";
import Drug from "../Models/Drug";
import Symptom from "../Models/Symptom";

const pathToNode: Record<CommentableDocumentPath, Model<any>> = {
  Blog: Blog,
  Comment: Comment,
  Disease: Disease,
  Drug: Drug,
  Symptom: Symptom,
};

export const getComments: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { name: _name, nodeId } = req.params;
    const name = commentableDocumentPaths.find((p) => p === _name);
    if (!name || !isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await pathToNode[name].findById(nodeId);
    if (!node) return next(new BadInputError());
    const data = await Comment.find({ resource: node._id, status: "Approved" });
    res.status(200).json({ message: "getComments", data });
  }
);

const submitACommentSchema = z.strictObject({
  title: z.string(),
  description: z.string(),
  score: z.number().min(1).max(5).int(),
});

export const submitAComment: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { name: _name, nodeId } = req.params;
    const name = commentableDocumentPaths.find((p) => p === _name);
    if (!name || !isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await submitACommentSchema.safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    const node = await pathToNode[name].findById(nodeId);
    if (!node) return next(new NotFoundError());
    await Comment.create({
      author: req.user._id,
      resource: node._id,
      refPath: name,
      title: data.title,
      description: data.description,
      score: data.score,
    });
    res.status(200).json({ message: "submitAComment" });
  }
);
