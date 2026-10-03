import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { isValidObjectId } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import BizContact, { IBizContact } from "../Models/BizContact";
import BizActivity, { bizActivityKinds } from "../Models/BizActivity";
import BizCampaign, { IBizCampaign } from "../Models/BizCampaign";
import Wallet from "../Models/Wallet";
import { BizOwner } from "../Lib/business/coa";
import { audienceContacts, contactTimeline, newOptCode, normalizeMobile, own, syncContacts } from "../Lib/business/crm";
import {
  approveCampaign,
  campaignParts,
  cancelCampaign,
  estimate,
  messageFor,
  monthlyQuota,
  optOut,
  optOutInfo,
  orgInfo,
  quotaUsed,
  SEND_FROM,
  SEND_UNTIL,
  submitCampaign,
} from "../Lib/business/campaign";
import { getAppConfig } from "../Lib/appConfig";
import { OwnerOf } from "./businessController";

// Noyan Business CRM and SMS campaigns API (2026-10, under /<panel>/crm):
// the contacts (built from the panel's own visits and orders), their notes
// and follow-ups, and campaigns. Reading needs readCrm, writing manageCrm,
// a campaign's submit sendCampaigns; the plan module "crm" opens it
// (Routers/crmRoutes.ts). Approval is the super admin's (/requests).

const DAY = 864e5;
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .nullable();
const dateOf = (s?: string | null) => (s ? new Date(`${s}T09:00:00`) : undefined);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const withOwner = (ownerOf: OwnerOf, fn: (owner: BizOwner, req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const owner = ownerOf(req);
    if (!owner?.id) return next(new NotFoundError());
    await fn(owner, req, res);
  });

