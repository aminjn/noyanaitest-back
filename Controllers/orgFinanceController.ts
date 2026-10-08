import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import { buildOrgFinance, financePage, OrgFinanceKind } from "../Lib/orgFinance";
import Comment, { CommentableDocumentPath, isRatedPath } from "../Models/Comment";

// GET /<org>/finance for the lab, clinic, hospital and insurer panels
// (2026-10); see Lib/orgFinance.ts.
export const getMyOrgFinance = (kind: OrgFinanceKind): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const org = req[kind] as { _id: unknown; user?: unknown } | undefined;
    if (!org) return next(new MiddlewareError());
    const data = await buildOrgFinance(req, kind, org, financePage(req));
    res.status(200).json({ message: "getMyOrgFinance", data });
  });

// GET /<org>/review (2026-10): the published reviews of a clinic,
// hospital, lab or insurer and its average score (moderation stays with
// the super admin), so a centre sees what patients say. Rated centres
// show their verified reviews (the ones behind the public score);
// insurers' comments are open Q&A without stars.
const reviewPath: Record<"clinic" | "hospital" | "paraClinic" | "pharmacy" | "insurance", CommentableDocumentPath> = {
  clinic: "Clinic",
  hospital: "Hospital",
  paraClinic: "ParaClinic",
  // a pharmacy is rated by the buyers of its delivered orders (2026-10)
  pharmacy: "Pharmacy",
  insurance: "Insurance",
};

export const getMyOrgReviews = (kind: keyof typeof reviewPath): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const org = req[kind] as { _id: unknown } | undefined;
    if (!org) return next(new MiddlewareError());
    const rated = isRatedPath(reviewPath[kind]);
    const match = {
      resource: org._id,
      refPath: reviewPath[kind],
      status: "Approved",
      ...(rated ? { verified: true } : {}),
    };
    const [items, stats] = await Promise.all([
      Comment.find(match)
        .sort({ createdAt: -1 })
        .limit(200)
        .select("content score tags createdAt author verified verifiedKind verifiedAt reply.content reply.at")
        .populate({
          path: "author",
          select: "username identity",
          populate: { path: "identity", select: "givenName lastName" },
        })
        .lean(),
      Comment.aggregate([
        { $match: match },
        { $group: { _id: null, count: { $sum: 1 }, average: { $avg: "$score" } } },
      ]),
    ]);
    res.status(200).json({
      message: "getMyOrgReviews",
      data: {
        items: rated ? items : items.map(({ score, ...rest }) => rest),
        count: stats[0]?.count || 0,
        average: rated && stats[0]?.average ? Math.round(stats[0].average * 10) / 10 : 0,
        rated,
        // only the owner account answers publicly (secretaries read)
        canReply: req.aclGrant === "FULL",
      },
    });
  });

const replySchema = z.strictObject({
  content: z.string().trim().min(1).max(1000),
});

// POST /<org>/review/:nodeId/reply (2026-10): the centre answers a
// published review publicly, once (Doctolib / Google-style owner reply).
export const replyToMyOrgReview = (kind: keyof typeof reviewPath): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const org = req[kind] as { _id: unknown } | undefined;
    if (!org || !req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = replySchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError("متن پاسخ را بنویسید"));
    const filter = {
      _id: nodeId,
      resource: org._id,
      refPath: reviewPath[kind],
      status: "Approved",
    };
    const done = await Comment.findOneAndUpdate(
      { ...filter, "reply.content": { $exists: false } },
      { $set: { reply: { content: parsed.data.content, at: new Date(), by: req.user._id } } },
    );
    if (!done)
      return next(
        (await Comment.exists(filter))
          ? new AppError("به این نظر قبلاً پاسخ داده‌اید", 400)
          : new NotFoundError(),
      );
    res.status(200).json({ message: "replyToMyOrgReview" });
  });
