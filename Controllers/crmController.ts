import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { isValidObjectId } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import BizContact, { IBizContact } from "../Models/BizContact";
import BizActivity, { bizActivityKinds } from "../Models/BizActivity";
import BizCampaign, { IBizAudience, IBizCampaign } from "../Models/BizCampaign";
import BizMessage from "../Models/BizMessage";
import Wallet from "../Models/Wallet";
import { BizOwner } from "../Lib/business/coa";
import {
  audienceContacts,
  contactTimeline,
  newOptCode,
  jalaliMD,
  normalizeMobile,
  own,
  presetSegments,
  rulesFilter,
  syncContacts,
} from "../Lib/business/crm";
import BizSegment from "../Models/BizSegment";
import { bizInsurers } from "../Models/BizContact";
import {
  approveCampaign,
  campaignParts,
  cancelCampaign,
  estimate,
  monthlyQuota,
  previewText,
  optOut,
  optOutInfo,
  orgInfo,
  quotaUsed,
  SEND_FROM,
  SEND_UNTIL,
  submitCampaign,
} from "../Lib/business/campaign";
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
  insurer: z.enum(bizInsurers).nullable().optional(),
  birthDate: day,
  tags: z.array(tag).max(20).optional(),
  note: z.string().trim().max(1000).optional(),
  smsOptOut: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const posInt = (max: number) => z.coerce.number().int().min(0).max(max).nullable().optional();
// the contact rules of a segment, a campaign's audience or an automation's
export const rulesBody = z.object({
  tags: z.array(tag).max(20).default([]),
  tagsAll: z.boolean().nullable().optional(),
  excludeTags: z.array(tag).max(20).nullable().optional(),
  sources: z.array(z.enum(["visit", "order", "manual", "import"])).max(4).default([]),
  gender: z.enum(["male", "female"]).nullable().optional(),
  ageMin: posInt(120),
  ageMax: posInt(120),
  city: z.string().trim().max(100).nullable().optional(),
  insurer: z.enum(bizInsurers).nullable().optional(),
  inactiveDays: posInt(3650),
  activeDays: posInt(3650),
  minVisits: posInt(1000),
  maxVisits: posInt(1000),
  minSpent: z.coerce.number().min(0).max(1e12).nullable().optional(),
  noShowDays: posInt(3650),
  birthday: z.enum(["today", "week", "month"]).nullable().optional(),
  newDays: posInt(3650),
  highValue: z.boolean().nullable().optional(),
});
// only the rules that are set (an empty field is "any")
export const cleanRules = (a: z.infer<typeof rulesBody>) => {
  const out: Record<string, unknown> = { tags: a.tags, sources: a.sources };
  for (const [k, v] of Object.entries(a)) {
    if (k === "tags" || k === "sources") continue;
    if (v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && !v.length)) continue;
    if (typeof v === "number" && !v && k !== "maxVisits") continue;
    out[k] = v;
  }
  return out;
};
const audienceBody = rulesBody.extend({
  segment: z.string().regex(/^[0-9a-f]{24}$/).nullable().optional(),
  contactIds: z.array(z.string().regex(/^[0-9a-f]{24}$/)).max(5000).nullable().optional(),
});
const cleanAudience = (a: z.infer<typeof audienceBody>) =>
  ({
    ...cleanRules(a),
    ...(a.segment ? { segment: a.segment } : {}),
    ...(a.contactIds?.length ? { contactIds: a.contactIds } : {}),
  }) as unknown as IBizAudience;
const hour = z.coerce.number().int().min(8).max(21);
const campaignBody = z.object({
  name: z.string().trim().min(2).max(120),
  text: z.string().trim().min(5).max(700),
  audience: audienceBody,
  template: z.string().regex(/^[0-9a-f]{24}$/).nullable().optional(),
  sendAt: z.string().datetime({ offset: true }).nullable().optional(),
  windowFrom: hour.nullable().optional(),
  windowUntil: hour.nullable().optional(),
});
const campaignFields = (d: z.infer<typeof campaignBody>) => {
  const from = d.windowFrom ?? SEND_FROM;
  const until = d.windowUntil ?? SEND_UNTIL;
  if (until <= from) throw new AppError("پایان بازه‌ی ارسال باید بعد از شروع آن باشد", 400);
  return {
    name: d.name,
    text: d.text,
    audience: cleanAudience(d.audience),
    ...(d.template ? { template: d.template } : {}),
    ...(d.sendAt ? { sendAt: new Date(d.sendAt) } : {}),
    windowFrom: from,
    windowUntil: until,
  };
};

