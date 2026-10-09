import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import BizContact, { IBizContact } from "../Models/BizContact";
import BizSegment from "../Models/BizSegment";
import BizTemplate from "../Models/BizTemplate";
import BizInvoice from "../Models/BizInvoice";
import BizItem from "../Models/BizItem";
import BizClubSettings, { bizClubTierKeys } from "../Models/BizClubSettings";
import BizClubReward, { bizRewardKinds } from "../Models/BizClubReward";
import BizClubRedemption from "../Models/BizClubRedemption";
import BizClubAdjustment from "../Models/BizClubAdjustment";
import BizSequence, { bizSequenceChannels, IBizSequence } from "../Models/BizSequence";
import BizSequenceEnrollment from "../Models/BizSequenceEnrollment";
import BizKbCategory from "../Models/BizKbCategory";
import BizKbArticle, { IBizKbArticle } from "../Models/BizKbArticle";
import BizQuiz, { IBizQuiz } from "../Models/BizQuiz";
import BizQuizAssignment from "../Models/BizQuizAssignment";
import BizQuizAttempt, { IBizQuizAttempt } from "../Models/BizQuizAttempt";
import BizFlow, { bizFlowActions, bizFlowFields, bizFlowOps, bizFlowStepKinds, bizFlowTriggers, IBizFlow } from "../Models/BizFlow";
import BizFlowRun from "../Models/BizFlowRun";
import BizRequest, { IBizRequest } from "../Models/BizRequest";
import { myPendingCount } from "../Lib/business/kartabl";
import BizReturn, { bizReturnActions, bizReturnKinds, bizReturnStatuses } from "../Models/BizReturn";
import { BizOwner } from "../Lib/business/coa";
import { presetSegments, rulesFilter, syncContacts } from "../Lib/business/crm";
import { orgInfo } from "../Lib/business/campaign";
import { crmLink, idRe, isId, isOwnerUser, notify, oid, own, team } from "../Lib/business/crmService/common";
import {
  adjustPoints,
  applyCode,
  cancelRedemption,
  clubSettings,
  memberOf,
  memberRows,
  reconcileRedemptions,
  redeemReward,
  sortedTiers,
  tierDiscountCode,
  unapplyCode,
} from "../Lib/business/crmService/club";
import { enrollContacts, MAX_BULK, stopEnrollment } from "../Lib/business/crmService/sequence";
import { forTaker, gradeQuiz, myQuizzes, quizAssignedStatus } from "../Lib/business/crmService/quiz";
import { cancelRun, fireFlows, startManualRun } from "../Lib/business/crmService/flow";
import { cancelReturn, createReturn, processReturn, STOCK_KINDS, voidReturn } from "../Lib/business/crmService/returns";
import BizChecklist from "../Models/BizChecklist";
import BizChecklistItem from "../Models/BizChecklistItem";
import { partOn } from "../Lib/business/crmService/profiles";
import { OwnerOf } from "./businessController";
import { flowTriggerOn } from "../Lib/business/crmProfiles";

// The CRM's engagement and service API under /<panel>/crm (2026-10,
// docs/nexxa-crm-engagement-parity.md): the loyalty club, sequences, the
// staff knowledge base and quizzes, workflows with their runs, the inbox,
// and returns. Routers/crmServiceRoutes.ts guards each route (readCrm,
// manageCrm, sendCampaigns); every query is scoped to the panel's owner.

const withOwner = (ownerOf: OwnerOf, fn: (owner: BizOwner, req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const owner = ownerOf(req);
    if (!owner?.id) return next(new NotFoundError());
    await fn(owner, req, res);
  });
const me = (req: Request) => (req.user?._id ? String(req.user._id) : "");
const param = (req: Request, k: string) => {
  const v = req.params[k];
  if (!isId(v)) throw new NotFoundError();
  return v;
};
const id = z.string().regex(idRe);
const optId = id.nullable().optional();
const day = z.coerce.date();
const ok = (res: Response, message: string, data?: unknown, code = 200) => res.status(code).json({ message, ...(data !== undefined ? { data } : {}) });
const dupe = (err: unknown) => (err as { code?: number })?.code === 11000;

// ---------------------------------------------------------------- bodies

const clubBody = z.object({
  enabled: z.boolean(),
  pointUnit: z.coerce.number().int().min(1000).max(100_000_000),
  codeDays: z.coerce.number().int().min(1).max(365),
  tiers: z
    .array(z.object({ key: z.enum(bizClubTierKeys), min: z.coerce.number().min(0), discount: z.coerce.number().min(0).max(100) }))
    .length(5),
});
const rewardBody = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional().nullable(),
  points: z.coerce.number().int().min(1).max(1_000_000),
  kind: z.enum(bizRewardKinds),
  value: z.coerce.number().min(1),
  maxDiscount: z.coerce.number().min(0).default(0),
  active: z.boolean().default(true),
});
const stepBody = z.object({
  _id: id.optional(),
  channel: z.enum(bizSequenceChannels),
  waitDays: z.coerce.number().int().min(0).max(365),
  template: optId,
  text: z.string().trim().max(500).optional().nullable(),
  assignee: optId,
});
const conditionBody = z.object({ field: z.enum(bizFlowFields), op: z.enum(bizFlowOps), value: z.string().max(200).optional().nullable() });
const flowStepBody = z.object({
  kind: z.enum(bizFlowStepKinds),
  conditions: z.array(conditionBody).max(10).optional(),
  days: z.coerce.number().int().min(0).max(365).optional(),
  hours: z.coerce.number().int().min(0).max(23).optional(),
  approver: optId,
  title: z.string().trim().max(200).optional().nullable(),
  onReject: z.enum(["stop", "continue"]).optional(),
  action: z.enum(bizFlowActions).optional(),
  template: optId,
  text: z.string().trim().max(500).optional().nullable(),
  tag: z.string().trim().max(40).optional().nullable(),
  dueDays: z.coerce.number().int().min(0).max(365).optional(),
  assignee: optId,
  sequence: optId,
  project: optId,
  points: z.coerce.number().int().min(-100_000).max(100_000).optional(),
});
const flowBody = z.object({
  name: z.string().trim().min(2).max(80),
  trigger: z.enum(bizFlowTriggers),
  filters: z.array(conditionBody).max(10).default([]),
  steps: z.array(flowStepBody).max(30).default([]),
});
const articleBody = z.object({
  title: z.string().trim().min(2).max(160),
  content: z.string().trim().min(2).max(50_000),
  category: optId,
  published: z.boolean().default(false),
});
const questionBody = z.object({
  text: z.string().trim().min(1).max(500),
  options: z.array(z.string().trim().min(1).max(300)).min(2).max(8),
  correct: z.array(z.coerce.number().int().min(0)).min(1),
});
const quizBody = z.object({
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1000).optional().nullable(),
  article: optId,
  passScore: z.coerce.number().int().min(0).max(100).default(70),
  questions: z.array(questionBody).min(1).max(100),
});

