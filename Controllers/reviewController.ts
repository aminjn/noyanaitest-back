import { NextFunction, Request, RequestHandler, Response } from "express";
import mongoose, { isValidObjectId, Model } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  MiddlewareError,
  NotFoundError,
} from "../Lib/AppError";
import DoctorFeedBack, {
  publicDoctorFeedbackMatch,
} from "../Models/DoctorFeedback";
import Comment from "../Models/Comment";
import UserIdentity from "../Models/UserIdentity";

// Verified reviews, the provider side (2026-10): a doctor reads the
// reviews behind their public score and answers each one publicly, once
// (Doctolib / Docplanner / Google owner reply). Centres use
// orgFinanceController.getMyOrgReviews / replyToMyOrgReview.

const REVIEWS_LIMIT = 200;

// GET /doctor/review
export const getMyDoctorReviews: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const doctor = req.doctor as { _id: mongoose.Types.ObjectId } | undefined;
    if (!doctor) return next(new MiddlewareError());
    const match = publicDoctorFeedbackMatch(doctor._id);
    const [rows, stats] = await Promise.all([
      DoctorFeedBack.find(match)
        .sort({ submittedAt: -1 })
        .limit(REVIEWS_LIMIT)
        .select({
          overalScore: 1,
          suggest: 1,
          publicMessage: 1,
          submittedAt: 1,
          user: 1,
          reservation: 1,
          "reply.content": 1,
          "reply.at": 1,
        })
        .populate({ path: "reservation", select: "date" })
        .lean(),
      DoctorFeedBack.aggregate([
        { $match: match },
        { $group: { _id: null, count: { $sum: 1 }, average: { $avg: "$overalScore" } } },
      ]),
    ]);
    const identities = await UserIdentity.find({
      user: { $in: rows.map((el) => el.user) },
    }).select({ user: 1, givenName: 1, lastName: 1 });
    const items = rows.map((el) => {
      const who = identities.find((i) => i.user?.toString() === el.user?.toString());
      return {
        _id: el._id,
        score: el.overalScore,
        suggest: !!el.suggest,
        content: el.publicMessage || "",
        createdAt: el.submittedAt,
        // first name + last initial, as on the public page
        author: {
          identity: who
            ? { givenName: who.givenName || "", lastName: who.lastName || "" }
            : undefined,
        },
        verified: true,
        verifiedKind: "visit",
        verifiedAt: (el.reservation as any)?.date ?? null,
        reply: el.reply?.content ? { content: el.reply.content, at: el.reply.at } : null,
      };
    });
    res.status(200).json({
      message: "getMyDoctorReviews",
      data: {
        items,
        count: stats[0]?.count || 0,
        average: stats[0]?.average ? Math.round(stats[0].average * 10) / 10 : 0,
        rated: true,
        canReply: req.aclGrant === "FULL",
      },
    });
  },
);

const replySchema = z.strictObject({
  content: z.string().trim().min(1).max(1000),
});

// POST /doctor/review/:nodeId/reply - once per review
export const replyToMyDoctorReview: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const doctor = req.doctor as { _id: mongoose.Types.ObjectId } | undefined;
    if (!doctor || !req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = replySchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError("متن پاسخ را بنویسید"));
    const filter = { _id: nodeId, ...publicDoctorFeedbackMatch(doctor._id) };
    const done = await DoctorFeedBack.findOneAndUpdate(
      { ...filter, "reply.content": { $exists: false } },
      { $set: { reply: { content: parsed.data.content, at: new Date(), by: req.user._id } } },
    );
    if (!done)
      return next(
        (await DoctorFeedBack.exists(filter))
          ? new AppError("به این نظر قبلاً پاسخ داده‌اید", 400)
          : new NotFoundError(),
      );
    res.status(200).json({ message: "replyToMyDoctorReview" });
  },
);

// POST /admin/support/<comments|doctorfeedback>/reply/remove - moderation
// of the provider's answer: an abusive reply is taken down (the provider
// can then answer again).
const removeReplySchema = z.strictObject({
  ids: z.array(z.string().refine((v) => isValidObjectId(v))).min(1).max(200),
});

const removeReply = (model: Model<any>, name: string): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const parsed = removeReplySchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError());
    const result = await model.updateMany(
      { _id: { $in: parsed.data.ids } },
      { $unset: { reply: "" } },
    );
    res.status(200).json({
      message: `removeReply${name}`,
      data: { data: { updated: result.modifiedCount } },
    });
  });

export const removeCommentReply = removeReply(Comment, "Comments");
export const removeDoctorFeedbackReply = removeReply(DoctorFeedBack, "DoctorFeedback");
