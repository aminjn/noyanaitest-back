import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError } from "../Lib/AppError";
import BizConsentLog, { bizConsentActions, IBizConsentLog } from "../Models/BizConsentLog";
import { bizLinkSources } from "../Models/BizLinkOffer";
import { bizOwnerKinds } from "../Models/BizAccount";
import { normalizeMobile } from "../Lib/business/crm";
import { maskPhone } from "../Lib/business/crmService/link";

// The record-linking consent log for the super admin (2026-10,
// Models/BizConsentLog.ts): read only - the log has no update or delete
// route. Filtered by user, contact, centre, action, source, phone and
// date; the matched phone is masked in the answer.

const id = z.string().refine(isValidObjectId);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({
  user: id.optional(),
  contact: id.optional(),
  ownerKind: z.enum(bizOwnerKinds).optional(),
  ownerId: id.optional(),
  action: z.enum(bizConsentActions).optional(),
  source: z.enum(bizLinkSources).optional(),
  phone: z.string().max(20).optional(),
  from: day.optional(),
  to: day.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// GET /admin/consent-log?user=&contact=&ownerKind=&ownerId=&action=&source=&phone=&from=&to=&page=&limit=
export const listConsentLogs: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return next(new BadInputError());
  const { user, contact, ownerKind, ownerId, action, source, phone, from, to, page, limit } = parsed.data;
  const filter: Record<string, unknown> = {};
  if (user) filter.user = user;
  if (contact) filter.contact = contact;
  if (ownerKind) filter.ownerKind = ownerKind;
  if (ownerId) filter.ownerId = ownerId;
  if (action) filter.action = action;
  if (source) filter.source = source;
  if (phone) {
    const p = normalizeMobile(phone);
    if (!p) return next(new BadInputError());
    filter.phone = p;
  }
  if (from || to)
    filter.at = {
      ...(from ? { $gte: new Date(`${from}T00:00:00Z`) } : {}),
      ...(to ? { $lt: new Date(new Date(`${to}T00:00:00Z`).getTime() + 864e5) } : {}),
    };
  const [rows, total] = await Promise.all([
    BizConsentLog.find(filter)
      .sort({ at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate({ path: "user", select: "phone username", populate: { path: "identity", select: "givenName lastName" } })
      .lean<(Omit<IBizConsentLog, "user"> & { user: { _id: string; phone?: string; username?: string; identity?: { givenName?: string; lastName?: string } | null } | null })[]>(),
    BizConsentLog.countDocuments(filter),
  ]);
  const items = rows.map((r) => ({
    _id: r._id,
    at: r.at,
    action: r.action,
    actor: r.actor,
    source: r.source,
    reason: r.reason,
    ownerKind: r.ownerKind,
    ownerId: r.ownerId,
    ownerName: r.ownerName || "",
    contact: r.contact,
    offer: r.offer,
    phone: maskPhone(r.phone),
    ip: r.ip,
    userAgent: r.userAgent,
    user: r.user
      ? {
          _id: r.user._id,
          username: r.user.username,
          name: r.user.identity ? `${r.user.identity.givenName || ""} ${r.user.identity.lastName || ""}`.trim() : "",
        }
      : null,
  }));
  res.status(200).json({ message: "listConsentLogs", data: { data: { items, total, page, limit } } });
});