// nulls out empty ids and strings (a cleared select)
const clean = <T extends Record<string, unknown>>(o: T) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== "") out[k] = v;
  return out as Partial<T>;
};

// the step's references must be the owner's own
const checkRefs = async (owner: BizOwner, refs: { templates: string[]; users: string[]; sequences?: string[] }) => {
  const members = new Set((await team(owner)).map((m) => m._id));
  if (refs.users.some((u) => !members.has(u))) throw new AppError("این شخص عضو تیم این بخش نیست", 400);
  const t = Array.from(new Set(refs.templates));
  if (t.length && (await BizTemplate.countDocuments({ ...own(owner), _id: { $in: t.map(oid) } })) !== t.length) throw new NotFoundError();
  const s = Array.from(new Set(refs.sequences || []));
  if (s.length && (await BizSequence.countDocuments({ ...own(owner), _id: { $in: s.map(oid) } })) !== s.length) throw new NotFoundError();
};

// the audience of a bulk enrollment: given contacts, a saved segment or a ready-made one
const audienceIds = async (owner: BizOwner, body: { contacts?: string[]; segment?: string }) => {
  if (body.contacts?.length) return body.contacts.slice(0, MAX_BULK);
  if (!body.segment) return [];
  await syncContacts(owner);
  let rules: Record<string, unknown> | undefined;
  if (body.segment.startsWith("preset:")) rules = presetSegments[body.segment.slice(7)];
  else if (isId(body.segment)) rules = (await BizSegment.findOne({ ...own(owner), _id: body.segment }).lean<{ rules?: Record<string, unknown> }>())?.rules;
  if (!rules) throw new NotFoundError();
  const rows = await BizContact.find({ $and: [{ ...own(owner), isActive: { $ne: false } }, await rulesFilter(owner, rules)] })
    .select("_id")
    .limit(MAX_BULK)
    .lean();
  return rows.map((r) => String(r._id));
};

