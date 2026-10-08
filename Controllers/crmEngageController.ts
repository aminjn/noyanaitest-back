import { addTehranDays, startOfTehranDay, tehranYmd } from "../Lib/tehranTime";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import mongoose, { isValidObjectId } from "mongoose";
import moment from "moment-jalaali";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import BizContact, { IBizContact } from "../Models/BizContact";
import BizActivity from "../Models/BizActivity";
import BizCampaign from "../Models/BizCampaign";
import BizSegment from "../Models/BizSegment";
import BizTemplate, { bizTemplateCategories, IBizTemplate } from "../Models/BizTemplate";
import BizAutomation, { bizAutomationKinds, IBizAutomation } from "../Models/BizAutomation";
import BizMessage from "../Models/BizMessage";
import BizTag from "../Models/BizTag";
import Reservation from "../Models/Reservation";
import { creditScope, WalletScope } from "../Lib/walletScope";
import Secretary, { nodesWithAclToSecreataryAclPathDict } from "../Models/Secretary";
import User from "../Models/User";
import UserIdentity from "../Models/UserIdentity";
import { BizOwner } from "../Lib/business/coa";
import { jalaliMD, newOptCode, normalizeMobile, own, presetSegments, rulesFilter, syncContacts, visitsWhere } from "../Lib/business/crm";
import {
  approveTemplateText,
  inOwnWindow,
  monthlyQuota,
  orgInfo,
  previewText,
  quotaUsed,
  takeQuota,
  giveQuota,
  unitPrice,
  varsFor,
  walletTx,
  spendOnSms,
  smsBalance,
} from "../Lib/business/campaign";
import { messageFor, newTrackedLink, orgPublicUrl, randomCode, renderText, sendOne, siteBase, smsParts, trackedUrl } from "../Lib/business/crmSend";
import { automationDefaults, dueCandidates } from "../Lib/business/crmAutomation";
import { sheetRows } from "../Lib/business/purchaseInvoices";
import { notifyUserAlertSubscribers } from "../Services/userAlertService";
import { OwnerOf } from "./businessController";
import { offerNewContactsLater } from "../Lib/business/crmService/link";
import { cleanRules, rulesBody } from "./crmController";

// The CRM's engagement API under /<panel>/crm (2026-10): the dashboard,
// import, inline tags, the team a follow-up is assigned to, follow-ups as
// tasks, saved segments, SMS templates (cleared once by the super admin),
// automations and the one-off SMS from a contact's page. Read with readCrm,
// write with manageCrm, anything that spends money with sendCampaigns
// (Routers/crmRoutes.ts). Everything is the panel's own: every query is
// scoped to its owner (Lib/business/crm.ts own()).

const DAY = 864e5;
const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));
const idRe = /^[0-9a-f]{24}$/;
const withOwner = (ownerOf: OwnerOf, fn: (owner: BizOwner, req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const owner = ownerOf(req);
    if (!owner?.id) return next(new NotFoundError());
    await fn(owner, req, res);
  });
const tag = z.string().trim().min(1).max(40);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// the start of this Jalali month (Tehran)
const monthStart = () => moment().utcOffset(210).startOf("jMonth").toDate();

// the owner's account and its secretaries: who a follow-up can be given to
const team = async (owner: BizOwner) => {
  const info = await orgInfo(owner);
  const path = nodesWithAclToSecreataryAclPathDict[owner.kind as keyof typeof nodesWithAclToSecreataryAclPathDict];
  const secs = path
    ? await Secretary.find({ owner: owner.id, ownerPath: path }).select("secretary displayName").lean<{ secretary: unknown; displayName?: string }[]>()
    : [];
  const ids = [info.user, ...secs.map((s) => s.secretary)].filter(Boolean).map(String);
  const [users, ids2] = await Promise.all([
    User.find({ _id: { $in: ids } }).select("phone").lean<{ _id: unknown; phone?: string }[]>(),
    UserIdentity.find({ user: { $in: ids } }).select("user givenName lastName").lean<{ user?: unknown; givenName?: string; lastName?: string }[]>(),
  ]);
  const nameOf = (id: string) => {
    const i = ids2.find((x) => String(x.user) === id);
    return (i ? `${i.givenName || ""} ${i.lastName || ""}`.trim() : "") || users.find((u) => String(u._id) === id)?.phone || "";
  };
  return [
    ...(info.user ? [{ _id: String(info.user), name: info.name || nameOf(String(info.user)), role: "owner" }] : []),
    ...secs.map((s) => ({ _id: String(s.secretary), name: s.displayName || nameOf(String(s.secretary)), role: "secretary" })),
  ];
};