const tag = z.string().trim().min(1).max(40);
const contactBody = z.object({
  name: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(20).optional(),
  gender: z.enum(["male", "female"]).nullable().optional(),
  city: z.string().trim().max(100).optional(),
  tags: z.array(tag).max(20).optional(),
  note: z.string().trim().max(1000).optional(),
  smsOptOut: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const audienceBody = z.object({
  tags: z.array(tag).max(20).default([]),
  sources: z.array(z.enum(["visit", "order", "manual"])).max(3).default([]),
  gender: z.enum(["male", "female"]).nullable().optional(),
  inactiveDays: z.coerce.number().int().min(0).max(3650).nullable().optional(),
  activeDays: z.coerce.number().int().min(0).max(3650).nullable().optional(),
  minVisits: z.coerce.number().int().min(0).max(1000).nullable().optional(),
});
const cleanAudience = (a: z.infer<typeof audienceBody>) => ({
  tags: a.tags,
  sources: a.sources,
  ...(a.gender ? { gender: a.gender } : {}),
  ...(a.inactiveDays ? { inactiveDays: a.inactiveDays } : {}),
  ...(a.activeDays ? { activeDays: a.activeDays } : {}),
  ...(a.minVisits ? { minVisits: a.minVisits } : {}),
});
const campaignBody = z.object({
  name: z.string().trim().min(2).max(120),
  text: z.string().trim().min(5).max(700),
  audience: audienceBody,
});

const contactSearch = (q?: string) => {
  const term = (q || "").trim();
  if (!term) return {};
  const digits = term.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/\D/g, "");
  return {
    $or: [{ name: { $regex: escape(term), $options: "i" } }, ...(digits.length >= 3 ? [{ phone: { $regex: escape(digits) } }] : [])],
  };
};

export const makeCrmController = (ownerOf: OwnerOf) => ({
  getSummary: withOwner(ownerOf, async (owner, _req, res) => {
    await syncContacts(owner);
    const o = own(owner);
    const now = new Date();
    const [contacts, optedOut, lapsed, due, quota, used, info] = await Promise.all([
      BizContact.countDocuments({ ...o, isActive: true }),
      BizContact.countDocuments({ ...o, smsOptOut: true }),
      BizContact.countDocuments({ ...o, isActive: true, lastSeenAt: { $lte: new Date(Date.now() - 180 * DAY) } }),
      BizActivity.countDocuments({ ...o, kind: "followUp", doneAt: { $exists: false }, dueAt: { $lte: now } }),
      monthlyQuota(owner),
      quotaUsed(owner),
      orgInfo(owner),
    ]);
    const wallet = await Wallet.findOne({ user: info.user }).select("balance").lean<{ balance?: number }>();
    res.status(200).json({
      message: "crmSummary",
      data: { contacts, optedOut, lapsed, due, quota, quotaUsed: used, balance: wallet?.balance || 0, window: [SEND_FROM, SEND_UNTIL] },
    });
  }),

  getContacts: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        q: z.string().max(100).optional(),
        tag: tag.optional(),
        source: z.enum(["visit", "order", "manual"]).optional(),
        segment: z.enum(["lapsed", "recent", "loyal", "optedOut"]).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .safeParse(req.query);
    if (!parsed.success) throw new BadInputError();
    await syncContacts(owner);
    const { q, tag: t, source, segment, page, limit } = parsed.data;
    const filter: Record<string, unknown> = {
      ...own(owner),
      ...contactSearch(q),
      ...(t ? { tags: t } : {}),
      ...(source ? { source } : {}),
      ...(segment === "lapsed" ? { lastSeenAt: { $lte: new Date(Date.now() - 180 * DAY) } } : {}),
      ...(segment === "recent" ? { lastSeenAt: { $gte: new Date(Date.now() - 30 * DAY) } } : {}),
      ...(segment === "loyal" ? { $expr: { $gte: [{ $add: ["$visits", "$orders"] }, 3] } } : {}),
      ...(segment === "optedOut" ? { smsOptOut: true } : {}),
    };
    const [items, total] = await Promise.all([
      BizContact.find(filter)
        .sort({ lastSeenAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select("-optCode")
        .lean(),
      BizContact.countDocuments(filter),
    ]);
    res.status(200).json({ message: "crmContacts", data: { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) } });
  }),

  getTags: withOwner(ownerOf, async (owner, _req, res) => {
    const tags = await BizContact.distinct("tags", own(owner));
    res.status(200).json({ message: "crmTags", data: (tags as string[]).filter(Boolean).sort() });
  }),

  createContact: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = contactBody.safeParse(req.body || {});
    const phone = normalizeMobile(parsed.success ? parsed.data.phone : undefined);
    if (!parsed.success || !phone) throw new AppError("شماره‌ی موبایل معتبر نیست", 400);
    if (await BizContact.exists({ ...own(owner), phone })) throw new AppError("این شماره قبلاً در فهرست هست", 400);
    const { gender, ...rest } = parsed.data;
    const contact = await BizContact.create({
      ...own(owner),
      ...rest,
      ...(gender ? { gender } : {}),
      phone,
      source: "manual",
      optCode: newOptCode(),
    });
    res.status(201).json({ message: "crmCreateContact", data: contact });
  }),

  getContact: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.contactId)) throw new NotFoundError();
    const contact = await BizContact.findOne({ ...own(owner), _id: req.params.contactId }).select("-optCode").lean<IBizContact>();
    if (!contact) throw new NotFoundError();
    res.status(200).json({ message: "crmContact", data: { contact, timeline: await contactTimeline(owner, contact) } });
  }),

  updateContact: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = contactBody.omit({ phone: true }).safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.contactId)) throw new BadInputError();
    const { gender, smsOptOut, ...rest } = parsed.data;
    const contact = await BizContact.findOneAndUpdate(
      { ...own(owner), _id: req.params.contactId },
      {
        $set: {
          ...rest,
          ...(smsOptOut !== undefined ? { smsOptOut, ...(smsOptOut ? { optOutAt: new Date() } : {}) } : {}),
          ...(gender ? { gender } : {}),
        },
        ...(gender === null ? { $unset: { gender: 1 } } : {}),
      },
      { new: true },
    )
      .select("-optCode")
      .lean();
    if (!contact) throw new NotFoundError();
    res.status(200).json({ message: "crmUpdateContact", data: contact });
  }),

  addActivity: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({ kind: z.enum(bizActivityKinds), text: z.string().trim().min(2).max(1000), dueAt: day })
      .safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.contactId)) throw new AppError("متن یادداشت را بنویسید", 400);
    const { kind, text, dueAt } = parsed.data;
    if (kind === "followUp" && !dueAt) throw new AppError("تاریخ پیگیری را انتخاب کنید", 400);
    if (!(await BizContact.exists({ ...own(owner), _id: req.params.contactId }))) throw new NotFoundError();
    const a = await BizActivity.create({
      ...own(owner),
      contact: req.params.contactId,
      kind,
      text,
      ...(kind === "followUp" ? { dueAt: dateOf(dueAt) } : {}),
      createdBy: req.user?._id,
    });
    res.status(201).json({ message: "crmAddActivity", data: a });
  }),

  updateActivity: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ done: z.boolean() }).safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.activityId)) throw new BadInputError();
    const a = await BizActivity.findOneAndUpdate(
      { ...own(owner), _id: req.params.activityId, kind: "followUp" },
      parsed.data.done ? { $set: { doneAt: new Date() } } : { $unset: { doneAt: 1 } },
      { new: true },
    ).lean();
    if (!a) throw new NotFoundError();
    res.status(200).json({ message: "crmUpdateActivity", data: a });
  }),

  // the follow-ups still open: due (today and before) first, then upcoming
  getFollowUps: withOwner(ownerOf, async (owner, _req, res) => {
    const rows = await BizActivity.find({ ...own(owner), kind: "followUp", doneAt: { $exists: false } })
      .sort({ dueAt: 1 })
      .limit(200)
      .populate("contact", "name phone")
      .lean();
    res.status(200).json({ message: "crmFollowUps", data: rows });
  }),

  // ---------------------------------------------------------------- campaigns
  getCampaigns: withOwner(ownerOf, async (owner, _req, res) => {
    const rows = await BizCampaign.find(own(owner)).sort({ createdAt: -1 }).limit(100).lean();
    res.status(200).json({ message: "crmCampaigns", data: rows });
  }),

  // what a campaign with this text and audience would reach and cost now
  estimate: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ text: z.string().max(700).default(""), audience: audienceBody }).safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const audience = cleanAudience(parsed.data.audience);
    const [e, sample, cfg] = await Promise.all([
      estimate(owner, parsed.data.text, audience),
      audienceContacts(owner, audience),
      getAppConfig(),
    ]);
    const base = (cfg.siteBaseUrl || "").replace(/\/+$/, "");
    res.status(200).json({
      message: "crmEstimate",
      data: { ...e, preview: parsed.data.text.trim() ? messageFor(parsed.data.text, base, "a1B2c3D4") : "", sample: sample.slice(0, 3).map((c) => c.name || c.phone) },
    });
  }),

  createCampaign: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = campaignBody.safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام کمپین و متن پیامک (دست‌کم ۵ نویسه) را بنویسید", 400);
    const c = await BizCampaign.create({
      ...own(owner),
      name: parsed.data.name,
      text: parsed.data.text,
      audience: cleanAudience(parsed.data.audience),
      parts: await campaignParts(parsed.data.text),
      createdBy: req.user?._id,
    });
    res.status(201).json({ message: "crmCreateCampaign", data: c });
  }),

  updateCampaign: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = campaignBody.safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.campaignId))
      throw new AppError("نام کمپین و متن پیامک (دست‌کم ۵ نویسه) را بنویسید", 400);
    const c = await BizCampaign.findOneAndUpdate(
      { ...own(owner), _id: req.params.campaignId, status: { $in: ["Draft", "Rejected"] } },
      {
        $set: {
          name: parsed.data.name,
          text: parsed.data.text,
          audience: cleanAudience(parsed.data.audience),
          parts: await campaignParts(parsed.data.text),
        },
      },
      { new: true },
    ).lean();
    if (!c) throw new AppError("فقط پیش‌نویس یا کمپین ردشده ویرایش می‌شود", 400);
    res.status(200).json({ message: "crmUpdateCampaign", data: c });
  }),

  submitCampaign: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.campaignId)) throw new NotFoundError();
    res.status(200).json({ message: "crmSubmitCampaign", data: await submitCampaign(owner, req.params.campaignId) });
  }),

  cancelCampaign: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.campaignId)) throw new NotFoundError();
    res.status(200).json({ message: "crmCancelCampaign", data: await cancelCampaign(owner, req.params.campaignId) });
  }),
});