export const makeCrmServiceController = (ownerOf: OwnerOf) => ({
  // ---------------------------------------------------------------- me
  // what waits for the viewer (the sub-menu's counts)
  getMine: withOwner(ownerOf, async (owner, req, res) => {
    const user = me(req);
    const [inbox, quizzes, attempts] = await Promise.all([
      myPendingCount(owner, user),
      myQuizzes(owner, user),
      BizQuizAttempt.find({ ...own(owner), user, passed: true }).select("quiz").lean<IBizQuizAttempt[]>(),
    ]);
    const passed = new Set(attempts.map((a) => String(a.quiz)));
    const activeQuizzes = await BizQuiz.find({ ...own(owner), _id: { $in: [...quizzes.keys()].map(oid) }, active: true }).select("_id").lean();
    const members = await team(owner);
    ok(res, "crmServiceMine", {
      user,
      profile: owner.kind,
      teamSize: members.length,
      seeded: !!(await BizChecklist.exists(own(owner))) || !!(await BizSequence.exists(own(owner))) || !!(await BizFlow.exists(own(owner))),
      isOwner: await isOwnerUser(owner, user),
      inbox,
      quizzesDue: activeQuizzes.filter((q) => !passed.has(String(q._id))).length,
      goods: STOCK_KINDS.includes(owner.kind),
    });
  }),


  // The profile's starter set (frontend Crm/Service/starters.ts, written in
  // the reader's language): sequences and workflows switched off, checklist
  // templates with their items. Each made once, by name; nothing sends
  // until the owner picks approved templates and switches it on.
  seed: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        sequences: z.array(z.object({ name: z.string().trim().min(2).max(80), steps: z.array(stepBody).max(20) })).max(10).default([]),
        checklists: z.array(z.object({ name: z.string().trim().min(1).max(120), items: z.array(z.string().trim().min(1).max(300)).max(40) })).max(10).default([]),
        flows: z.array(flowBody).max(10).default([]),
      })
      .safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const made = { sequences: 0, checklists: 0, flows: 0 };
    for (const q of parsed.data.sequences) {
      if (await BizSequence.exists({ ...own(owner), name: q.name })) continue;
      await BizSequence.create({ ...own(owner), name: q.name, active: false, steps: q.steps.map((x) => clean(x)), createdBy: req.user?._id });
      made.sequences++;
    }
    if (partOn(owner.kind, "checklists"))
      for (const c of parsed.data.checklists) {
        if (await BizChecklist.exists({ ...own(owner), name: c.name })) continue;
        const list = await BizChecklist.create({ ...own(owner), name: c.name, isTemplate: true, sequence: await BizChecklist.countDocuments(own(owner)), createdBy: req.user?._id });
        await BizChecklistItem.insertMany(c.items.map((title, i) => ({ ...own(owner), list: list._id, title, priority: 0, repeat: "none", sequence: i, createdBy: req.user?._id })));
        made.checklists++;
      }
    for (const f of parsed.data.flows) {
      if (!flowTriggerOn(owner, f.trigger)) continue;
      if (await BizFlow.exists({ ...own(owner), name: f.name })) continue;
      await BizFlow.create({ ...own(owner), name: f.name, trigger: f.trigger, filters: f.filters.map((c) => clean(c)), steps: f.steps.map((x) => clean(x)), active: false, createdBy: req.user?._id });
      made.flows++;
    }
    ok(res, "crmServiceSeed", made, 201);
  }),

  // ---------------------------------------------------------------- club
  getClub: withOwner(ownerOf, async (owner, _req, res) => {
    await syncContacts(owner);
    await reconcileRedemptions(owner);
    const [settings, rewards, contacts, open] = await Promise.all([
      clubSettings(owner),
      BizClubReward.find(own(owner)).sort({ points: 1 }).lean(),
      BizContact.find({ ...own(owner), isActive: { $ne: false } }).select("phone spent").limit(20000).lean<IBizContact[]>(),
      BizClubRedemption.aggregate([{ $match: { ...own(owner) } }, { $group: { _id: "$status", n: { $sum: 1 }, amount: { $sum: "$discountAmount" } } }]),
    ]);
    const rows = await memberRows(owner, contacts, settings);
    const members = rows.filter((r) => r.total > 0 || r.adjusted > 0);
    const byTier = Object.fromEntries(settings.tiers.map((t) => [t.key, members.filter((m) => m.tier === t.key).length]));
    ok(res, "crmClub", {
      settings,
      rewards,
      stats: {
        members: members.length,
        byTier,
        points: members.reduce((s, m) => s + m.balance, 0),
        redemptions: Object.fromEntries(open.map((o: { _id: string; n: number; amount: number }) => [o._id, { n: o.n, amount: o.amount }])),
      },
    });
  }),
  saveClubSettings: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = clubBody.safeParse(req.body || {});
    if (!parsed.success) throw new AppError("تنظیمات باشگاه کامل نیست", 400);
    const tiers = sortedTiers(parsed.data.tiers);
    if (new Set(tiers.map((t) => t.key)).size !== 5) throw new BadInputError();
    // each tier from a larger total than the one below it; the base from zero
    for (let i = 0; i < tiers.length - 1; i++)
      if (tiers[i].min <= tiers[i + 1].min) throw new AppError("آستانه‌ی هر سطح باید از سطح پایین‌تر بیشتر باشد", 400);
    tiers[tiers.length - 1].min = 0;
    const s = await BizClubSettings.findOneAndUpdate(own(owner), { $set: { ...parsed.data, tiers }, $setOnInsert: own(owner) }, { upsert: true, new: true }).lean();
    ok(res, "crmClubSettings", s);
  }),
  saveReward: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = rewardBody.safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام، امتیاز و مقدار جایزه را بنویسید", 400);
    if (parsed.data.kind === "percent" && parsed.data.value > 100) throw new AppError("درصد تخفیف بیش از ۱۰۰ نمی‌شود", 400);
    const rid = req.params.rewardId;
    if (rid) {
      if (!isId(rid)) throw new NotFoundError();
      const r = await BizClubReward.findOneAndUpdate({ ...own(owner), _id: rid }, { $set: parsed.data }, { new: true }).lean();
      if (!r) throw new NotFoundError();
      return ok(res, "crmSaveReward", r);
    }
    ok(res, "crmSaveReward", await BizClubReward.create({ ...own(owner), ...parsed.data, createdBy: req.user?._id }), 201);
  }),
  // a reward already taken keeps its own copy (name, value), so deleting is safe
  deleteReward: withOwner(ownerOf, async (owner, req, res) => {
    await BizClubReward.deleteOne({ ...own(owner), _id: param(req, "rewardId") });
    ok(res, "crmDeleteReward");
  }),
  getMembers: withOwner(ownerOf, async (owner, req, res) => {
    const q = z.object({ q: z.string().max(60).optional(), tier: z.enum(bizClubTierKeys).optional() }).safeParse(req.query);
    if (!q.success) throw new BadInputError();
    await reconcileRedemptions(owner);
    const settings = await clubSettings(owner);
    const term = q.data.q?.trim();
    const contacts = await BizContact.find({
      ...own(owner),
      isActive: { $ne: false },
      ...(term ? { $or: [{ name: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }, { phone: { $regex: term.replace(/\D/g, "") || "^$" } }] } : {}),
    })
      .select("name phone spent visits orders")
      .limit(5000)
      .lean<IBizContact[]>();
    const rows = (await memberRows(owner, contacts, settings)).filter((r) => (r.total > 0 || r.adjusted > 0) && (!q.data.tier || r.tier === q.data.tier));
    const byId = new Map(contacts.map((c) => [String(c._id), c]));
    rows.sort((a, b) => b.total - a.total);
    ok(
      res,
      "crmClubMembers",
      rows.slice(0, 500).map((r) => ({ ...r, name: byId.get(r.contact)?.name || "", phone: byId.get(r.contact)?.phone || "" })),
    );
  }),
  getMember: withOwner(ownerOf, async (owner, req, res) => {
    await reconcileRedemptions(owner);
    const { contact, row } = await memberOf(owner, param(req, "contactId"));
    const [redemptions, adjustments, rewards, drafts] = await Promise.all([
      BizClubRedemption.find({ ...own(owner), contact: contact._id }).sort({ createdAt: -1 }).limit(100).populate("invoice", "number status").lean(),
      BizClubAdjustment.find({ ...own(owner), contact: contact._id }).sort({ createdAt: -1 }).limit(100).lean(),
      BizClubReward.find({ ...own(owner), active: true }).sort({ points: 1 }).lean(),
      BizInvoice.find({ ...own(owner), origin: "manual", status: "draft", $or: [{ "party.phone": contact.phone }, { "party.phone": { $in: [null, ""] } }] })
        .sort({ createdAt: -1 })
        .limit(20)
        .select("number date total party")
        .lean(),
    ]);
    ok(res, "crmClubMember", { contact, member: row, redemptions, adjustments, rewards, drafts });
  }),
  redeemForMember: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ reward: id }).safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const contactId = param(req, "contactId");
    const r = await redeemReward(owner, contactId, parsed.data.reward, req.user?._id, false);
    await fireFlows(owner, "club.redeemed", { type: "redemption", id: String(r._id), contact: contactId });
    ok(res, "crmClubRedeem", r, 201);
  }),
  tierCode: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "crmClubTierCode", await tierDiscountCode(owner, param(req, "contactId"), req.user?._id), 201);
  }),
  adjust: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ points: z.coerce.number().int().min(-100_000).max(100_000), reason: z.string().trim().min(2).max(200) }).safeParse(req.body || {});
    if (!parsed.success) throw new AppError("امتیاز و دلیل آن را بنویسید", 400);
    ok(res, "crmClubAdjust", await adjustPoints(owner, param(req, "contactId"), parsed.data.points, parsed.data.reason, req.user?._id), 201);
  }),
  // a manual adjustment taken back (not one a workflow gave: that stays with its run)
  deleteAdjustment: withOwner(ownerOf, async (owner, req, res) => {
    const r = await BizClubAdjustment.deleteOne({ ...own(owner), _id: param(req, "adjustmentId"), dedupeKey: { $exists: false } });
    if (!r.deletedCount) throw new NotFoundError();
    ok(res, "crmClubAdjustDelete");
  }),
  getRedemptions: withOwner(ownerOf, async (owner, req, res) => {
    await reconcileRedemptions(owner);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const rows = await BizClubRedemption.find({ ...own(owner), ...(status ? { status } : {}) })
      .sort({ createdAt: -1 })
      .limit(300)
      .populate("contact", "name phone")
      .populate("invoice", "number status")
      .lean();
    ok(res, "crmClubRedemptions", rows);
  }),
  applyRedemption: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ code: z.string().trim().min(4).max(20), invoice: id }).safeParse(req.body || {});
    if (!parsed.success) throw new AppError("کد و صورتحساب را انتخاب کنید", 400);
    ok(res, "crmClubApply", await applyCode(owner, parsed.data.code, parsed.data.invoice));
  }),
  unapplyRedemption: withOwner(ownerOf, async (owner, req, res) => {
    await unapplyCode(owner, param(req, "redemptionId"));
    ok(res, "crmClubUnapply");
  }),
  cancelRedemption: withOwner(ownerOf, async (owner, req, res) => {
    const reason = z.string().trim().max(300).default("").parse(req.body?.reason ?? "");
    await cancelRedemption(owner, param(req, "redemptionId"), reason);
    ok(res, "crmClubCancel");
  }),

  // ---------------------------------------------------------------- sequences
  getSequences: withOwner(ownerOf, async (owner, _req, res) => {
    const rows = await BizSequence.find(own(owner)).sort({ createdAt: -1 }).lean<IBizSequence[]>();
    const stats = await BizSequenceEnrollment.aggregate([
      { $match: { ...own(owner) } },
      { $group: { _id: { s: "$sequence", st: "$status" }, n: { $sum: 1 } } },
    ]);
    const count = (s: unknown, st: string) => stats.find((x: { _id: { s: unknown; st: string } }) => String(x._id.s) === String(s) && x._id.st === st)?.n || 0;
    ok(
      res,
      "crmSequences",
      rows.map((s) => ({ ...s, activeCount: count(s._id, "active"), completed: count(s._id, "completed"), stopped: count(s._id, "stopped") })),
    );
  }),
  createSequence: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ name: z.string().trim().min(2).max(80) }).safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام پیام زنجیره‌ای را بنویسید", 400);
    // a first step to start from (nexxacrm's sample step)
    const s = await BizSequence.create({ ...own(owner), name: parsed.data.name, steps: [{ channel: "sms", waitDays: 0 }], createdBy: req.user?._id });
    ok(res, "crmCreateSequence", s, 201);
  }),
  getSequence: withOwner(ownerOf, async (owner, req, res) => {
    const s = await BizSequence.findOne({ ...own(owner), _id: param(req, "sequenceId") }).lean<IBizSequence>();
    if (!s) throw new NotFoundError();
    const enrollments = await BizSequenceEnrollment.find({ sequence: s._id }).sort({ createdAt: -1 }).limit(300).populate("contact", "name phone").lean();
    ok(res, "crmSequence", { sequence: s, enrollments });
  }),
  updateSequence: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ name: z.string().trim().min(2).max(80).optional(), steps: z.array(stepBody).max(20).optional() }).safeParse(req.body || {});
    if (!parsed.success) throw new AppError("قدم‌های پیام زنجیره‌ای کامل نیست", 400);
    const sid = param(req, "sequenceId");
    const old = await BizSequence.findOne({ ...own(owner), _id: sid }).lean<IBizSequence>();
    if (!old) throw new NotFoundError();
    const steps = parsed.data.steps?.map((s) => clean(s));
    if (steps) {
      await checkRefs(owner, { templates: steps.map((s) => s.template).filter(Boolean) as string[], users: steps.map((s) => s.assignee).filter(Boolean) as string[] });
      if (old.active && !steps.length) throw new AppError("پیام زنجیره‌ای فعال دست‌کم یک قدم لازم دارد", 400);
      if (old.active && steps.some((s) => s.channel === "sms" && !s.template)) throw new AppError("برای هر قدم پیامکی یک قالب تأییدشده انتخاب کنید", 400);
    }
    const s = await BizSequence.findOneAndUpdate(
      { _id: old._id },
      { $set: { ...(parsed.data.name ? { name: parsed.data.name } : {}), ...(steps ? { steps } : {}) } },
      { new: true, runValidators: true },
    ).lean();
    ok(res, "crmUpdateSequence", s);
  }),
  // on needs a step, and every SMS step an approved template
  toggleSequence: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ active: z.boolean() }).safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const s = await BizSequence.findOne({ ...own(owner), _id: param(req, "sequenceId") }).lean<IBizSequence>();
    if (!s) throw new NotFoundError();
    if (parsed.data.active) {
      if (!s.steps.length) throw new AppError("پیام زنجیره‌ای دست‌کم یک قدم لازم دارد", 400);
      const tpl = s.steps.filter((x) => x.channel === "sms").map((x) => x.template);
      if (tpl.some((t) => !t)) throw new AppError("برای هر قدم پیامکی یک قالب تأییدشده انتخاب کنید", 400);
      const approved = await BizTemplate.countDocuments({ ...own(owner), _id: { $in: tpl }, status: "Approved" });
      if (approved !== new Set(tpl.map(String)).size) throw new AppError("قالب پیامک یکی از قدم‌ها هنوز تأیید نشده است", 400);
    }
    ok(res, "crmToggleSequence", await BizSequence.findOneAndUpdate({ _id: s._id }, { $set: { active: parsed.data.active } }, { new: true }).lean());
  }),
  // its patients stop where they are (the history stays)
  deleteSequence: withOwner(ownerOf, async (owner, req, res) => {
    const sid = param(req, "sequenceId");
    const s = await BizSequence.findOneAndDelete({ ...own(owner), _id: sid }).lean();
    if (!s) throw new NotFoundError();
    await BizSequenceEnrollment.updateMany({ sequence: s._id, status: "active" }, { $set: { status: "stopped", stoppedAt: new Date() }, $unset: { nextRunAt: 1 } });
    ok(res, "crmDeleteSequence");
  }),
  enroll: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ contacts: z.array(id).max(MAX_BULK).optional(), segment: z.string().max(40).optional() }).safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const ids = await audienceIds(owner, parsed.data);
    if (!ids.length) throw new AppError("بیماری برای ثبت انتخاب نشده است", 400);
    ok(res, "crmEnroll", await enrollContacts(owner, param(req, "sequenceId"), ids, req.user?._id));
  }),
  stopEnrollment: withOwner(ownerOf, async (owner, req, res) => {
    await stopEnrollment(owner, param(req, "enrollmentId"));
    ok(res, "crmStopEnrollment");
  }),

  // ---------------------------------------------------------------- knowledge
  getKbCategories: withOwner(ownerOf, async (owner, _req, res) => {
    const [cats, counts] = await Promise.all([
      BizKbCategory.find(own(owner)).sort({ name: 1 }).lean(),
      BizKbArticle.aggregate([{ $match: own(owner) }, { $group: { _id: "$category", n: { $sum: 1 } } }]),
    ]);
    const by = new Map(counts.map((c: { _id: unknown; n: number }) => [String(c._id), c.n]));
    // NodesSelector reads data.data
    ok(res, "crmKbCategories", { data: cats.map((c) => ({ ...c, articles: by.get(String(c._id)) || 0 })) });
  }),
  // found or made (the article form's inline "+ category")
  createKbCategory: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام دسته را بنویسید", 400);
    const c = await BizKbCategory.findOneAndUpdate(
      { ...own(owner), name: parsed.data.name },
      { $setOnInsert: { ...own(owner), name: parsed.data.name } },
      { upsert: true, new: true },
    ).lean();
    ok(res, "crmKbCategory", { data: c }, 201);
  }),
  // its articles stay, uncategorised
  deleteKbCategory: withOwner(ownerOf, async (owner, req, res) => {
    const cid = param(req, "categoryId");
    await BizKbArticle.updateMany({ ...own(owner), category: cid }, { $unset: { category: 1 } });
    await BizKbCategory.deleteOne({ ...own(owner), _id: cid });
    ok(res, "crmDeleteKbCategory");
  }),
  // the team sees published articles; `manage` (write) sees drafts too
  getArticles: (manage: boolean) =>
    withOwner(ownerOf, async (owner, req, res) => {
      const q = z.object({ q: z.string().max(80).optional(), category: id.optional() }).safeParse(req.query);
      if (!q.success) throw new BadInputError();
      const term = q.data.q?.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rows = await BizKbArticle.find({
        ...own(owner),
        ...(manage ? {} : { published: true }),
        ...(q.data.category ? { category: q.data.category } : {}),
        ...(term ? { $or: [{ title: { $regex: term, $options: "i" } }, { content: { $regex: term, $options: "i" } }] } : {}),
      })
        .sort({ updatedAt: -1 })
        .limit(300)
        .select("title category published views updatedAt createdAt")
        .populate("category", "name")
        .lean();
      ok(res, "crmKbArticles", rows);
    }),
  getArticle: (manage: boolean) =>
    withOwner(ownerOf, async (owner, req, res) => {
      const f = { ...own(owner), _id: param(req, "articleId"), ...(manage ? {} : { published: true }) };
      const a = manage
        ? await BizKbArticle.findOne(f).populate("category", "name").lean<IBizKbArticle>()
        : await BizKbArticle.findOneAndUpdate(f, { $inc: { views: 1 } }, { new: true }).populate("category", "name").lean<IBizKbArticle>();
      if (!a) throw new NotFoundError();
      const quizzes = await BizQuiz.find({ ...own(owner), article: a._id, active: true }).select("title").lean();
      ok(res, "crmKbArticle", { ...a, quizzes });
    }),
  saveArticle: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = articleBody.safeParse(req.body || {});
    if (!parsed.success) throw new AppError("عنوان و متن مقاله را بنویسید", 400);
    const d = parsed.data;
    if (d.category && !(await BizKbCategory.exists({ ...own(owner), _id: d.category }))) throw new NotFoundError();
    const set = { title: d.title, content: d.content, published: d.published, updatedBy: req.user?._id };
    const aid = req.params.articleId;
    if (aid) {
      if (!isId(aid)) throw new NotFoundError();
      const a = await BizKbArticle.findOneAndUpdate(
        { ...own(owner), _id: aid },
        { $set: { ...set, ...(d.category ? { category: d.category } : {}) }, ...(d.category ? {} : { $unset: { category: 1 } }) },
        { new: true },
      ).lean();
      if (!a) throw new NotFoundError();
      return ok(res, "crmSaveArticle", a);
    }
    ok(res, "crmSaveArticle", await BizKbArticle.create({ ...own(owner), ...set, ...(d.category ? { category: d.category } : {}), createdBy: req.user?._id }), 201);
  }),
  // a quiz that tested it keeps going, without the link
  deleteArticle: withOwner(ownerOf, async (owner, req, res) => {
    const aid = param(req, "articleId");
    const r = await BizKbArticle.deleteOne({ ...own(owner), _id: aid });
    if (!r.deletedCount) throw new NotFoundError();
    await BizQuiz.updateMany({ ...own(owner), article: aid }, { $unset: { article: 1 } });
    ok(res, "crmDeleteArticle");
  }),

  // ---------------------------------------------------------------- quizzes
  // the viewer's own: active quizzes given to them (or to everyone), with
  // their best try and due date
  getMyQuizzes: withOwner(ownerOf, async (owner, req, res) => {
    const user = me(req);
    const due = await myQuizzes(owner, user);
    const [quizzes, attempts] = await Promise.all([
      BizQuiz.find({ ...own(owner), active: true }).select("title description passScore questions article createdAt").lean<IBizQuiz[]>(),
      BizQuizAttempt.find({ ...own(owner), user }).sort({ createdAt: -1 }).lean<IBizQuizAttempt[]>(),
    ]);
    ok(
      res,
      "crmMyQuizzes",
      quizzes.map((q) => {
        const mine = attempts.filter((a) => String(a.quiz) === String(q._id));
        const passed = mine.find((a) => a.passed);
        return {
          _id: q._id,
          title: q.title,
          description: q.description,
          passScore: q.passScore,
          questions: q.questions.length,
          assigned: due.has(String(q._id)),
          dueDate: due.get(String(q._id)) || null,
          attempts: mine.length,
          bestScore: mine.length ? Math.max(...mine.map((a) => a.score)) : null,
          passedAttempt: passed?._id || null,
        };
      }),
    );
  }),
  // to take it: never the right answers
  getQuizToTake: withOwner(ownerOf, async (owner, req, res) => {
    const q = await BizQuiz.findOne({ ...own(owner), _id: param(req, "quizId"), active: true }).lean<IBizQuiz>();
    if (!q) throw new NotFoundError();
    ok(res, "crmQuizTake", forTaker(q));
  }),
  submitAttempt: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ answers: z.array(z.array(z.coerce.number().int().min(0)).max(8)).max(100) }).safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const q = await BizQuiz.findOne({ ...own(owner), _id: param(req, "quizId"), active: true }).lean<IBizQuiz>();
    if (!q) throw new NotFoundError();
    if (!q.questions.length) throw new AppError("این آزمون سؤالی ندارد", 400);
    const g = gradeQuiz(q.questions, parsed.data.answers, q.passScore);
    const at = await BizQuizAttempt.create({ ...own(owner), quiz: q._id, user: req.user?._id, answers: parsed.data.answers, ...g });
    ok(res, "crmQuizAttempt", { _id: at._id, ...g, passScore: q.passScore }, 201);
  }),
  // the certificate of a passed attempt: its own taker, or whoever manages
  getCertificate: (manage: boolean) =>
    withOwner(ownerOf, async (owner, req, res) => {
      const at = await BizQuizAttempt.findOne({ ...own(owner), _id: param(req, "attemptId"), passed: true }).lean<IBizQuizAttempt>();
      if (!at || (!manage && String(at.user) !== me(req))) throw new NotFoundError();
      const [q, members, info] = await Promise.all([BizQuiz.findById(at.quiz).select("title passScore").lean<IBizQuiz>(), team(owner), orgInfo(owner)]);
      ok(res, "crmQuizCertificate", {
        quiz: q?.title || "",
        name: members.find((m) => m._id === String(at.user))?.name || "",
        score: at.score,
        passScore: q?.passScore,
        org: info.name,
        at: at.createdAt,
        code: String(at._id).slice(-8).toUpperCase(),
      });
    }),
  // managing (write): every quiz with its questions and answers
  getQuizzes: withOwner(ownerOf, async (owner, _req, res) => {
    const [rows, assigned, attempts] = await Promise.all([
      BizQuiz.find(own(owner)).sort({ createdAt: -1 }).populate("article", "title").lean<IBizQuiz[]>(),
      BizQuizAssignment.aggregate([{ $match: own(owner) }, { $group: { _id: "$quiz", n: { $sum: 1 } } }]),
      BizQuizAttempt.aggregate([{ $match: own(owner) }, { $group: { _id: "$quiz", n: { $sum: 1 }, passed: { $sum: { $cond: ["$passed", 1, 0] } } } }]),
    ]);
    const a = new Map(assigned.map((x: { _id: unknown; n: number }) => [String(x._id), x.n]));
    const t = new Map(attempts.map((x: { _id: unknown; n: number; passed: number }) => [String(x._id), x]));
    ok(
      res,
      "crmQuizzes",
      rows.map((q) => ({ ...q, assignments: a.get(String(q._id)) || 0, attempts: t.get(String(q._id))?.n || 0, passes: t.get(String(q._id))?.passed || 0 })),
    );
  }),
  getQuiz: withOwner(ownerOf, async (owner, req, res) => {
    const q = await BizQuiz.findOne({ ...own(owner), _id: param(req, "quizId") }).lean<IBizQuiz>();
    if (!q) throw new NotFoundError();
    const [assignments, status] = await Promise.all([
      BizQuizAssignment.find({ ...own(owner), quiz: q._id }).sort({ createdAt: -1 }).lean(),
      quizAssignedStatus(owner, q._id),
    ]);
    ok(res, "crmQuiz", { quiz: q, assignments, status });
  }),
  saveQuiz: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = quizBody.safeParse(req.body || {});
    if (!parsed.success) throw new AppError("عنوان آزمون و دست‌کم یک سؤال با گزینه‌ی درست را بنویسید", 400);
    const d = parsed.data;
    if (d.questions.some((x) => x.correct.some((c) => c >= x.options.length))) throw new AppError("گزینه‌ی درست هر سؤال را انتخاب کنید", 400);
    if (d.article && !(await BizKbArticle.exists({ ...own(owner), _id: d.article }))) throw new NotFoundError();
    const questions = d.questions.map((x) => ({ ...x, correct: Array.from(new Set(x.correct)) }));
    const set = { title: d.title, description: d.description || undefined, passScore: d.passScore, questions };
    const qid = req.params.quizId;
    if (qid) {
      if (!isId(qid)) throw new NotFoundError();
      // questions are rewritten as a whole (nexxacrm updateQuiz)
      const q = await BizQuiz.findOneAndUpdate(
        { ...own(owner), _id: qid },
        { $set: { ...set, ...(d.article ? { article: d.article } : {}) }, ...(d.article ? {} : { $unset: { article: 1 } }) },
        { new: true },
      ).lean();
      if (!q) throw new NotFoundError();
      return ok(res, "crmSaveQuiz", q);
    }
    ok(res, "crmSaveQuiz", await BizQuiz.create({ ...own(owner), ...set, ...(d.article ? { article: d.article } : {}), createdBy: req.user?._id }), 201);
  }),
  toggleQuiz: withOwner(ownerOf, async (owner, req, res) => {
    const q = await BizQuiz.findOne({ ...own(owner), _id: param(req, "quizId") }).select("active").lean<IBizQuiz>();
    if (!q) throw new NotFoundError();
    ok(res, "crmToggleQuiz", await BizQuiz.findOneAndUpdate({ _id: q._id }, { $set: { active: !q.active } }, { new: true }).lean());
  }),
  // with its assignments and attempts (certificates go with it)
  deleteQuiz: withOwner(ownerOf, async (owner, req, res) => {
    const qid = param(req, "quizId");
    const r = await BizQuiz.deleteOne({ ...own(owner), _id: qid });
    if (!r.deletedCount) throw new NotFoundError();
    await Promise.all([BizQuizAssignment.deleteMany({ ...own(owner), quiz: qid }), BizQuizAttempt.deleteMany({ ...own(owner), quiz: qid })]);
    ok(res, "crmDeleteQuiz");
  }),
  assignQuiz: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ scope: z.enum(["all", "user"]), user: optId, dueDate: day.optional().nullable() }).safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const qid = param(req, "quizId");
    if (!(await BizQuiz.exists({ ...own(owner), _id: qid }))) throw new NotFoundError();
    const d = parsed.data;
    if (d.scope === "user") {
      if (!d.user) throw new AppError("عضو تیم را انتخاب کنید", 400);
      await checkRefs(owner, { templates: [], users: [d.user] });
    }
    const a = await BizQuizAssignment.create({ ...own(owner), quiz: qid, scope: d.scope, ...(d.scope === "user" ? { user: d.user } : {}), ...(d.dueDate ? { dueDate: d.dueDate } : {}), createdBy: req.user?._id });
    const q = await BizQuiz.findById(qid).select("title").lean<IBizQuiz>();
    const to = d.scope === "all" ? (await team(owner)).map((m) => m._id) : [d.user];
    for (const u of to) await notify(u, "آزمون تازه برای شما", `«${q?.title || ""}»`, crmLink(owner, "quizzes"));
    ok(res, "crmAssignQuiz", a, 201);
  }),
  unassignQuiz: withOwner(ownerOf, async (owner, req, res) => {
    const r = await BizQuizAssignment.deleteOne({ ...own(owner), _id: param(req, "assignmentId") });
    if (!r.deletedCount) throw new NotFoundError();
    ok(res, "crmUnassignQuiz");
  }),

  // ---------------------------------------------------------------- workflows
  getFlows: withOwner(ownerOf, async (owner, _req, res) => {
    const rows = await BizFlow.find(own(owner)).sort({ createdAt: -1 }).lean<IBizFlow[]>();
    const stats = await BizFlowRun.aggregate([{ $match: own(owner) }, { $group: { _id: { f: "$flow", s: "$status" }, n: { $sum: 1 } } }]);
    ok(
      res,
      "crmFlows",
      rows.map((f) => ({
        ...f,
        runs: Object.fromEntries(
          stats.filter((s: { _id: { f: unknown } }) => String(s._id.f) === String(f._id)).map((s: { _id: { s: string }; n: number }) => [s._id.s, s.n]),
        ),
      })),
    );
  }),
  getFlow: withOwner(ownerOf, async (owner, req, res) => {
    const f = await BizFlow.findOne({ ...own(owner), _id: param(req, "flowId") }).lean<IBizFlow>();
    if (!f) throw new NotFoundError();
    const runs = await BizFlowRun.find({ flow: f._id }).sort({ createdAt: -1 }).limit(100).populate("contact", "name phone").lean();
    ok(res, "crmFlow", { flow: f, runs });
  }),
  saveFlow: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = flowBody.safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام، ماشه و گام‌های گردش‌کار را کامل کنید", 400);
    if (!flowTriggerOn(owner, parsed.data.trigger)) throw new AppError("این رویداد برای این نوع حساب پیش نمی‌آید", 400);
    const steps = parsed.data.steps.map((s) => clean(s));
    for (const s of steps) {
      if (s.kind === "action" && !s.action) throw new AppError("نوع اقدام هر گام را انتخاب کنید", 400);
      if (s.kind === "condition" && !s.conditions?.length) throw new AppError("شرط هر گام شرطی را بنویسید", 400);
    }
    await checkRefs(owner, {
      templates: steps.map((s) => s.template).filter(Boolean) as string[],
      users: steps.flatMap((s) => [s.assignee, s.approver]).filter(Boolean) as string[],
      sequences: steps.map((s) => s.sequence).filter(Boolean) as string[],
    });
    const data = { name: parsed.data.name, trigger: parsed.data.trigger, filters: parsed.data.filters.map((c) => clean(c)), steps };
    const fid = req.params.flowId;
    if (fid) {
      if (!isId(fid)) throw new NotFoundError();
      const old = await BizFlow.findOne({ ...own(owner), _id: fid }).lean<IBizFlow>();
      if (!old) throw new NotFoundError();
      // a waiting run points at a step index: the steps of a flow with
      // waiting runs keep their number
      if (old.steps.length !== steps.length && (await BizFlowRun.exists({ flow: old._id, status: { $in: ["waitingDelay", "waitingApproval"] } })))
        throw new AppError("این گردش‌کار اجرای در انتظار دارد؛ تعداد گام‌ها را پس از پایان آن‌ها تغییر دهید", 400);
      const f = await BizFlow.findOneAndUpdate({ _id: old._id }, { $set: { ...data, ...(old.trigger !== data.trigger ? { cursor: new Date() } : {}) } }, { new: true }).lean();
      return ok(res, "crmSaveFlow", f);
    }
    ok(res, "crmSaveFlow", await BizFlow.create({ ...own(owner), ...data, createdBy: req.user?._id }), 201);
  }),
  // on: from now on (only events after it was switched on run it); an SMS
  // step needs an approved template
  toggleFlow: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ active: z.boolean() }).safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const f = await BizFlow.findOne({ ...own(owner), _id: param(req, "flowId") }).lean<IBizFlow>();
    if (!f) throw new NotFoundError();
    if (parsed.data.active) {
      if (!flowTriggerOn(owner, f.trigger)) throw new AppError("این رویداد برای این نوع حساب پیش نمی‌آید", 400);
      if (!f.steps.length) throw new AppError("گردش‌کار دست‌کم یک گام لازم دارد", 400);
      const tpl = f.steps.filter((s) => s.action === "sendSms").map((s) => s.template);
      if (tpl.some((t) => !t)) throw new AppError("برای هر پیامک یک قالب تأییدشده انتخاب کنید", 400);
      if (tpl.length && (await BizTemplate.countDocuments({ ...own(owner), _id: { $in: tpl }, status: "Approved" })) !== new Set(tpl.map(String)).size)
        throw new AppError("قالب پیامک یکی از گام‌ها هنوز تأیید نشده است", 400);
    }
    const now = new Date();
    const out = await BizFlow.findOneAndUpdate(
      { _id: f._id },
      { $set: { active: parsed.data.active, ...(parsed.data.active && !f.active ? { enabledAt: now, cursor: now } : {}) } },
      { new: true },
    ).lean();
    ok(res, "crmToggleFlow", out);
  }),
  // its waiting runs are cancelled with their approvals; the log stays
  deleteFlow: withOwner(ownerOf, async (owner, req, res) => {
    const f = await BizFlow.findOneAndDelete({ ...own(owner), _id: param(req, "flowId") }).lean<IBizFlow>();
    if (!f) throw new NotFoundError();
    const waiting = await BizFlowRun.find({ flow: f._id, status: { $in: ["running", "waitingDelay", "waitingApproval"] } }).select("_id").lean();
    for (const r of waiting) await cancelRun(owner, r._id);
    ok(res, "crmDeleteFlow");
  }),
  // run it now for one patient (a test, or a manual start)
  runFlow: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ contact: id }).safeParse(req.body || {});
    if (!parsed.success) throw new AppError("بیمار را انتخاب کنید", 400);
    const f = await BizFlow.findOne({ ...own(owner), _id: param(req, "flowId") }).lean<IBizFlow>();
    if (!f) throw new NotFoundError();
    if (!(await BizContact.exists({ ...own(owner), _id: parsed.data.contact }))) throw new NotFoundError();
    ok(res, "crmRunFlow", await startManualRun(f, parsed.data.contact), 201);
  }),
  getRuns: withOwner(ownerOf, async (owner, req, res) => {
    const q = z.object({ flow: id.optional(), status: z.string().max(20).optional() }).safeParse(req.query);
    if (!q.success) throw new BadInputError();
    const rows = await BizFlowRun.find({ ...own(owner), ...(q.data.flow ? { flow: q.data.flow } : {}), ...(q.data.status ? { status: q.data.status } : {}) })
      .sort({ createdAt: -1 })
      .limit(300)
      .populate("contact", "name phone")
      .populate("flow", "name trigger")
      .lean();
    ok(res, "crmFlowRuns", rows);
  }),
  getRun: withOwner(ownerOf, async (owner, req, res) => {
    const r = await BizFlowRun.findOne({ ...own(owner), _id: param(req, "runId") }).populate("contact", "name phone").populate("flow").lean();
    if (!r) throw new NotFoundError();
    ok(res, "crmFlowRun", r);
  }),
  cancelRun: withOwner(ownerOf, async (owner, req, res) => {
    if (!(await cancelRun(owner, param(req, "runId")))) throw new AppError("این اجرا تمام شده است", 400);
    ok(res, "crmCancelRun");
  }),

  // ---------------------------------------------------------------- returns
  getReturns: withOwner(ownerOf, async (owner, req, res) => {
    const status = z.enum(bizReturnStatuses).optional().safeParse(req.query.status || undefined);
    const rows = await BizReturn.find({ ...own(owner), ...(status.success && status.data ? { status: status.data } : {}) })
      .sort({ createdAt: -1 })
      .limit(300)
      .populate("contact", "name phone")
      .populate("invoice", "number total")
      .populate("item", "name")
      .lean();
    // the approvers, where it waits and why it was rejected: its inbox item
    const items = await BizRequest.find({ ...own(owner), kind: "return", returnDoc: { $in: rows.map((r) => r._id) } })
      .select("returnDoc chain level rejectReason status")
      .lean<IBizRequest[]>();
    const byReturn = new Map(items.map((i) => [String(i.returnDoc), i]));
    ok(
      res,
      "crmReturns",
      rows.map((r) => {
        const i = byReturn.get(String(r._id));
        return { ...r, approverChain: i?.chain || [], currentLevel: i?.level || 0, rejectReason: i?.rejectReason, request: i?._id };
      }),
    );
  }),
  // what a return form picks from: issued manual invoices and stock items
  getReturnLookups: withOwner(ownerOf, async (owner, req, res) => {
    const term = String(req.query.q || "").trim().slice(0, 40);
    const [invoices, items] = await Promise.all([
      BizInvoice.find({
        ...own(owner),
        origin: "manual",
        status: { $in: ["issued", "partial", "paid"] },
        ...(term ? { $or: [{ "party.name": { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }, ...(/^\d+$/.test(term) ? [{ number: Number(term) }] : [])] } : {}),
      })
        .sort({ date: -1 })
        .limit(30)
        .select("number date total party")
        .lean(),
      STOCK_KINDS.includes(owner.kind) ? BizItem.find({ ...own(owner), kind: "goods" }).sort({ name: 1 }).limit(500).select("name").lean() : Promise.resolve([]),
    ]);
    ok(res, "crmReturnLookups", { invoices, items });
  }),
  createReturn: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        kind: z.enum(bizReturnKinds),
        action: z.enum(bizReturnActions),
        contact: optId,
        invoice: optId,
        item: optId,
        amount: z.coerce.number().min(0).default(0),
        payFrom: z.enum(["cash", "bank"]).default("cash"),
        reason: z.string().trim().max(1000).optional().nullable(),
        approvers: z.array(id).max(5).default([]),
      })
      .safeParse(req.body || {});
    if (!parsed.success) throw new AppError("اطلاعات درخواست مرجوعی کامل نیست", 400);
    ok(res, "crmCreateReturn", await createReturn(owner, { ...parsed.data, reason: parsed.data.reason || undefined }, req.user?._id), 201);
  }),
  processReturn: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "crmProcessReturn", await processReturn(owner, param(req, "returnId"), req.user?._id));
  }),
  voidReturn: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "crmVoidReturn", await voidReturn(owner, param(req, "returnId"), req.user?._id));
  }),
  cancelReturn: withOwner(ownerOf, async (owner, req, res) => {
    ok(res, "crmCancelReturn", await cancelReturn(owner, param(req, "returnId")));
  }),
});