// import: the columns a file may have, recognised by their header
const IMPORT_FIELDS = ["name", "firstName", "lastName", "phone", "gender", "birthDate", "city", "insurer", "tags", "note"] as const;
type ImportField = (typeof IMPORT_FIELDS)[number];
const GUESS: [ImportField, RegExp][] = [
  ["phone", /موبایل|تلفن|شماره|همراه|phone|mobile|tel/i],
  ["firstName", /^نام$|first|given/i],
  ["lastName", /نام\s*خانوادگی|فامیل|last|family|surname/i],
  ["name", /نام\s*و\s*نام|نام کامل|full\s*name|^name$|بیمار|مشتری/i],
  ["gender", /جنس|gender|sex/i],
  ["birthDate", /تولد|birth/i],
  ["city", /شهر|city/i],
  ["insurer", /بیمه|insur/i],
  ["tags", /برچسب|tag|گروه/i],
  ["note", /یادداشت|توضیح|note|comment/i],
];
const text = (v: unknown) =>
  (v instanceof Date ? v.toISOString().slice(0, 10) : v === undefined || v === null ? "" : String(v))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .trim();
const genderOf = (v: string) => (/^(f|female|زن|خانم|مونث)/i.test(v) ? "female" : /^(m|male|مرد|آقا|مذکر)/i.test(v) ? "male" : undefined);
const insurerOf = (v: string) =>
  /تامین|تأمین|tamin/i.test(v) ? "tamin" : /سلامت|salamat/i.test(v) ? "salamat" : /مسلح|armed/i.test(v) ? "armed" : v ? "other" : undefined;