// ---------------------------------------------------------------- super admin

// GET /admin/campaigns/:id - the request's detail: who, to how many, what
// it costs and the exact text a recipient gets
export const adminGetCampaign: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  if (!isValidObjectId(req.params.id)) throw new NotFoundError();
  const c = await BizCampaign.findById(req.params.id).lean<IBizCampaign>();
  if (!c) throw new NotFoundError();
  const owner = { kind: c.ownerKind, id: String(c.ownerId) } as BizOwner;
  const [info, e, cfg] = await Promise.all([
    orgInfo(owner).catch(() => ({ name: "", user: undefined })),
    ["Pending", "Approved"].includes(c.status) ? estimate(owner, c.text, c.audience) : Promise.resolve(null),
    getAppConfig(),
  ]);
  const base = (cfg.siteBaseUrl || "").replace(/\/+$/, "");
  res.status(200).json({
    message: "adminCampaign",
    data: { ...c, ownerName: info.name, estimate: e, preview: messageFor(c.text, base, "a1B2c3D4") },
  });
});

// POST /admin/campaigns/:id/approve
export const adminApproveCampaign: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  if (!isValidObjectId(req.params.id)) throw new NotFoundError();
  res.status(200).json({ message: "adminApproveCampaign", data: await approveCampaign(req.params.id, req.user?._id) });
});

// ---------------------------------------------------------------- public

// GET/POST /public/sms-optout/:code - the opt-out link in every campaign SMS
export const getOptOut: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const code = String(req.params.code || "");
  const info = /^[A-Za-z0-9_-]{6,12}$/.test(code) ? await optOutInfo(code) : null;
  if (!info) throw new AppError("این لینک معتبر نیست", 404);
  res.status(200).json({ message: "optOut", data: info });
});

export const postOptOut: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const code = String(req.params.code || "");
  const parsed = z.object({ scope: z.enum(["owner", "all"]) }).safeParse(req.body || {});
  if (!parsed.success || !/^[A-Za-z0-9_-]{6,12}$/.test(code)) throw new BadInputError();
  res.status(200).json({ message: "optOutDone", data: await optOut(code, parsed.data.scope) });
});

