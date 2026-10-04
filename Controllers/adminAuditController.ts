import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError } from "../Lib/AppError";
import AdminAuditLog, { adminAuditActions } from "../Models/AdminAuditLog";

const querySchema = z.object({
  actor: z.string().refine(isValidObjectId).optional(),
  action: z.enum(adminAuditActions).optional(),
  target: z.string().max(100).optional(),
  targetId: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// GET /admin/audit?actor=&action=&target=&targetId=&page=&limit=
export const listAuditLogs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return next(new BadInputError());
    const { actor, action, target, targetId, page, limit } = parsed.data;

    const filter: Record<string, unknown> = {};
    if (actor) filter.actor = actor;
    if (action) filter.action = action;
    if (target) filter.target = target;
    if (targetId) filter.targetId = targetId;

    const [items, total, actors] = await Promise.all([
      AdminAuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate({
          path: "actor",
          select: "phone username role",
          populate: { path: "identity", select: "givenName lastName" },
        })
        .lean(),
      AdminAuditLog.countDocuments(filter),
      // everyone who has logged actions, for the actor filter
      AdminAuditLog.aggregate([
        { $group: { _id: "$actor", count: { $sum: 1 } } },
        { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
        { $lookup: { from: "useridentities", localField: "_id", foreignField: "user", as: "identity" } },
        {
          $project: {
            count: 1,
            phone: { $first: "$user.phone" },
            username: { $first: "$user.username" },
            givenName: { $first: "$identity.givenName" },
            lastName: { $first: "$identity.lastName" },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 100 },
      ]),
    ]);

    res.status(200).json({
      message: "listAuditLogs",
      data: { data: { items, total, page, limit, actors } },
    });
  },
);