// a birth date as YYYY-MM-DD: Gregorian, or Jalali (13xx / 14xx)
const birthOf = (v: string) => {
  const m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return undefined;
  const y = Number(m[1]);
  const d =
    y < 1500
      ? moment(`${m[1]}/${m[2]}/${m[3]}`, "jYYYY/jM/jD").utcOffset(210, true)
      : moment.utc(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  return d.isValid() ? new Date(Date.UTC(d.year(), d.month(), d.date(), 12)) : undefined;
};

const templateBody = z.object({
  name: z.string().trim().min(2).max(80),
  text: z.string().trim().min(5).max(700),
  category: z.enum(bizTemplateCategories).default("general"),
});

const automationBody = z.object({
  name: z.string().trim().min(2).max(80),
  template: z.string().regex(idRe).nullable().optional(),
  delay: z.coerce.number().int().min(0).max(3650),
  sessionTypes: z.array(z.string().max(40)).max(10).default([]),
  audience: rulesBody,
  windowFrom: z.coerce.number().int().min(8).max(20),
  windowUntil: z.coerce.number().int().min(9).max(21),
  gapDays: z.coerce.number().int().min(0).max(60),
  oncePerYear: z.boolean().default(false),
});

const fileOf = (req: Request) => (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;

export const makeCrmEngageController = (ownerOf: OwnerOf) => ({
  // ---------------------------------------------------------------- dashboard
  getDashboard: withOwner(ownerOf, async (owner, _req, res) => {
    await syncContacts(owner);
    const o = own(owner);
    const now = Date.now();
    const active = { ...o, isActive: { $ne: false } };
    const where = await visitsWhere(owner);
    const since90 = new Date(now - 90 * DAY);
    const [
      total,
      newMonth,
      activeCount,
      lapsed,
      optedOut,
      overdue,
      upcoming,
      nextFollowUps,
      birthdays,
      quota,
      used,
      info,
      price,
      campaigns,
      autoStats,
      visits90,
      automations,
    ] = await Promise.all([
      BizContact.countDocuments(active),
      BizContact.countDocuments({ ...active, createdAt: { $gte: monthStart() } }),
      BizContact.countDocuments({ ...active, lastSeenAt: { $gte: new Date(now - 180 * DAY) } }),
      BizContact.countDocuments({ ...active, lastSeenAt: { $lt: new Date(now - 180 * DAY) } }),
      BizContact.countDocuments({ ...o, smsOptOut: true }),
      BizActivity.countDocuments({ ...o, kind: "followUp", doneAt: { $exists: false }, dueAt: { $lt: startOfTehranDay() } }),
      BizActivity.countDocuments({ ...o, kind: "followUp", doneAt: { $exists: false }, dueAt: { $lte: new Date(now + 7 * DAY) } }),
      BizActivity.find({ ...o, kind: "followUp", doneAt: { $exists: false } })
        .sort({ dueAt: 1 })
        .limit(5)
        .populate("contact", "name phone")
        .populate("assignee", "phone")
        .lean(),
      BizContact.find({ $and: [active, await rulesFilter(owner, { birthday: "week" })] })
        .select("name phone birthMD smsOptOut")
        .limit(12)
        .lean(),
      monthlyQuota(owner),
      quotaUsed(owner),
      orgInfo(owner),
      unitPrice(),
      BizCampaign.find({ ...o, status: { $in: ["Sent", "Sending", "Approved", "Pending"] } })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("name status recipients sentCount failedCount clicks bookings finishedAt sendAfter createdAt")
        .lean(),
      BizMessage.aggregate([
        { $match: { ...o, createdAt: { $gte: new Date(now - 30 * DAY) } } },
        {
          $group: {
            _id: "$source",
            sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
            clicked: { $sum: { $cond: [{ $gt: ["$clicks", 0] }, 1, 0] } },
            booked: { $sum: { $cond: [{ $ifNull: ["$bookedAt", false] }, 1, 0] } },
            parts: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, "$parts", 0] } },
          },
        },
      ]),
      where
        ? Reservation.aggregate([
            { $match: { ...where, date: { $gte: since90, $lte: new Date() }, status: { $in: ["completed", "noShow"] } } },
            {
              $group: {
                _id: null,
                done: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
                missed: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "noShow"] }, { $ne: ["$noShowParty", "doctor"] }] }, 1, 0] } },
              },
            },
          ])
        : Promise.resolve([]),
      BizAutomation.find({ ...o, enabled: true }).lean<IBizAutomation[]>(),
    ]);
    // what the switched-on automations will send in the next seven days
    let recallsWeek = 0;
    for (const a of automations) recallsWeek += (await dueCandidates(a, { horizonMs: 7 * DAY }).catch(() => [])).length;
    const wallet = { balance: await smsBalance(owner, info.user) };
    const v = (visits90[0] as { done?: number; missed?: number } | undefined) || {};
    res.status(200).json({
      message: "crmDashboard",
      data: {
        contacts: { total, newMonth, active: activeCount, lapsed, optedOut },
        followUps: { overdue, upcoming, next: nextFollowUps },
        recallsWeek,
        birthdays,
        campaigns,
        messages30: autoStats,
        noShow: { done: v.done || 0, missed: v.missed || 0, rate: v.done || v.missed ? (v.missed || 0) / ((v.done || 0) + (v.missed || 0)) : 0, tracked: !!where },
        sms: { quota, quotaUsed: used, balance: wallet?.balance || 0, unitPrice: price },
        automationsOn: automations.length,
      },
    });
  }),

  // ---------------------------------------------------------------- tags
  // the tag picker (NodesSelector): names as options
  getTagOptions: withOwner(ownerOf, async (owner, _req, res) => {
    const [used, made] = await Promise.all([BizContact.distinct("tags", own(owner)), BizTag.find(own(owner)).select("name").lean()]);
    const names = Array.from(new Set([...(used as string[]), ...made.map((t) => t.name)].filter(Boolean))).sort();
    res.status(200).json({ message: "crmTagOptions", data: { data: names.map((n) => ({ _id: n, name: n })) } });
  }),
  createTag: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ name: tag }).safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام برچسب را بنویسید", 400);
    await BizTag.updateOne({ ...own(owner), name: parsed.data.name }, { $setOnInsert: { ...own(owner), name: parsed.data.name } }, { upsert: true });
    res.status(201).json({ message: "crmCreateTag", data: { data: { _id: parsed.data.name, name: parsed.data.name } } });
  }),
  // add / remove tags on several contacts at once
  bulkTag: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({ ids: z.array(z.string().regex(idRe)).min(1).max(5000), add: z.array(tag).max(10).default([]), remove: z.array(tag).max(10).default([]) })
      .safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const f = { ...own(owner), _id: { $in: parsed.data.ids.map(oid) } };
    if (parsed.data.add.length) await BizContact.updateMany(f, { $addToSet: { tags: { $each: parsed.data.add } } });
    if (parsed.data.remove.length) await BizContact.updateMany(f, { $pull: { tags: { $in: parsed.data.remove } } });
    res.status(200).json({ message: "crmBulkTag", data: { count: parsed.data.ids.length } });
  }),

  getTeam: withOwner(ownerOf, async (owner, _req, res) => {
    res.status(200).json({ message: "crmTeam", data: await team(owner) });
  }),

  // ---------------------------------------------------------------- import
  // the file's columns, a few rows and the guessed mapping
  importPreview: withOwner(ownerOf, async (owner, req, res) => {
    const file = fileOf(req);
    if (!file?.buffer?.length) throw new AppError("فایل فهرست بیماران را انتخاب کنید", 400);
    const rows = (await sheetRows(file.buffer, file.originalname || "")).filter((r) => r.some((c) => text(c)));
    if (!rows.length) throw new AppError("فایل خالی است", 400);
    const headers = rows[0].map((h) => text(h));
    const mapping: Record<string, number> = {};
    headers.forEach((h, i) => {
      const g = GUESS.find(([f, re]) => mapping[f] === undefined && re.test(h));
      if (g) mapping[g[0]] = i;
    });
    // a lone «نام» / "Name" column with no family-name column is the full name
    if (mapping.firstName !== undefined && mapping.lastName === undefined && mapping.name === undefined) {
      mapping.name = mapping.firstName;
      delete mapping.firstName;
    }
    res.status(200).json({
      message: "crmImportPreview",
      data: { headers, rows: rows.slice(1, 6).map((r) => r.map(text)), total: rows.length - 1, mapping },
    });
  }),

  // the file again with the chosen mapping: one contact per valid mobile,
  // merged with an existing one of the same number (blanks filled, tags
  // added) - never two of the same phone
  importContacts: withOwner(ownerOf, async (owner, req, res) => {
    const file = fileOf(req);
    if (!file?.buffer?.length) throw new AppError("فایل فهرست بیماران را انتخاب کنید", 400);
    let mapping: Partial<Record<ImportField, number>> = {};
    let tags: string[] = [];
    try {
      mapping = JSON.parse(String(req.body?.mapping || "{}"));
      tags = z.array(tag).max(10).parse(JSON.parse(String(req.body?.tags || "[]")));
    } catch {
      throw new BadInputError();
    }
    if (String(req.body?.consent) !== "true") throw new AppError("تأیید کنید که این افراد بیماران یا مشتریان خود شما هستند", 400);
    if (mapping.phone === undefined) throw new AppError("ستون شماره‌ی موبایل را مشخص کنید", 400);
    const rows = (await sheetRows(file.buffer, file.originalname || "")).slice(1);
    if (rows.length > 20000) throw new AppError("هر بار حداکثر ۲۰٬۰۰۰ ردیف وارد می‌شود", 400);
    const cell = (r: unknown[], f: ImportField) => (mapping[f] === undefined ? "" : text(r[Number(mapping[f])]));
    let invalid = 0;
    const byPhone = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const phone = normalizeMobile(cell(r, "phone"));
      if (!phone) {
        if (r.some((c) => text(c))) invalid++;
        continue;
      }
      const name = (cell(r, "name") || `${cell(r, "firstName")} ${cell(r, "lastName")}`).trim().slice(0, 200);
      const birth = birthOf(cell(r, "birthDate"));
      const rowTags = cell(r, "tags")
        .split(/[,،|;]/)
        .map((t) => t.trim().slice(0, 40))
        .filter(Boolean);
      const prev = byPhone.get(phone);
      const next: Record<string, unknown> = {
        phone,
        name,
        gender: genderOf(cell(r, "gender")),
        city: cell(r, "city").slice(0, 100) || undefined,
        insurer: insurerOf(cell(r, "insurer")),
        note: cell(r, "note").slice(0, 1000) || undefined,
        ...(birth ? { birthDate: birth, birthYear: birth.getUTCFullYear(), birthMD: jalaliMD(birth) } : {}),
        tags: Array.from(new Set([...tags, ...rowTags])).slice(0, 20),
      };
      // the same number twice in the file: one contact, blanks filled, tags joined
      if (prev) {
        for (const [k, v] of Object.entries(next)) if (v !== undefined && v !== "" && (prev[k] === undefined || prev[k] === "")) prev[k] = v;
        prev.tags = Array.from(new Set([...(prev.tags as string[]), ...(next.tags as string[])])).slice(0, 20);
      } else byPhone.set(phone, next);
    }
    const phones = [...byPhone.keys()];
    const existing = new Map(
      (await BizContact.find({ ...own(owner), phone: { $in: phones } }).lean<IBizContact[]>()).map((c) => [c.phone, c]),
    );
    const ops: mongoose.AnyBulkWriteOperation[] = [];
    let created = 0;
    let updated = 0;
    for (const [phone, d] of byPhone) {
      const ex = existing.get(phone);
      const fill: Record<string, unknown> = {};
      for (const k of ["name", "gender", "city", "insurer", "note", "birthDate", "birthYear", "birthMD"])
        if (d[k] !== undefined && d[k] !== "" && (!ex || !(ex as unknown as Record<string, unknown>)[k])) fill[k] = d[k];
      if (ex) {
        updated++;
        ops.push({ updateOne: { filter: { _id: ex._id }, update: { $set: fill, $addToSet: { tags: { $each: d.tags as string[] } } } } });
      } else {
        created++;
        ops.push({
          insertOne: {
            document: {
              ...own(owner),
              ...fill,
              phone,
              tags: d.tags,
              source: "import",
              consentAt: new Date(),
              optCode: newOptCode(),
              visits: 0,
              orders: 0,
              spent: 0,
              noShows: 0,
              smsOptOut: false,
              isActive: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        });
      }
    }
    if (ops.length) await BizContact.collection.bulkWrite(ops as never, { ordered: false });
    // the new ones' Noyan users are asked to link them (never linked here)
    offerNewContactsLater(owner, [...byPhone.keys()].filter((p) => !existing.has(p)));
    res.status(200).json({ message: "crmImported", data: { created, updated, invalid, duplicates: rows.length - invalid - byPhone.size } });
  }),

  // ---------------------------------------------------------------- follow-ups
  getFollowUps: withOwner(ownerOf, async (owner, req, res) => {
    const q = z
      .object({
        status: z.enum(["open", "done", "all"]).default("open"),
        due: z.enum(["overdue", "today", "week"]).optional(),
        assignee: z.string().max(30).optional(),
        contact: z.string().regex(idRe).optional(),
      })
      .safeParse(req.query);
    if (!q.success) throw new BadInputError();
    // today in Tehran (Lib/tehranTime.ts)
    const start = startOfTehranDay();
    const f: Record<string, unknown> = {
      ...own(owner),
      kind: "followUp",
      ...(q.data.status === "open" ? { doneAt: { $exists: false } } : q.data.status === "done" ? { doneAt: { $exists: true } } : {}),
      ...(q.data.due === "overdue" ? { dueAt: { $lt: start } } : {}),
      ...(q.data.due === "today" ? { dueAt: { $lt: addTehranDays(start, 1) } } : {}),
      ...(q.data.due === "week" ? { dueAt: { $lt: new Date(+start + 7 * DAY) } } : {}),
      ...(q.data.assignee === "me" ? { assignee: req.user?._id } : q.data.assignee && idRe.test(q.data.assignee) ? { assignee: oid(q.data.assignee) } : {}),
      ...(q.data.contact ? { contact: oid(q.data.contact) } : {}),
    };
    const rows = await BizActivity.find(f)
      .sort(q.data.status === "done" ? { doneAt: -1 } : { dueAt: 1 })
      .limit(300)
      .populate("contact", "name phone")
      .lean();
    res.status(200).json({ message: "crmFollowUps", data: rows });
  }),

  createFollowUp: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({ contact: z.string().regex(idRe), text: z.string().trim().min(2).max(1000), dueAt: day, assignee: z.string().regex(idRe).nullable().optional() })
      .safeParse(req.body || {});
    if (!parsed.success) throw new AppError("متن و تاریخ پیگیری را بنویسید", 400);
    if (!(await BizContact.exists({ ...own(owner), _id: parsed.data.contact }))) throw new NotFoundError();
    if (parsed.data.assignee && !(await team(owner)).some((m) => m._id === parsed.data.assignee))
      throw new AppError("این شخص عضو تیم این بخش نیست", 400);
    const a = await BizActivity.create({
      ...own(owner),
      contact: parsed.data.contact,
      kind: "followUp",
      text: parsed.data.text,
      dueAt: new Date(`${parsed.data.dueAt}T09:00:00`),
      ...(parsed.data.assignee ? { assignee: parsed.data.assignee } : {}),
      createdBy: req.user?._id,
    });
    res.status(201).json({ message: "crmCreateFollowUp", data: a });
  }),

  updateFollowUp: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        done: z.boolean().optional(),
        text: z.string().trim().min(2).max(1000).optional(),
        dueAt: day.optional(),
        assignee: z.string().regex(idRe).nullable().optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.activityId)) throw new BadInputError();
    const d = parsed.data;
    if (d.assignee && !(await team(owner)).some((m) => m._id === d.assignee)) throw new AppError("این شخص عضو تیم این بخش نیست", 400);
    const set: Record<string, unknown> = {
      ...(d.done === true ? { doneAt: new Date() } : {}),
      ...(d.text ? { text: d.text } : {}),
      ...(d.dueAt ? { dueAt: new Date(`${d.dueAt}T09:00:00`) } : {}),
      ...(d.assignee ? { assignee: d.assignee } : {}),
    };
    const unset: Record<string, 1> = {
      ...(d.done === false ? { doneAt: 1 } : {}),
      ...(d.dueAt ? { remindedAt: 1 } : {}),
      ...(d.assignee === null ? { assignee: 1 } : {}),
    };
    const a = await BizActivity.findOneAndUpdate(
      { ...own(owner), _id: req.params.activityId, kind: "followUp" },
      { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { new: true },
    ).lean();
    if (!a) throw new NotFoundError();
    res.status(200).json({ message: "crmUpdateFollowUp", data: a });
  }),

  // ---------------------------------------------------------------- segments
  // the saved segments and the ready-made ones, each with its live count
  getSegments: withOwner(ownerOf, async (owner, _req, res) => {
    await syncContacts(owner);
    const base = { ...own(owner), isActive: { $ne: false } };
    const saved = await BizSegment.find(own(owner)).sort({ name: 1 }).lean();
    const count = async (rules: Record<string, unknown>) => BizContact.countDocuments({ $and: [base, await rulesFilter(owner, rules)] });
    const reach = async (rules: Record<string, unknown>) =>
      BizContact.countDocuments({ $and: [base, { smsOptOut: { $ne: true } }, await rulesFilter(owner, rules)] });
    const presets = await Promise.all(
      Object.entries(presetSegments).map(async ([id, rules]) => ({ _id: `preset:${id}`, preset: id, rules, count: await count(rules), reachable: await reach(rules) })),
    );
    const own_ = await Promise.all(saved.map(async (s) => ({ ...s, count: await count(s.rules || {}), reachable: await reach(s.rules || {}) })));
    res.status(200).json({ message: "crmSegments", data: { presets, saved: own_ } });
  }),
  countSegment: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = rulesBody.safeParse(req.body?.rules || {});
    if (!parsed.success) throw new BadInputError();
    const rules = cleanRules(parsed.data);
    const f = { $and: [{ ...own(owner), isActive: { $ne: false } }, await rulesFilter(owner, rules)] };
    const [count, reachable, sample] = await Promise.all([
      BizContact.countDocuments(f),
      BizContact.countDocuments({ $and: [f, { smsOptOut: { $ne: true } }] }),
      BizContact.find(f).sort({ lastSeenAt: -1 }).limit(5).select("name phone").lean(),
    ]);
    res.status(200).json({ message: "crmSegmentCount", data: { count, reachable, sample } });
  }),
  saveSegment: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ name: z.string().trim().min(2).max(80), rules: rulesBody }).safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام بخش را بنویسید", 400);
    const id = req.params.segmentId;
    const data = { name: parsed.data.name, rules: cleanRules(parsed.data.rules) };
    try {
      const seg = id
        ? await BizSegment.findOneAndUpdate({ ...own(owner), _id: isValidObjectId(id) ? id : null }, { $set: data }, { new: true }).lean()
        : await BizSegment.create({ ...own(owner), ...data, createdBy: req.user?._id });
      if (!seg) throw new NotFoundError();
      res.status(id ? 200 : 201).json({ message: "crmSaveSegment", data: seg });
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) throw new AppError("بخشی با همین نام هست", 400);
      throw err;
    }
  }),
  deleteSegment: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.segmentId)) throw new NotFoundError();
    const inUse = await BizCampaign.exists({ ...own(owner), "audience.segment": req.params.segmentId, status: { $in: ["Pending", "Approved", "Sending"] } });
    if (inUse) throw new AppError("کمپینی در صف ارسال از این بخش استفاده می‌کند", 400);
    await BizSegment.deleteOne({ ...own(owner), _id: req.params.segmentId });
    res.status(200).json({ message: "crmDeleteSegment" });
  }),

  // ---------------------------------------------------------------- templates
  getTemplates: withOwner(ownerOf, async (owner, _req, res) => {
    const rows = await BizTemplate.find(own(owner)).sort({ createdAt: -1 }).limit(200).lean<IBizTemplate[]>();
    const used = await BizAutomation.aggregate([{ $match: { ...own(owner), template: { $exists: true } } }, { $group: { _id: "$template", n: { $sum: 1 } } }]);
    const usedBy = new Map(used.map((u: { _id: unknown; n: number }) => [String(u._id), u.n]));
    res.status(200).json({ message: "crmTemplates", data: rows.map((t) => ({ ...t, automations: usedBy.get(String(t._id)) || 0 })) });
  }),
  // the filled text a recipient would get, its length and SMS parts
  previewTemplate: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ text: z.string().max(700).default("") }).safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const sample = await BizContact.findOne({ ...own(owner), name: { $ne: "" } }).sort({ lastSeenAt: -1 }).select("name lastVisitAt").lean<IBizContact>();
    const preview = parsed.data.text.trim() ? await previewText(owner, parsed.data.text, sample || { name: "" }) : "";
    res.status(200).json({ message: "crmTemplatePreview", data: { preview, chars: [...preview].length, parts: preview ? smsParts(preview) : 0 } });
  }),
  saveTemplate: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = templateBody.safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام قالب و متن پیامک (دست‌کم ۵ نویسه) را بنویسید", 400);
    const id = req.params.templateId;
    if (!id) {
      const t = await BizTemplate.create({ ...own(owner), ...parsed.data, createdBy: req.user?._id });
      return res.status(201).json({ message: "crmSaveTemplate", data: t });
    }
    if (!isValidObjectId(id)) throw new NotFoundError();
    const old = await BizTemplate.findOne({ ...own(owner), _id: id }).lean<IBizTemplate>();
    if (!old) throw new NotFoundError();
    if (old.status === "Pending" && old.text !== parsed.data.text) throw new AppError("متن قالب در انتظار تأیید است؛ پس از بررسی ویرایش کنید", 400);
    // a new text is a new request: back to a draft (its automations pause)
    const changed = old.text !== parsed.data.text;
    const t = await BizTemplate.findOneAndUpdate(
      { _id: id },
      { $set: { ...parsed.data, ...(changed ? { status: "Draft" } : {}) }, ...(changed ? { $unset: { rejectReason: 1, decidedAt: 1, decidedBy: 1 } } : {}) },
      { new: true },
    ).lean();
    res.status(200).json({ message: "crmSaveTemplate", data: t });
  }),
  submitTemplate: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.templateId)) throw new NotFoundError();
    const t = await BizTemplate.findOneAndUpdate(
      { ...own(owner), _id: req.params.templateId, status: { $in: ["Draft", "Rejected"] } },
      { $set: { status: "Pending", submittedAt: new Date() }, $unset: { rejectReason: 1, decidedAt: 1 } },
      { new: true },
    ).lean<IBizTemplate>();
    if (!t) throw new AppError("این قالب قبلاً برای تأیید فرستاده شده است", 400);
    const info = await orgInfo(owner);
    notifyUserAlertSubscribers(
      "newSmsCampaign",
      { title: "قالب پیامک برای تأیید", message: `«${t.name}» از ${info.name}` },
      { requestId: String(t._id), name: info.name },
    ).catch((err) => console.log("[crm] alert failed:", err));
    res.status(200).json({ message: "crmSubmitTemplate", data: t });
  }),
  deleteTemplate: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.templateId)) throw new NotFoundError();
    if (await BizAutomation.exists({ ...own(owner), template: req.params.templateId }))
      throw new AppError("یک خودکارسازی از این قالب استفاده می‌کند؛ اول قالب آن را عوض کنید", 400);
    await BizTemplate.deleteOne({ ...own(owner), _id: req.params.templateId });
    res.status(200).json({ message: "crmDeleteTemplate" });
  }),

  // ---------------------------------------------------------------- automations
  getAutomations: withOwner(ownerOf, async (owner, _req, res) => {
    const rows = await BizAutomation.find(own(owner)).sort({ createdAt: 1 }).populate("template", "name status text").lean<IBizAutomation[]>();
    const since = new Date(Date.now() - 30 * DAY);
    const stats = await BizMessage.aggregate([
      { $match: { ...own(owner), source: "automation", createdAt: { $gte: since } } },
      {
        $group: {
          _id: "$automation",
          sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $gt: ["$clicks", 0] }, 1, 0] } },
          booked: { $sum: { $cond: [{ $ifNull: ["$bookedAt", false] }, 1, 0] } },
        },
      },
    ]);
    const by = new Map(stats.map((s: { _id: unknown }) => [String(s._id), s]));
    res.status(200).json({ message: "crmAutomations", data: rows.map((a) => ({ ...a, last30: by.get(String(a._id)) || { sent: 0, clicked: 0, booked: 0 } })) });
  }),
  createAutomation: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ kind: z.enum(bizAutomationKinds), name: z.string().trim().min(2).max(80) }).safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const d = automationDefaults[parsed.data.kind];
    const a = await BizAutomation.create({
      ...own(owner),
      kind: parsed.data.kind,
      name: parsed.data.name,
      delay: d.delay,
      gapDays: d.gapDays,
      oncePerYear: d.oncePerYear,
      createdBy: req.user?._id,
    });
    res.status(201).json({ message: "crmCreateAutomation", data: a });
  }),
  updateAutomation: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = automationBody.safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.automationId)) throw new AppError("تنظیمات خودکارسازی کامل نیست", 400);
    const d = parsed.data;
    if (d.windowUntil <= d.windowFrom) throw new AppError("پایان بازه‌ی ارسال باید بعد از شروع آن باشد", 400);
    if (d.template && !(await BizTemplate.exists({ ...own(owner), _id: d.template }))) throw new NotFoundError();
    const a = await BizAutomation.findOneAndUpdate(
      { ...own(owner), _id: req.params.automationId },
      {
        $set: { ...d, audience: cleanRules(d.audience), ...(d.template ? { template: d.template } : {}) },
        ...(d.template ? {} : { $unset: { template: 1 } }),
      },
      { new: true },
    ).lean<IBizAutomation>();
    if (!a) throw new NotFoundError();
    if (a.kind === "chronic" && !a.audience?.tags?.length && a.enabled)
      await BizAutomation.updateOne({ _id: a._id }, { $set: { enabled: false } });
    res.status(200).json({ message: "crmUpdateAutomation", data: a });
  }),
  // on / off: on needs an approved template (and, for chronic, its tags)
  toggleAutomation: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.automationId)) throw new BadInputError();
    const a = await BizAutomation.findOne({ ...own(owner), _id: req.params.automationId }).lean<IBizAutomation>();
    if (!a) throw new NotFoundError();
    if (parsed.data.enabled) {
      const t = a.template ? await BizTemplate.findOne({ ...own(owner), _id: a.template }).select("status").lean<IBizTemplate>() : null;
      if (!t) throw new AppError("اول یک قالب پیامک برای این خودکارسازی انتخاب کنید", 400);
      if (t.status !== "Approved") throw new AppError("قالب پیامک این خودکارسازی هنوز تأیید نشده است", 400);
      if (a.kind === "chronic" && !a.audience?.tags?.length) throw new AppError("برای پیگیری بیماران مزمن، برچسب بیماری را انتخاب کنید", 400);
    }
    const out = await BizAutomation.findOneAndUpdate(
      { _id: a._id },
      { $set: { enabled: parsed.data.enabled, ...(parsed.data.enabled && !a.enabled ? { enabledAt: new Date() } : {}) } },
      { new: true },
    ).lean();
    res.status(200).json({ message: "crmToggleAutomation", data: out });
  }),
  deleteAutomation: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.automationId)) throw new NotFoundError();
    await BizAutomation.deleteOne({ ...own(owner), _id: req.params.automationId });
    res.status(200).json({ message: "crmDeleteAutomation" });
  }),
  // who it reaches now and in the coming week, and its log
  getAutomation: withOwner(ownerOf, async (owner, req, res) => {
    if (!isValidObjectId(req.params.automationId)) throw new NotFoundError();
    const a = await BizAutomation.findOne({ ...own(owner), _id: req.params.automationId }).populate("template", "name status text").lean<IBizAutomation>();
    if (!a) throw new NotFoundError();
    const probe = { ...a, enabledAt: a.enabled ? a.enabledAt : new Date() } as IBizAutomation;
    const [now, week, log] = await Promise.all([
      dueCandidates(probe).catch(() => []),
      dueCandidates(probe, { horizonMs: 7 * DAY }).catch(() => []),
      BizMessage.find({ automation: a._id })
        .sort({ _id: -1 })
        .limit(100)
        .select("contact phone status reason clicks bookedAt sentAt createdAt")
        .populate("contact", "name")
        .lean(),
    ]);
    res.status(200).json({
      message: "crmAutomation",
      data: {
        automation: a,
        dueNow: now.length,
        dueWeek: week.length,
        upcoming: week.slice(0, 10).map((c) => ({ name: c.contact.name, phone: c.contact.phone, dueAt: c.dueAt })),
        log,
        inWindow: inOwnWindow(a.windowFrom, a.windowUntil),
      },
    });
  }),

  // ---------------------------------------------------------------- one-off
  // one approved template to one contact, now (inside the send window)
  sendToContact: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ template: z.string().regex(idRe) }).safeParse(req.body || {});
    if (!parsed.success || !isValidObjectId(req.params.contactId)) throw new AppError("یک قالب تأییدشده انتخاب کنید", 400);
    const [c, t] = await Promise.all([
      BizContact.findOne({ ...own(owner), _id: req.params.contactId }).lean<IBizContact>(),
      BizTemplate.findOne({ ...own(owner), _id: parsed.data.template }).lean<IBizTemplate>(),
    ]);
    if (!c || !t) throw new NotFoundError();
    if (t.status !== "Approved") throw new AppError("فقط قالب تأییدشده فرستاده می‌شود", 400);
    if (c.smsOptOut || !c.isActive) throw new AppError("این مخاطب پیامک تبلیغاتی نمی‌خواهد", 400);
    if (!inOwnWindow()) throw new AppError("پیامک فقط بین ساعت ۸ تا ۲۱ فرستاده می‌شود", 400);
    const SmsOptOut = mongoose.model("SmsOptOut");
    if (await SmsOptOut.exists({ phone: c.phone })) throw new AppError("این مخاطب پیامک تبلیغاتی نمی‌خواهد", 400);
    const [info, base] = await Promise.all([orgInfo(owner), siteBase()]);
    const code = randomCode(6);
    let link = "";
    if (/\{(link|review)\}/.test(t.text)) {
      const token = await newTrackedLink(await orgPublicUrl(owner, base));
      link = token ? trackedUrl(base, token, code) : "";
    }
    const body = messageFor(renderText(t.text, varsFor(c, info.name, link)), base, c.optCode);
    const parts = smsParts(body);
    const price = await unitPrice();
    const fromQuota = await takeQuota(owner, parts, await monthlyQuota(owner));
    const cost = (parts - fromQuota) * price;
    let payer: WalletScope | null = null;
    if (cost > 0) {
      payer = await spendOnSms(owner, info.user, cost);
      if (!payer) {
        await giveQuota(owner, fromQuota);
        throw new AppError("موجودی کیف پول برای این پیامک کافی نیست؛ کیف پول را شارژ کنید", 400);
      }
    }
    // one of the same template to the same contact a day, however many clicks
    const row = await BizMessage.create({
      ...own(owner),
      contact: c._id,
      phone: c.phone,
      source: "single",
      template: t._id,
      dedupeKey: `single:${c._id}:${t._id}:${tehranYmd()}`,
      text: body,
      parts,
      code,
    }).catch(() => null);
    const refund = async () => {
      if (cost > 0 && payer) await creditScope(payer, cost);
      await giveQuota(owner, fromQuota);
    };
    if (!row) {
      await refund();
      throw new AppError("این قالب امروز برای این مخاطب فرستاده شده است", 400);
    }
    const r = await sendOne(c.phone, body);
    await BizMessage.updateOne({ _id: row._id }, { $set: r.ok ? { status: "sent", sentAt: new Date(), outboxId: r.outboxId } : { status: "failed", reason: "gateway" } });
    if (!r.ok) {
      await refund();
      throw new AppError("ارسال پیامک ناموفق بود؛ دوباره تلاش کنید", 502);
    }
    if (cost > 0) await walletTx(owner, row._id, info.user, -cost, "smsMessage", payer).catch(() => {});
    res.status(200).json({ message: "crmSentToContact", data: { parts, cost } });
  }),
});

// ---------------------------------------------------------------- super admin

// GET /admin/sms-templates/:id - a template waiting in /requests: who wrote
// it, its text filled with a sample patient, and what uses it
export const adminGetTemplate: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  if (!isValidObjectId(req.params.id)) throw new NotFoundError();
  const t = await BizTemplate.findById(req.params.id).lean<IBizTemplate>();
  if (!t) throw new NotFoundError();
  const owner = { kind: t.ownerKind, id: String(t.ownerId) } as BizOwner;
  const [info, preview, automations] = await Promise.all([
    orgInfo(owner).catch(() => ({ name: "" })),
    previewText(owner, t.text),
    BizAutomation.find({ template: t._id }).select("kind name enabled").lean(),
  ]);
  res.status(200).json({ message: "adminSmsTemplate", data: { ...t, ownerName: info.name, preview, automations } });
});

// POST /admin/sms-templates/:id/approve
export const adminApproveTemplate: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  if (!isValidObjectId(req.params.id)) throw new NotFoundError();
  res.status(200).json({ message: "adminApproveSmsTemplate", data: await approveTemplateText(req.params.id, req.user?._id) });
});