const contactSearch = (q?: string) => {
  const term = (q || "").trim();
  if (!term) return {};
  const digits = term.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/\D/g, "");
  return {
    $or: [{ name: { $regex: escape(term), $options: "i" } }, ...(digits.length >= 3 ? [{ phone: { $regex: escape(digits) } }] : [])],
  };
};

const birthFields = (d?: string | null) => {
  if (!d) return {};
  const t = new Date(`${d}T12:00:00Z`);
  return Number.isNaN(t.getTime()) ? {} : { birthDate: t, birthYear: t.getUTCFullYear(), birthMD: jalaliMD(t) };
};

const contactQuery = z.object({
  q: z.string().max(100).optional(),
  tag: tag.optional(),
  source: z.enum(["visit", "order", "manual", "import"]).optional(),
  // a saved segment's id, or "preset:<name>" (Lib/business/crm.ts presetSegments)
  segment: z.string().max(40).optional(),
  // the rules as JSON (the filter panel)
  rules: z.string().max(4000).optional(),
  optedOut: z.enum(["1", "0"]).optional(),
  inactive: z.enum(["1"]).optional(),
  sort: z.enum(["recent", "visits", "spent", "name", "new"]).default("recent"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const sortOf = (s: z.infer<typeof contactQuery>["sort"]): Record<string, 1 | -1> =>
  s === "visits" ? { visits: -1, _id: -1 } : s === "spent" ? { spent: -1, _id: -1 } : s === "name" ? { name: 1, _id: 1 } : s === "new" ? { createdAt: -1, _id: -1 } : { lastSeenAt: -1, _id: -1 };

// the list's filter: search, a tag, a segment (saved or ready-made), the
// filter panel's own rules; inactive (removed) contacts only when asked
const contactListFilter = async (owner: BizOwner, p: z.infer<typeof contactQuery>) => {
  const and: Record<string, unknown>[] = [{ ...own(owner), isActive: p.inactive ? false : { $ne: false } }, contactSearch(p.q)];
  if (p.tag) and.push({ tags: p.tag });
  if (p.source) and.push({ source: p.source });
  if (p.optedOut === "1") and.push({ smsOptOut: true });
  if (p.segment?.startsWith("preset:")) {
    const preset = presetSegments[p.segment.slice(7)];
    if (preset) and.push(await rulesFilter(owner, preset));
  } else if (p.segment && isValidObjectId(p.segment)) {
    const seg = await BizSegment.findOne({ ...own(owner), _id: p.segment }).lean();
    if (seg) and.push(await rulesFilter(owner, seg.rules || {}));
  }
  if (p.rules) {
    let raw: unknown = null;
    try {
      raw = JSON.parse(p.rules);
    } catch {
      raw = null;
    }
    const r = rulesBody.safeParse(raw || {});
    if (r.success) and.push(await rulesFilter(owner, cleanRules(r.data)));
  }
  return { $and: and };
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
    const parsed = contactQuery.safeParse(req.query);
    if (!parsed.success) throw new BadInputError();
    await syncContacts(owner);
    const { page, limit, sort } = parsed.data;
    const filter = await contactListFilter(owner, parsed.data);
    const [items, total] = await Promise.all([
      BizContact.find(filter)
        .sort(sortOf(sort))
        .skip((page - 1) * limit)
        .limit(limit)
        .select("-optCode")
        .lean(),
      BizContact.countDocuments(filter),
    ]);
    res.status(200).json({ message: "crmContacts", data: { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) } });
  }),

  // the same list as a CSV file (UTF-8 with BOM, so Excel reads Persian)
  exportContacts: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = contactQuery.safeParse(req.query);
    if (!parsed.success) throw new BadInputError();
    const filter = await contactListFilter(owner, parsed.data);
    const rows = await BizContact.find(filter).sort(sortOf(parsed.data.sort)).limit(20000).select("-optCode").lean<IBizContact[]>();
    const cell = (v: unknown) => {
      const t = v === undefined || v === null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const head = ["name", "phone", "gender", "birthDate", "city", "insurer", "tags", "visits", "orders", "noShows", "spent", "lastSeenAt", "source", "smsOptOut", "note"];
    const lines = [head.join(",")].concat(
      rows.map((c) =>
        [c.name, c.phone, c.gender, c.birthDate, c.city, c.insurer, (c.tags || []).join("|"), c.visits, c.orders, c.noShows, c.spent, c.lastSeenAt, c.source, c.smsOptOut ? 1 : 0, c.note]
          .map(cell)
          .join(","),
      ),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="contacts.csv"');
    res.status(200).send("\ufeff" + lines.join("\r\n"));
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
    const { gender, insurer, birthDate, ...rest } = parsed.data;
    const contact = await BizContact.create({
      ...own(owner),
      ...rest,
      ...(gender ? { gender } : {}),
      ...(insurer ? { insurer } : {}),
      ...birthFields(birthDate),
      phone,
      source: "manual",
      consentAt: new Date(),
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
    const { gender, smsOptOut, insurer, birthDate, ...rest } = parsed.data;
    const unset = {
      ...(gender === null ? { gender: 1 } : {}),
      ...(insurer === null ? { insurer: 1 } : {}),
      ...(birthDate === null ? { birthDate: 1, birthMD: 1, birthYear: 1 } : {}),
    };
    const contact = await BizContact.findOneAndUpdate(
      { ...own(owner), _id: req.params.contactId },
      {
        $set: {
          ...rest,
          ...(smsOptOut !== undefined ? { smsOptOut, ...(smsOptOut ? { optOutAt: new Date() } : {}) } : {}),
          ...(gender ? { gender } : {}),
          ...(insurer ? { insurer } : {}),
          ...birthFields(birthDate),
        },
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
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

  // ---------------------------------------------------------------- campaigns
  getCampaigns: withOwner(ownerOf, async (owner, _req, res) => {
    const rows = await BizCampaign.find(own(owner)).sort({ createdAt: -1 }).limit(100).lean();
    res.status(200).json({ message: "crmCampaigns", data: rows });
  }),

  // one campaign: its figures and each recipient's message (status, click,
  // booking), newest first
  getCampaign: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.campaignId)) throw new NotFoundError();
    const c = await BizCampaign.findOne({ ...own(owner), _id: req.params.campaignId }).lean<IBizCampaign>();
    if (!c) throw new NotFoundError();
    const q = z
      .object({ page: z.coerce.number().int().min(1).default(1), status: z.enum(["sent", "failed", "clicked", "booked"]).optional() })
      .safeParse(req.query);
    const page = q.success ? q.data.page : 1;
    const st = q.success ? q.data.status : undefined;
    const filter: Record<string, unknown> = {
      campaign: c._id,
      ...(st === "sent" || st === "failed" ? { status: st } : {}),
      ...(st === "clicked" ? { clicks: { $gt: 0 } } : {}),
      ...(st === "booked" ? { bookedAt: { $exists: true } } : {}),
    };
    const [messages, total, stats, preview] = await Promise.all([
      BizMessage.find(filter)
        .sort({ _id: -1 })
        .skip((page - 1) * 50)
        .limit(50)
        .select("contact phone status reason parts clicks clickedAt bookedAt sentAt")
        .populate("contact", "name")
        .lean(),
      BizMessage.countDocuments(filter),
      BizMessage.aggregate([
        { $match: { campaign: c._id } },
        {
          $group: {
            _id: null,
            sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
            clicked: { $sum: { $cond: [{ $gt: ["$clicks", 0] }, 1, 0] } },
            booked: { $sum: { $cond: [{ $ifNull: ["$bookedAt", false] }, 1, 0] } },
          },
        },
      ]),
      previewText(owner, c.text),
    ]);
    res.status(200).json({
      message: "crmCampaign",
      data: { campaign: c, preview, stats: stats[0] || { sent: 0, failed: 0, clicked: 0, booked: 0 }, messages, total, page, pages: Math.max(1, Math.ceil(total / 50)) },
    });
  }),

  // what a campaign with this text and audience would reach and cost now
  estimate: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ text: z.string().max(700).default(""), audience: audienceBody }).safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const audience = cleanAudience(parsed.data.audience);
    const [e, sample] = await Promise.all([estimate(owner, parsed.data.text, audience), audienceContacts(owner, audience)]);
    res.status(200).json({
      message: "crmEstimate",
      data: {
        ...e,
        preview: parsed.data.text.trim() ? await previewText(owner, parsed.data.text, sample[0]) : "",
        sample: sample.slice(0, 3).map((c) => c.name || c.phone),
      },
    });
  }),

  createCampaign: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = campaignBody.safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام کمپین و متن پیامک (دست‌کم ۵ نویسه) را بنویسید", 400);
    const c = await BizCampaign.create({
      ...own(owner),
      ...campaignFields(parsed.data),
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
        $set: { ...campaignFields(parsed.data), parts: await campaignParts(parsed.data.text) },
        ...(parsed.data.sendAt ? {} : { $unset: { sendAt: 1 } }),
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
  const [info, e, preview] = await Promise.all([
    orgInfo(owner).catch(() => ({ name: "", user: undefined })),
    ["Pending", "Approved"].includes(c.status) ? estimate(owner, c.text, c.audience) : Promise.resolve(null),
    previewText(owner, c.text),
  ]);
  res.status(200).json({ message: "adminCampaign", data: { ...c, ownerName: info.name, estimate: e, preview } });
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

