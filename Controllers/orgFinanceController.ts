import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { MiddlewareError } from "../Lib/AppError";
import { buildOrgFinance, financePage, OrgFinanceKind } from "../Lib/orgFinance";
import Comment from "../Models/Comment";

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
// hospital, lab or insurer and its average score, read-only (moderation
// stays with the super admin), so a centre sees what patients say.
const reviewPath: Record<"clinic" | "hospital" | "paraClinic" | "insurance", string> = {
  clinic: "Clinic",
  hospital: "Hospital",
  paraClinic: "ParaClinic",
  insurance: "Insurance",
};

export const getMyOrgReviews = (kind: keyof typeof reviewPath): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const org = req[kind] as { _id: unknown } | undefined;
    if (!org) return next(new MiddlewareError());
    const match = { resource: org._id, refPath: reviewPath[kind], status: "Approved" };
    const [items, stats] = await Promise.all([
      Comment.find(match)
        .sort({ createdAt: -1 })
        .limit(200)
        .select("content score createdAt author")
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
        items,
        count: stats[0]?.count || 0,
        average: stats[0]?.average ? Math.round(stats[0].average * 10) / 10 : 0,
      },
    });
  });
