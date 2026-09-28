import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  BadTimingError,
  MiddlewareError,
  NotFoundError,
  PathNotFoundError,
} from "../Lib/AppError";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import { cookieBuilder } from "./authController";
import Secretary from "../Models/Secretary";
import {
  nameToAclModelName,
  nameToModelName,
  nodesWithAcl,
} from "./aclController";
import SecretaryRequest from "../Models/SecretaryRequest";
import { NodeWithAcl } from "../Lib/enums";

export const getMyBosses: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    const data = await Secretary.find({
      secretary: req.user._id,
      ownerPath: nameToModelName[name],
    }).populate({ path: "owner" });
    res.status(200).json({ message: "getMyBosses", data });
  }
);

export const leaveBoss: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await Secretary.findOne({
      _id: nodeId,
      secretary: req.user._id,
    });
    if (!node) return next(new NotFoundError());
    await Secretary.findByIdAndDelete(nodeId);
    res.status(200).json({ message: "leaveBoss" });
  }
);

export const mountBoss: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await Secretary.findOne({
      _id: nodeId,
      secretary: req.user._id,
    });
    if (!node) return next(new NotFoundError());
    cookieBuilder({ name, id: node._id.toString(), res });
    res.status(200).json({ message: "mountBoss" });
  }
);

export const getMyRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req.user) return next(new MiddlewareError());
    const data = await SecretaryRequest.find({
      phone: req.user.phone,
      ownerPath: nameToModelName[name],
    }).populate({ path: "owner" });
    res.status(200).json({ message: "getMyRequests", data });
  }
);

const toggleRequestStatusSchema = z.strictObject({
  status: z.enum(["Approved", "Rejected"]),
});
export const toggleDoctorRequestStatus: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await toggleRequestStatusSchema.safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    const node = await SecretaryRequest.findOne({
      _id: nodeId,
      phone: req.user.phone,
    });
    if (!node) return next(new NotFoundError());
    if (node.status !== "Pending") return next(new BadTimingError());
    if (data.status === "Approved") {
      // already on this owner's team: just close the invite (the old
      // check looked at a `user` field that doesn't exist, so a second
      // approval hit the unique index and 500'd)
      const dup = await Secretary.exists({
        owner: node.owner._id,
        ownerPath: nameToModelName[name],
        secretary: req.user._id,
      });
      await SecretaryRequest.findByIdAndUpdate(node._id, data);
      if (dup) return res.status(200).json({ message: "toggleDoctorRequestStatus" });
      await Secretary.create({
        owner: node.owner._id,
        secretary: req.user._id,
        acl: node.acl,
        displayName: node.displayName,
        ownerPath: nameToModelName[name],
        aclPath: nameToAclModelName[name],
      });
    } else {
      await SecretaryRequest.findByIdAndUpdate(node._id, data);
    }
    res.status(200).json({ message: "toggleDoctorRequestStatus" });
  }
);

// Secretary home: every workplace (any org type) and every pending invite
// in one call, each with a display label, so the panel can show one list
// instead of six tabs.
const modelToName = Object.fromEntries(
  nodesWithAcl.map((n) => [nameToModelName[n], n]),
) as Record<string, NodeWithAcl>;

const ownerLabel = (owner: unknown): string => {
  if (!owner || typeof owner !== "object") return "";
  const o = owner as { firstName?: string; lastName?: string; name?: string };
  return (
    [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || o.name || ""
  );
};

export const getMyOverview: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const [bosses, requests] = await Promise.all([
      Secretary.find({ secretary: req.user._id })
        .populate({ path: "owner" })
        .populate({ path: "acl", select: "name" }),
      SecretaryRequest.find({ phone: req.user.phone, status: "Pending" })
        .sort({ submittedAt: -1 })
        .populate({ path: "owner" }),
    ]);
    res.status(200).json({
      message: "getMyOverview",
      data: {
        phone: req.user.phone,
        workplaces: bosses
          .filter((b) => !!b.owner)
          .map((b) => ({
            _id: b._id,
            kind: modelToName[b.ownerPath] || null,
            label: ownerLabel(b.owner),
            displayName: b.displayName || "",
            role: (b.acl as unknown as { name?: string } | null)?.name || "",
          }))
          .filter((w) => !!w.kind),
        invites: requests
          .filter((r) => !!r.owner)
          .map((r) => ({
            _id: r._id,
            kind: modelToName[r.ownerPath] || null,
            label: ownerLabel(r.owner),
            displayName: r.displayName || "",
            message: r.message || "",
            submittedAt: r.submittedAt,
          }))
          .filter((i) => !!i.kind),
      },
    });
  },
);
