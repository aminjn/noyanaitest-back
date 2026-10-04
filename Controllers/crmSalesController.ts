import express, { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import BizContact, { IBizContact } from "../Models/BizContact";
import BizActivity from "../Models/BizActivity";
import BizInvoice from "../Models/BizInvoice";
import BizPipeline, { IBizPipeline } from "../Models/BizPipeline";
import BizLead, { bizLeadKinds, IBizLead } from "../Models/BizLead";
import BizLeadSource from "../Models/BizLeadSource";
import BizCrmSettings from "../Models/BizCrmSettings";
import BizAssignRule, { IBizAssignRule } from "../Models/BizAssignRule";
import BizTeam from "../Models/BizTeam";
import BizGoal, { bizGoalMetrics, IBizGoal } from "../Models/BizGoal";
import BizCommissionRule, { IBizCommissionRule } from "../Models/BizCommissionRule";
import BizPlan, { IBizPlan } from "../Models/BizPlan";
import BizContract, { IBizContract } from "../Models/BizContract";
import BizContentBlock from "../Models/BizContentBlock";
import BizCarePlan from "../Models/BizCarePlan";
import BizInquiry from "../Models/BizInquiry";
import BizRequest from "../Models/BizRequest";
import { cancelOpen } from "../Lib/business/kartabl";
import BizCustomField, { IBizCustomField } from "../Models/BizCustomField";
import BizContactExt, { IBizContactExt } from "../Models/BizContactExt";
import BizCall, { bizCallStatuses } from "../Models/BizCall";
import BizSavedReport from "../Models/BizSavedReport";
import { BizOwner } from "../Lib/business/coa";
import { own, normalizeMobile } from "../Lib/business/crm";
import { orgInfo } from "../Lib/business/campaign";
import { OwnerOf } from "./businessController";
import {
  assertStage,
  catalogOf,
  commissionResult,
  completeTask,
  contactOf,
  contractLink,
  contractToInvoice,
  createLead,
  creditOf,
  dayPlan,
  ensurePipelines,
  ensureFieldPresets,
  ensureSources,
  orgDirectory,
  referrerOf,
  extOf,
  findOrCreateContact,
  goalView,
  inquiryToLead,
  isId,
  itemsValue,
  keepStaff,
  leadActivityCount,
  leadScope,
  mergeContacts,
  newToken,
  oid,
  ownerUser,
  planDocNumber,
  planLink,
  planToInvoice,
  pricePlan,
  pushHistory,
  recomputeScores,
  runCarePlanNow,
  runDueCarePlans,
  scoreLead,
  sendContract,
  sendPlan,
  settingsOf,
  staffIds,
  staffOf,
  stageOf,
  startApproval,
} from "../Lib/business/crmSales";
import { advancePeriod, cfTypes, collectCustomValues, condOps, duplicateGroups, fieldKey, leadFields, periodRange, stageFields } from "../Lib/business/crmSalesCore";
import { nextDocNumber } from "../Lib/business/voucher";
import { PIPELINE_TEMPLATES, pipelineTemplate, profileOf, SalesFeature, SalesPart, salesApprovalOn, salesFeatureOn, salesPartOn } from "../Lib/business/crmProfiles";

// The CRM sales API (2026-10, docs/nexxa-crm-parity.md in the frontend
// repo) under /<panel>/crm: pipelines and stages, treatment inquiries
// (leads), sources and loss reasons, assignment and score rules, teams,
// custom fields, duplicates, treatment plans, approvals, contracts and the
// contract library, care plans, estimate requests, calls, goals,
// commission, the day plan and reports. Read with readCrm, change with
// manageCrm (Routers/crmRoutes.ts); a decision on an approval is the
// approver's own.

const withOwner = (ownerOf: OwnerOf, fn: (owner: BizOwner, req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const owner = ownerOf(req);
    if (!owner?.id) return next(new NotFoundError());
    await fn(owner, req, res);
  });

const ok = (res: Response, message: string, data?: unknown, status = 200) => res.status(status).json({ message, data });
const id = z.string().regex(/^[0-9a-f]{24}$/i);
const optId = id.nullable().optional();
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/)
  .nullable()
  .optional();
const dateOf = (s?: string | null) => (s ? new Date(s.length === 10 ? `${s}T09:00:00+03:30` : s) : undefined);
const money = z.coerce.number().min(0).max(1e13);
const pct = z.coerce.number().min(0).max(100);
const text = (max: number) => z.string().trim().max(max);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new BadInputError();
  return r.data;
};
const userOf = (req: Request) => (req.user?._id ? String(req.user._id) : undefined);
const param = (req: Request, key: string) => {
  const v = req.params[key];
  if (!isId(v)) throw new NotFoundError();
  return v;
};

const lineRef = z.object({ kind: z.enum(["service", "package", "item"]), id }).nullable().optional();
const leadItem = z.object({
  title: text(300).min(1),
  ref: lineRef,
  qty: z.coerce.number().min(0).max(100000).default(1),
  unitPrice: money.default(0),
  discount: pct.default(0),
  sessions: z.coerce.number().int().min(0).max(1000).nullable().optional(),
});
const planItem = leadItem.extend({ taxRate: z.coerce.number().min(0).max(50).default(0) });
const cleanItems = <T extends { title: string; qty: number; ref?: { kind: string; id: string } | null }>(items: T[]) =>
  items
    .filter((l) => l.title.trim() && l.qty > 0)
    .slice(0, 100)
    .map(({ ref, ...l }) => ({ ...l, ...(ref ? { ref: { kind: ref.kind, id: oid(ref.id) } } : {}) }));

const condition = z.object({ field: z.enum(Object.keys(leadFields) as [string, ...string[]]), op: z.enum(condOps), value: text(200).default("") });

// the custom field definitions of one entity, and the values from a body
const fieldDefs = (owner: BizOwner, entity: "contact" | "lead") =>
  BizCustomField.find({ ...own(owner), entity }).sort({ sequence: 1, createdAt: 1 }).lean<IBizCustomField[]>();
const customValues = async (owner: BizOwner, entity: "contact" | "lead", input: unknown, existing?: Record<string, string> | null) => {
  if (!input || typeof input !== "object") return existing || undefined;
  const defs = (await fieldDefs(owner, entity)).filter((d) => d.active);
  const out = collectCustomValues(input as Record<string, unknown>, defs, existing);
  for (const d of defs)
    if (d.required && !out[d.key] && d.key in (input as Record<string, unknown>)) throw new AppError(`«${d.label}» را پر کنید`, 400);
  for (const d of defs)
    if (d.type === "select" && out[d.key] && d.options.length && !d.options.includes(out[d.key])) throw new AppError(`گزینه‌ی «${d.label}» معتبر نیست`, 400);
  return out;
};

const leadBody = z.object({
  title: text(200),
  kind: z.enum(bizLeadKinds).optional(),
  contact: optId,
  name: text(120).optional(),
  phone: text(20).optional(),
  pipeline: optId,
  stage: optId,
  value: money.optional(),
  probability: pct.optional(),
  priority: z.coerce.number().int().min(0).max(3).optional(),
  expectedClose: day,
  source: optId,
  assignee: optId,
  note: text(2000).optional(),
  items: z.array(leadItem).max(100).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  doctor: z.object({ id: optId, name: text(120) }).nullable().optional(),
  referrer: optId,
  referrerName: text(120).optional(),
});

const pipelineView = (p: IBizPipeline) => ({ ...p, stages: [...(p.stages || [])].sort((a, b) => a.sequence - b.sequence) });

const planBase = z.object({
  subject: text(200).min(1),
  contact: optId,
  name: text(120).optional(),
  phone: text(20).optional(),
  lead: optId,
  doctorName: text(120).optional(),
  referrerName: text(120).optional(),
  date: day,
  openTill: day,
  discountPercent: pct,
  items: z.array(planItem).max(100),
  note: text(2000).optional(),
  terms: text(5000).optional(),
});
// a partial update must not reset what it does not name: no defaults in it
const planBody = planBase.extend({ discountPercent: pct.default(0), items: z.array(planItem).max(100).default([]) });
const planPatch = planBase.partial();

const contractBase = z.object({
  subject: text(200).min(1),
  contact: optId,
  party: z.object({ name: text(200).default(""), phone: text(20).optional(), nationalId: text(20).optional(), kind: z.enum(["company", "insurer", "person"]).default("company") }),
  type: optId,
  value: money,
  startDate: day,
  endDate: day,
  content: z.string().max(60000).optional(),
  note: text(2000).optional(),
});
const contractBody = contractBase.extend({ party: contractBase.shape.party.optional(), value: money.default(0) });
const contractPatch = contractBase.partial();

const carePlanBase = z.object({
  contact: id,
  name: text(160).min(1),
  amount: money,
  taxRate: z.coerce.number().min(0).max(50),
  interval: z.enum(["week", "month", "year"]),
  intervalCount: z.coerce.number().int().min(1).max(36),
  startDate: day,
  endDate: day,
  autoIssue: z.boolean(),
  note: text(1000).optional(),
});
const carePlanBody = carePlanBase.extend({
  taxRate: carePlanBase.shape.taxRate.default(0),
  interval: carePlanBase.shape.interval.default("month"),
  intervalCount: carePlanBase.shape.intervalCount.default(1),
  autoIssue: z.boolean().default(false),
});
const carePlanPatch = carePlanBase.omit({ contact: true, startDate: true }).partial();

const goalBody = z.object({
  title: text(160).min(1),
  assignee: optId,
  doctorName: text(120).optional(),
  metric: z.enum(bizGoalMetrics),
  target: money.default(0),
  period: z.enum(["month", "quarter", "year", "custom"]).default("month"),
  startDate: day,
  endDate: day,
  lines: z
    .array(z.object({ label: text(200).default(""), service: optId, targetQty: money.default(0), targetValue: money.default(0) }))
    .max(50)
    .default([]),
});
const goalFields = async (owner: BizOwner, d: z.infer<typeof goalBody>) => {
  const range = d.period === "custom" ? { start: dateOf(d.startDate), end: dateOf(d.endDate) } : periodRange(d.period, dateOf(d.startDate) || new Date());
  if (!range.start || !range.end || range.end <= range.start) throw new AppError("بازه‌ی هدف معتبر نیست", 400);
  const lines = d.lines.filter((l) => l.label || l.service).map((l) => ({ ...l, service: l.service ? oid(l.service) : undefined }));
  // a service target is the sum of its lines' amounts (or counts)
  const target = d.metric === "serviceSales" && lines.length ? lines.reduce((s, l) => s + (l.targetValue || l.targetQty), 0) : d.target;
  if (!(target > 0)) throw new AppError("مقدار هدف را بنویسید", 400);
  const assignee = d.assignee ? (await keepStaff(owner, [d.assignee]))[0] : undefined;
  return { title: d.title, metric: d.metric, period: d.period, target, startDate: range.start, endDate: range.end, lines, assignee, doctorName: d.doctorName || undefined };
};

const tier = z.object({ from: money, pct });
const commissionBody = z.object({
  user: optId,
  doctorName: text(120).optional(),
  title: text(160).min(1),
  scope: z.enum(["self", "team"]).default("self"),
  mode: z.enum(["flat", "tiered"]).default("flat"),
  tierMethod: z.enum(["marginal", "whole"]).default("marginal"),
  salesTiers: z.array(tier).max(20).default([]),
  collectionTiers: z.array(tier).max(20).default([]),
  salesPct: pct.default(0),
  collectionPct: pct.default(0),
  period: z.enum(["month", "quarter", "year", "custom"]).default("month"),
  periodStart: day,
  periodEnd: day,
  active: z.boolean().default(true),
});

// ---------------------------------------------------------------- public

// a small per-address limit on the public forms (Nexxa rateLimit)
const hits = new Map<string, number[]>();
const limited = (key: string, max = 8, windowMs = 60 * 60_000) => {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return list.length > max;
};
const ipOf = (req: Request) => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim().slice(0, 60);
const signatureOf = (v: unknown) => {
  const s = typeof v === "string" ? v : "";
  return /^data:image\/(png|jpeg|webp);base64,/.test(s) ? s.slice(0, 400_000) : undefined;
};

const formOwner = async (slug: string) => {
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return null;
  const cfg = await BizCrmSettings.findOne({ "webform.slug": slug, "webform.enabled": true }).lean();
  return cfg ? { cfg, owner: { kind: cfg.ownerKind, id: String(cfg.ownerId) } as BizOwner } : null;
};

const publicForm = z.object({
  name: text(120).min(2),
  phone: text(20),
  email: z.string().trim().email().max(120).optional().or(z.literal("")),
  city: text(80).optional(),
  kind: z.enum(bizLeadKinds).optional(),
  subject: text(200).optional(),
  message: text(2000).optional(),
  budget: money.optional(),
  company: text(120).optional(),
  address: text(500).optional(),
  preferredAt: text(120).optional(),
  referrer: text(120).optional(),
  // the honeypot: a bot fills every field
  website: z.string().optional(),
});

export const crmPublicRouter = () => {
  const router = express.Router();
  router.get(
    "/form/:slug",
    catchAsync(async (req: Request, res: Response) => {
      const f = await formOwner(String(req.params.slug || ""));
      if (!f) throw new NotFoundError();
      const info = await orgInfo(f.owner).catch(() => ({ name: "" }));
      const w = f.cfg.webform;
      ok(res, "crmPublicForm", {
        org: info.name,
        kind: f.owner.kind,
        title: w.title,
        intro: w.intro,
        thanks: w.thanks,
        askEmail: w.askEmail,
        askCity: w.askCity,
        askKind: w.askKind,
        requests: !!w.requests,
      });
    }),
  );
  const submit = (mode: "lead" | "request") =>
    catchAsync(async (req: Request, res: Response) => {
      const f = await formOwner(String(req.params.slug || ""));
      if (!f || (mode === "request" && !f.cfg.webform.requests)) throw new NotFoundError();
      const body = parse(publicForm, req.body);
      // a bot, or too many from one address: told it worked, nothing saved
      if (body.website || limited(`${ipOf(req)}:${req.params.slug}`)) return ok(res, "crmPublicFormSent", { sent: true });
      const phone = normalizeMobile(body.phone);
      if (!phone) throw new AppError("شماره‌ی موبایل معتبر نیست", 400);
      const owner = f.owner;
      if (mode === "request") {
        await BizInquiry.create({
          ...own(owner),
          name: body.name,
          phone,
          email: body.email || undefined,
          company: body.company,
          subject: body.subject || body.message?.slice(0, 120) || body.name,
          description: [body.message, body.city].filter(Boolean).join("\n"),
          kind: body.kind,
          budget: body.budget || 0,
          address: body.address,
          preferredAt: body.preferredAt,
          referrerName: body.referrer,
          source: "web",
        });
      } else {
        const contact = await findOrCreateContact(owner, { name: body.name, phone });
        if (contact && body.city && !contact.city) await BizContact.updateOne({ _id: contact._id }, { $set: { city: body.city } });
        if (contact && body.email) await BizContactExt.updateOne({ contact: contact._id }, { $set: { email: body.email }, $setOnInsert: { ...own(owner), contact: contact._id } }, { upsert: true });
        const pipe = f.cfg.webform.pipeline ? String(f.cfg.webform.pipeline) : undefined;
        await createLead(owner, {
          title: body.subject || body.message?.slice(0, 120) || body.name,
          kind: body.kind,
          contact: contact ? String(contact._id) : undefined,
          pipeline: pipe,
          note: [body.message, body.address, body.preferredAt].filter(Boolean).join("\n"),
          sourceSystem: body.referrer ? "doctorReferral" : "webform",
          referrerName: body.referrer,
        });
      }
      ok(res, "crmPublicFormSent", { sent: true }, 201);
    });
  router.post("/form/:slug/lead", submit("lead"));
  router.post("/form/:slug/request", submit("request"));

  const planByToken = (token: string) => (/^[A-Za-z0-9_-]{8,20}$/.test(token) ? BizPlan.findOne({ token }) : null);
  router.get(
    "/plan/:token",
    catchAsync(async (req: Request, res: Response) => {
      const p = await planByToken(String(req.params.token || ""));
      if (!p || p.status === "draft") throw new NotFoundError();
      const owner = { kind: p.ownerKind, id: String(p.ownerId) } as BizOwner;
      const [info, contact] = await Promise.all([orgInfo(owner).catch(() => ({ name: "" })), p.contact ? BizContact.findById(p.contact).select("name").lean<{ name?: string }>() : null]);
      ok(res, "crmPublicPlan", {
        org: info.name,
        number: p.number,
        subject: p.subject,
        patient: contact?.name || "",
        date: p.date,
        openTill: p.openTill,
        status: p.status,
        items: p.items.map((i) => ({ title: i.title, qty: i.qty, unitPrice: i.unitPrice, discount: i.discount, taxRate: i.taxRate, sessions: i.sessions })),
        discountPercent: p.discountPercent,
        subtotal: p.subtotal,
        discount: p.discount,
        tax: p.tax,
        total: p.total,
        terms: p.terms,
        acceptedName: p.acceptedName,
        decidedAt: p.decidedAt,
        canDecide: ["sent", "revised"].includes(p.status) && !(p.openTill && p.openTill < new Date()),
      });
    }),
  );
  router.post(
    "/plan/:token/:decision",
    catchAsync(async (req: Request, res: Response) => {
      const decision = req.params.decision;
      if (decision !== "accept" && decision !== "decline") throw new NotFoundError();
      const p = await planByToken(String(req.params.token || ""));
      if (!p) throw new NotFoundError();
      if (limited(`plan:${ipOf(req)}`, 20)) throw new AppError("تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره امتحان کنید", 429);
      // only a plan sent to the patient, not yet decided (Nexxa
      // acceptProposalPublic / declineProposalPublic)
      if (!["sent", "revised"].includes(p.status)) throw new AppError("این طرح دیگر قابل تأیید یا رد نیست", 400);
      if (p.openTill && p.openTill < new Date()) throw new AppError("مهلت این طرح گذشته است", 400);
      if (decision === "accept") {
        const name = parse(z.object({ name: text(120).min(2) }), req.body).name;
        p.status = "accepted";
        p.acceptedName = name;
        p.acceptedIp = ipOf(req);
        p.signature = signatureOf(req.body?.signature);
      } else p.status = "declined";
      p.decidedAt = new Date();
      await p.save();
      const owner = { kind: p.ownerKind, id: String(p.ownerId) } as BizOwner;
      const user = (await ownerUser(owner).catch(() => "")) || undefined;
      const by = p.createdBy || user;
      if (by)
        await import("../Models/Notification").then(({ default: N }) =>
          N.create({
            user: by,
            source: "System",
            title: "طرح درمان",
            message: `بیمار طرح درمان شماره‌ی ${p.number.toLocaleString("fa-IR")} را ${decision === "accept" ? "پذیرفت" : "رد کرد"}.`,
          }).catch(() => {}),
        );
      ok(res, "crmPublicPlanDecided", { status: p.status });
    }),
  );

  const contractByToken = (token: string) => (/^[A-Za-z0-9_-]{8,20}$/.test(token) ? BizContract.findOne({ token }) : null);
  router.get(
    "/contract/:token",
    catchAsync(async (req: Request, res: Response) => {
      const c = await contractByToken(String(req.params.token || ""));
      if (!c || c.state === "canceled") throw new NotFoundError();
      const owner = { kind: c.ownerKind, id: String(c.ownerId) } as BizOwner;
      const info = await orgInfo(owner).catch(() => ({ name: "" }));
      ok(res, "crmPublicContract", {
        org: info.name,
        number: c.number,
        subject: c.subject,
        party: c.party?.name,
        value: c.value,
        startDate: c.startDate,
        endDate: c.endDate,
        content: c.content,
        signed: c.signed,
        signerName: c.signerName,
        signedAt: c.signedAt,
        state: c.state,
      });
    }),
  );
  router.post(
    "/contract/:token/sign",
    catchAsync(async (req: Request, res: Response) => {
      const c = await contractByToken(String(req.params.token || ""));
      if (!c || c.state === "canceled") throw new NotFoundError();
      if (limited(`contract:${ipOf(req)}`, 20)) throw new AppError("تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره امتحان کنید", 429);
      if (c.signed) throw new AppError("این قرارداد قبلاً امضا شده است", 400);
      const name = parse(z.object({ name: text(120).min(2) }), req.body).name;
      const signature = signatureOf(req.body?.signature);
      if (!signature) throw new AppError("امضا را در کادر بکشید", 400);
      // signing a draft makes it active (Nexxa signContractPublic)
      const claimed = await BizContract.updateOne(
        { _id: c._id, signed: false },
        { $set: { signed: true, signedAt: new Date(), signerName: name, signature, acceptedIp: ipOf(req), ...(c.state === "draft" ? { state: "active" } : {}) } },
      );
      if (!claimed.modifiedCount) throw new AppError("این قرارداد قبلاً امضا شده است", 400);
      if (c.contact)
        await BizActivity.create({ ownerKind: c.ownerKind, ownerId: c.ownerId, contact: c.contact, kind: "note", text: `قرارداد «${c.subject}» را ${name} امضا کرد.` }).catch(() => {});
      ok(res, "crmPublicContractSigned", { signed: true });
    }),
  );
  return router;
};

// ---------------------------------------------------------------- panel

export const makeCrmSalesController = (ownerOf: OwnerOf) => {
  const h = (fn: (owner: BizOwner, req: Request, res: Response) => Promise<unknown>) => withOwner(ownerOf, fn);

  const leadIn = async (owner: BizOwner, req: Request) => {
    const lead = await BizLead.findOne({ ...own(owner), _id: param(req, "leadId"), ...(await leadScope(owner, userOf(req))) });
    if (!lead) throw new NotFoundError();
    return lead;
  };

  return {
    // ------------------------------------------------------------ meta
    getMeta: h(async (owner, req, res) => {
      await ensureSources(owner);
      await settingsOf(owner);
      await ensureFieldPresets(owner);
      const [staff, pipelines, sources, fields, cfg, top, directory] = await Promise.all([
        staffOf(owner),
        ensurePipelines(owner),
        BizLeadSource.find(own(owner)).sort({ kind: 1, sequence: 1, name: 1 }).lean(),
        BizCustomField.find(own(owner)).sort({ sequence: 1, createdAt: 1 }).lean(),
        settingsOf(owner),
        ownerUser(owner),
        orgDirectory(owner).catch(() => ({ departments: [], doctors: [] })),
      ]);
      ok(res, "crmSalesMeta", {
        profile: profileOf(owner),
        templates: PIPELINE_TEMPLATES[profileOf(owner)].map((t) => ({ key: t.key, name: t.name })),
        departments: directory.departments,
        doctors: directory.doctors,
        referrers: sources.filter((s) => s.kind === "referrer"),
        staff,
        me: userOf(req),
        ownerUser: top,
        pipelines: pipelines.map(pipelineView),
        sources: sources.filter((s) => s.kind === "source"),
        lossReasons: sources.filter((s) => s.kind === "lossReason"),
        customFields: fields,
        teamScope: !!cfg.teamScope,
        approvals: {
          plan: salesApprovalOn(owner, "plan") && !!cfg.approvals?.plan?.enabled,
          discount: salesApprovalOn(owner, "discount"),
          credit: salesApprovalOn(owner, "credit"),
        },
      });
    }),
    getCatalog: h(async (owner, req, res) => ok(res, "crmSalesCatalog", await catalogOf(owner, String(req.query.q || "").trim().slice(0, 60)))),

    // ------------------------------------------------------------ pipelines
    createPipeline: h(async (owner, req, res) => {
      const d = parse(z.object({ name: text(80).optional(), template: z.string().max(30).optional(), department: optId }), req.body);
      const existing = await BizPipeline.countDocuments(own(owner));
      // from one of the profile's templates; a clinic's or hospital's
      // pipeline may belong to one department
      const tpl = pipelineTemplate(owner, d.template);
      const dept = d.department ? (await orgDirectory(owner)).departments.find((x) => x._id === d.department) : undefined;
      const name = d.name || (dept ? `${tpl.name} - ${dept.name}` : tpl.name);
      const p = await BizPipeline.create({
        ...own(owner),
        name: name.slice(0, 80),
        template: tpl.key,
        ...(dept ? { department: { id: oid(dept._id), name: dept.name } } : {}),
        isDefault: !existing,
        sequence: existing,
        stages: tpl.stages.map((x, i) => ({ ...x, sequence: i, requiredFields: [], requireActivity: false })),
      });
      ok(res, "crmSalesPipeline", p, 201);
    }),
    updatePipeline: h(async (owner, req, res) => {
      const d = parse(z.object({ name: text(80).min(1).optional(), isDefault: z.literal(true).optional() }), req.body);
      const p = await BizPipeline.findOne({ ...own(owner), _id: param(req, "pipelineId") });
      if (!p) throw new NotFoundError();
      if (d.name) p.name = d.name;
      if (d.isDefault) {
        await BizPipeline.updateMany({ ...own(owner), _id: { $ne: p._id } }, { $set: { isDefault: false } });
        p.isDefault = true;
      }
      await p.save();
      ok(res, "crmSalesPipeline", p);
    }),
    deletePipeline: h(async (owner, req, res) => {
      const p = await BizPipeline.findOne({ ...own(owner), _id: param(req, "pipelineId") });
      if (!p) throw new NotFoundError();
      if (p.isDefault) throw new AppError("قیف پیش‌فرض حذف نمی‌شود؛ اول قیف دیگری را پیش‌فرض کنید", 400);
      if (await BizLead.exists({ ...own(owner), pipeline: p._id })) throw new AppError("این قیف درخواست دارد و حذف نمی‌شود", 400);
      await p.deleteOne();
      ok(res, "crmSalesPipelineDeleted");
    }),
    createStage: h(async (owner, req, res) => {
      const d = parse(z.object({ name: text(80).min(1), probability: pct.default(0) }), req.body);
      const p = await BizPipeline.findOne({ ...own(owner), _id: param(req, "pipelineId") });
      if (!p) throw new NotFoundError();
      if (p.stages.length >= 20) throw new AppError("هر قیف حداکثر ۲۰ مرحله دارد", 400);
      const top = p.stages.reduce((m, s) => Math.max(m, s.sequence), -1);
      p.stages.push({ name: d.name, probability: d.probability, sequence: top + 1, requiredFields: [], requireActivity: false } as never);
      await p.save();
      ok(res, "crmSalesPipeline", p, 201);
    }),
    updateStage: h(async (owner, req, res) => {
      const d = parse(
        z.object({
          name: text(80).min(1).optional(),
          probability: pct.optional(),
          requiredFields: z.array(z.enum(stageFields)).max(10).optional(),
          requireActivity: z.boolean().optional(),
        }),
        req.body,
      );
      const p = await BizPipeline.findOne({ ...own(owner), _id: param(req, "pipelineId") });
      const s = p?.stages.find((x) => String(x._id) === req.params.stageId);
      if (!p || !s) throw new NotFoundError();
      if (d.name !== undefined && d.name !== s.name) {
        s.name = d.name;
        s.key = undefined;
      }
      if (d.probability !== undefined) s.probability = d.probability;
      if (d.requiredFields) s.requiredFields = d.requiredFields;
      if (d.requireActivity !== undefined) s.requireActivity = d.requireActivity;
      await p.save();
      ok(res, "crmSalesPipeline", p);
    }),
    // up / down, inside the same pipeline only (Nexxa moveStage)
    moveStage: h(async (owner, req, res) => {
      const { dir } = parse(z.object({ dir: z.enum(["up", "down"]) }), req.body);
      const p = await BizPipeline.findOne({ ...own(owner), _id: param(req, "pipelineId") });
      if (!p) throw new NotFoundError();
      const sorted = [...p.stages].sort((a, b) => a.sequence - b.sequence);
      const i = sorted.findIndex((x) => String(x._id) === req.params.stageId);
      const j = dir === "up" ? i - 1 : i + 1;
      if (i < 0) throw new NotFoundError();
      if (j >= 0 && j < sorted.length) {
        sorted.forEach((s, k) => (s.sequence = k));
        [sorted[i].sequence, sorted[j].sequence] = [sorted[j].sequence, sorted[i].sequence];
        await p.save();
      }
      ok(res, "crmSalesPipeline", p);
    }),
    deleteStage: h(async (owner, req, res) => {
      const p = await BizPipeline.findOne({ ...own(owner), _id: param(req, "pipelineId") });
      const s = p?.stages.find((x) => String(x._id) === req.params.stageId);
      if (!p || !s) throw new NotFoundError();
      if (p.stages.length <= 1) throw new AppError("قیف دست‌کم یک مرحله لازم دارد", 400);
      if (await BizLead.exists({ ...own(owner), pipeline: p._id, stage: s._id })) throw new AppError("این مرحله درخواست دارد و حذف نمی‌شود", 400);
      p.stages = p.stages.filter((x) => String(x._id) !== String(s._id)) as never;
      await p.save();
      ok(res, "crmSalesPipeline", p);
    }),

    // ------------------------------------------------------------ sources
    createSource: h(async (owner, req, res) => {
      const d = parse(z.object({ kind: z.enum(["source", "lossReason", "referrer"]).default("source"), name: text(80).min(1), phone: text(20).optional() }), req.body);
      // the same name again only switches it back on (Nexxa upsert)
      const s = await BizLeadSource.findOneAndUpdate(
        { ...own(owner), kind: d.kind, name: d.name },
        { $set: { active: true, ...(d.phone ? { phone: d.phone } : {}) }, $setOnInsert: { ...own(owner), kind: d.kind, name: d.name, sequence: await BizLeadSource.countDocuments({ ...own(owner), kind: d.kind }) } },
        { upsert: true, new: true },
      );
      ok(res, "crmSalesSource", s, 201);
    }),
    updateSource: h(async (owner, req, res) => {
      const d = parse(z.object({ name: text(80).min(1).optional(), active: z.boolean().optional() }), req.body);
      const s = await BizLeadSource.findOne({ ...own(owner), _id: param(req, "sourceId") });
      if (!s) throw new NotFoundError();
      if (d.name && d.name !== s.name) {
        if (await BizLeadSource.exists({ ...own(owner), kind: s.kind, name: d.name, _id: { $ne: s._id } })) throw new AppError("این نام قبلاً هست", 400);
        s.name = d.name;
        s.system = s.system === "webform" ? s.system : undefined;
        await BizLead.updateMany({ ...own(owner), source: s._id }, { $set: { sourceName: d.name } });
        if (s.kind === "referrer") await BizLead.updateMany({ ...own(owner), referrer: s._id }, { $set: { referrerName: d.name } });
      }
      if (d.active !== undefined) s.active = d.active;
      await s.save();
      ok(res, "crmSalesSource", s);
    }),
    deleteSource: h(async (owner, req, res) => {
      const s = await BizLeadSource.findOne({ ...own(owner), _id: param(req, "sourceId") });
      if (!s) throw new NotFoundError();
      if (s.system === "webform") throw new AppError("منبع «فرم سایت» را فرم استعلام لازم دارد؛ غیرفعالش کنید", 400);
      // the leads keep the name they were given
      await BizLead.updateMany({ ...own(owner), source: s._id }, { $unset: { source: 1 } });
      await BizLead.updateMany({ ...own(owner), referrer: s._id }, { $unset: { referrer: 1 } });
      await s.deleteOne();
      ok(res, "crmSalesSourceDeleted");
    }),

    // ------------------------------------------------------------ leads
    getLeads: h(async (owner, req, res) => {
      const q = req.query;
      const pipes = await ensurePipelines(owner);
      const pipe = pipes.find((p) => String(p._id) === q.pipeline) || pipes.find((p) => p.isDefault) || pipes[0];
      const term = String(q.q || "").trim().slice(0, 60);
      const contactIds = term ? (await BizContact.find({ ...own(owner), $or: [{ name: new RegExp(escape(term), "i") }, { phone: new RegExp(escape(term.replace(/\D/g, "") || term)) }] }).select("_id").limit(200).lean()).map((c) => c._id) : [];
      const filter: Record<string, unknown> = {
        ...own(owner),
        ...(q.view === "all" ? {} : { pipeline: pipe?._id }),
        ...(q.assignee === "none" ? { assignee: { $exists: false } } : q.assignee === "me" ? { assignee: oid(userOf(req)) } : isId(String(q.assignee || "")) ? { assignee: oid(q.assignee) } : {}),
        ...(bizLeadKinds.includes(q.kind as never) ? { kind: q.kind } : {}),
        ...(q.doctor ? { "doctor.name": String(q.doctor).slice(0, 120) } : {}),
        ...(["open", "won", "lost"].includes(String(q.status)) ? { status: q.status } : {}),
        ...(term ? { $and: [{ $or: [{ title: new RegExp(escape(term), "i") }, { contact: { $in: contactIds } }] }] } : {}),
      };
      const scope = await leadScope(owner, userOf(req));
      const where = { ...filter, ...(Object.keys(scope).length ? { $and: [...((filter.$and as Record<string, unknown>[]) || []), scope] } : {}) } as Record<string, unknown>;
      const leads = await BizLead.find(where as never)
        .sort({ updatedAt: -1 })
        .limit(1000)
        .select("-history -customFields")
        .populate("contact", "name phone")
        .lean();
      const open = leads.filter((l) => l.status === "open");
      ok(res, "crmSalesLeads", {
        pipeline: pipe ? pipelineView(pipe) : null,
        leads,
        forecast: {
          open: open.reduce((s, l) => s + (l.value || 0), 0),
          openCount: open.length,
          weighted: Math.round(open.reduce((s, l) => s + ((l.value || 0) * (l.probability || 0)) / 100, 0)),
          won: leads.filter((l) => l.status === "won").reduce((s, l) => s + (l.value || 0), 0),
          winRate: leads.length ? leads.filter((l) => l.status === "won").length / leads.length : 0,
        },
      });
    }),
    createLead: h(async (owner, req, res) => {
      const d = parse(leadBody, req.body);
      const lead = await createLead(
        owner,
        {
          ...d,
          contact: d.contact || undefined,
          pipeline: d.pipeline || undefined,
          stage: d.stage || undefined,
          source: d.source || undefined,
          assignee: d.assignee || undefined,
          expectedClose: dateOf(d.expectedClose),
          items: d.items?.map((l) => ({ ...l, ref: l.ref || undefined })),
          customFields: await customValues(owner, "lead", d.customFields),
          doctor: d.doctor,
          referrer: d.referrer,
        },
        userOf(req),
      );
      ok(res, "crmSalesLead", lead, 201);
    }),
    getLead: h(async (owner, req, res) => {
      const lead = await leadIn(owner, req);
      const [contact, plan, calls, acts, pipes] = await Promise.all([
        lead.contact ? BizContact.findById(lead.contact).select("-optCode").lean() : null,
        lead.plan ? BizPlan.findById(lead.plan).select("number subject status total invoice").lean() : null,
        BizCall.find({ ...own(owner), lead: lead._id }).sort({ startedAt: -1 }).limit(50).lean(),
        lead.contact ? BizActivity.find({ ...own(owner), contact: lead.contact }).sort({ createdAt: -1 }).limit(50).lean() : [],
        ensurePipelines(owner),
      ]);
      ok(res, "crmSalesLead", {
        lead: lead.toObject(),
        contact,
        plan,
        calls,
        activities: acts,
        activityCount: await leadActivityCount(owner, lead),
        pipeline: pipes.find((p) => String(p._id) === String(lead.pipeline)) || null,
      });
    }),
    updateLead: h(async (owner, req, res) => {
      const d = parse(leadBody.partial(), req.body);
      const lead = await leadIn(owner, req);
      if (d.title !== undefined) {
        if (!d.title) throw new AppError("عنوان درخواست را بنویسید", 400);
        lead.title = d.title;
      }
      if (d.kind) lead.kind = d.kind;
      if (d.contact !== undefined) {
        const c = d.contact ? await contactOf(owner, d.contact) : null;
        if (d.contact && !c) throw new NotFoundError();
        lead.contact = c?._id as never;
      } else if (d.phone) {
        const c = await findOrCreateContact(owner, { name: d.name, phone: d.phone });
        if (!c) throw new AppError("شماره‌ی موبایل معتبر نیست", 400);
        lead.contact = c._id as never;
      }
      if (d.items) {
        lead.items = cleanItems(d.items) as never;
        lead.value = itemsValue(lead.items);
      } else if (d.value !== undefined && !lead.items.length) lead.value = Math.round(d.value);
      if (d.probability !== undefined) lead.probability = Math.round(d.probability);
      if (d.priority !== undefined) lead.priority = d.priority;
      if (d.expectedClose !== undefined) lead.expectedClose = dateOf(d.expectedClose);
      if (d.note !== undefined) lead.note = d.note;
      if (d.assignee !== undefined) lead.assignee = d.assignee ? ((await keepStaff(owner, [d.assignee]))[0] as never) : undefined;
      if (d.source !== undefined) {
        const s = d.source ? await BizLeadSource.findOne({ ...own(owner), _id: d.source, kind: "source" }).lean() : null;
        lead.source = s?._id as never;
        lead.sourceName = s?.name;
      }
      if (d.customFields) lead.customFields = await customValues(owner, "lead", d.customFields, lead.customFields);
      if (d.doctor !== undefined) lead.doctor = (d.doctor?.name ? { name: d.doctor.name, ...(d.doctor.id ? { id: oid(d.doctor.id) } : {}) } : undefined) as never;
      if (d.referrer !== undefined || d.referrerName !== undefined) {
        const ref = await referrerOf(owner, d.referrer, d.referrerName);
        lead.referrer = (ref.referrer || undefined) as never;
        lead.referrerName = ref.referrerName;
      }
      // a stage change in the same edit obeys the stage's blueprint
      let moved = "";
      if (d.stage && String(d.stage) !== String(lead.stage)) {
        const pipe = await BizPipeline.findOne({ ...own(owner), _id: lead.pipeline }).lean<IBizPipeline>();
        const s = stageOf(pipe, d.stage);
        if (!s) throw new NotFoundError();
        await assertStage(owner, lead, s);
        lead.stage = s._id;
        if (d.probability === undefined && lead.status === "open") lead.probability = s.probability;
        moved = s.name;
      }
      lead.lastActivityAt = new Date();
      await lead.save();
      if (moved) await BizLead.updateOne({ _id: lead._id }, pushHistory("stage", moved, userOf(req)));
      await scoreLead(owner, lead._id);
      ok(res, "crmSalesLead", await BizLead.findById(lead._id).lean());
    }),
    // drag and drop on the board (Nexxa moveLead), also across pipelines
    moveLead: h(async (owner, req, res) => {
      const d = parse(z.object({ stage: id, pipeline: optId }), req.body);
      const lead = await leadIn(owner, req);
      const pipe = await BizPipeline.findOne({ ...own(owner), _id: d.pipeline || lead.pipeline }).lean<IBizPipeline>();
      const s = stageOf(pipe, d.stage);
      if (!pipe || !s) throw new NotFoundError();
      if (String(s._id) === String(lead.stage) && String(pipe._id) === String(lead.pipeline)) return ok(res, "crmSalesLead", lead.toObject());
      await assertStage(owner, lead, s);
      lead.pipeline = pipe._id as never;
      lead.stage = s._id;
      if (lead.status === "open") lead.probability = s.probability;
      lead.lastActivityAt = new Date();
      await lead.save();
      await BizLead.updateOne({ _id: lead._id }, pushHistory("stage", s.name, userOf(req)));
      await scoreLead(owner, lead._id);
      ok(res, "crmSalesLead", await BizLead.findById(lead._id).lean());
    }),
    // won / lost with a reason / reopened (Nexxa setLeadStatus, markLost)
    setLeadStatus: h(async (owner, req, res) => {
      const d = parse(z.object({ status: z.enum(["open", "won", "lost"]), reason: text(300).optional() }), req.body);
      const lead = await leadIn(owner, req);
      if (d.status === "lost" && !d.reason) throw new AppError("دلیل انصراف را انتخاب کنید", 400);
      lead.status = d.status;
      if (d.status === "won") {
        lead.probability = 100;
        lead.closedAt = new Date();
        lead.winReason = d.reason;
      } else if (d.status === "lost") {
        lead.probability = 0;
        lead.closedAt = new Date();
        lead.lostReason = d.reason;
      } else {
        lead.closedAt = undefined;
        lead.lostReason = undefined;
        lead.winReason = undefined;
        const pipe = await BizPipeline.findById(lead.pipeline).lean<IBizPipeline>();
        lead.probability = stageOf(pipe, lead.stage)?.probability || 0;
      }
      lead.lastActivityAt = new Date();
      await lead.save();
      await BizLead.updateOne({ _id: lead._id }, pushHistory("status", d.reason ? `${d.status}: ${d.reason}` : d.status, userOf(req)));
      await scoreLead(owner, lead._id);
      ok(res, "crmSalesLead", await BizLead.findById(lead._id).lean());
    }),
    deleteLead: h(async (owner, req, res) => {
      const lead = await leadIn(owner, req);
      // its plan, calls and inquiry stay; they only lose the link
      await Promise.all([
        BizPlan.updateMany({ ...own(owner), lead: lead._id }, { $unset: { lead: 1 } }),
        BizCall.updateMany({ ...own(owner), lead: lead._id }, { $unset: { lead: 1 } }),
        BizInquiry.updateMany({ ...own(owner), lead: lead._id }, { $unset: { lead: 1 }, $set: { status: "reviewed" } }),
      ]);
      await lead.deleteOne();
      ok(res, "crmSalesLeadDeleted");
    }),
    // the lead's treatment plan, made once (Nexxa convertLeadToProforma)
    leadToPlan: h(async (owner, req, res) => {
      const lead = await leadIn(owner, req);
      if (lead.plan && (await BizPlan.exists({ _id: lead.plan }))) return ok(res, "crmSalesPlan", { _id: String(lead.plan), existed: true });
      if (!lead.contact) throw new AppError("برای ساخت طرح درمان، بیمار درخواست را مشخص کنید", 400);
      const items = lead.items.map((l) => ({ title: l.title, ref: l.ref, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount, taxRate: 0, ...(l.sessions ? { sessions: l.sessions } : {}) }));
      const plan = await BizPlan.create({
        ...own(owner),
        number: await planDocNumber(owner),
        subject: lead.title,
        contact: lead.contact,
        lead: lead._id,
        doctorName: lead.doctor?.name,
        referrerName: lead.referrerName,
        items,
        ...pricePlan(items, 0),
        token: newToken(),
        createdBy: userOf(req),
      });
      const claimed = await BizLead.updateOne({ _id: lead._id, $or: [{ plan: { $exists: false } }, { plan: lead.plan }] }, { $set: { plan: plan._id, lastActivityAt: new Date() }, ...pushHistory("plan", String(plan.number), userOf(req)) });
      if (!claimed.modifiedCount) {
        await plan.deleteOne();
        const again = await BizLead.findById(lead._id).select("plan").lean<{ plan?: unknown }>();
        return ok(res, "crmSalesPlan", { _id: String(again?.plan || ""), existed: true });
      }
      ok(res, "crmSalesPlan", { _id: String(plan._id), existed: false }, 201);
    }),

    // ------------------------------------------------------------ views
    getViews: h(async (owner, req, res) => {
      ok(
        res,
        "crmSalesViews",
        await BizSavedReport.find({ ...own(owner), kind: "view", $or: [{ createdBy: oid(userOf(req)) }, { shared: true }] }).sort({ createdAt: -1 }).lean(),
      );
    }),
    createView: h(async (owner, req, res) => {
      const d = parse(z.object({ name: text(120).min(1), shared: z.boolean().default(false), config: z.record(z.string(), z.string().max(100)).default({}) }), req.body);
      ok(res, "crmSalesView", await BizSavedReport.create({ ...own(owner), kind: "view", entity: "lead", ...d, createdBy: userOf(req) }), 201);
    }),
    deleteView: h(async (owner, req, res) => {
      // only its maker removes a view (Nexxa deletePipelineView)
      const r = await BizSavedReport.deleteOne({ ...own(owner), kind: "view", _id: param(req, "viewId"), createdBy: oid(userOf(req)) });
      if (!r.deletedCount) throw new AppError("فقط سازنده‌ی این نما آن را حذف می‌کند", 403);
      ok(res, "crmSalesViewDeleted");
    }),

    // ------------------------------------------------------------ settings
    getSettings: h(async (owner, _req, res) => ok(res, "crmSalesSettings", await settingsOf(owner))),
    updateSettings: h(async (owner, req, res) => {
      const chain = z.object({ enabled: z.boolean(), approvers: z.array(id).max(10), minAmount: money }).partial();
      const d = parse(
        z.object({
          autoAssign: z.object({ enabled: z.boolean(), users: z.array(id).max(50) }).partial().optional(),
          teamScope: z.boolean().optional(),
          approvals: z.object({ plan: chain, discount: chain, credit: chain }).partial().optional(),
          webform: z
            .object({
              enabled: z.boolean(),
              slug: z
                .string()
                .trim()
                .toLowerCase()
                .regex(/^[a-z0-9-]{3,40}$/),
              requests: z.boolean(),
              pipeline: optId,
              title: text(120),
              intro: text(600),
              thanks: text(300),
              askEmail: z.boolean(),
              askCity: z.boolean(),
              askKind: z.boolean(),
            })
            .partial()
            .optional(),
        }),
        req.body,
      );
      // what the profile does not have is not set either
      const off = (on: boolean) => {
        if (!on) throw new AppError("این بخش برای این نوع حساب نیست", 400);
      };
      if (d.teamScope !== undefined) off(salesFeatureOn(owner, "teams"));
      if (d.autoAssign) off(salesFeatureOn(owner, "assignment"));
      if (d.webform) off(salesFeatureOn(owner, "webform"));
      for (const k of ["plan", "discount", "credit"] as const) if (d.approvals?.[k]) off(salesApprovalOn(owner, k));
      const set: Record<string, unknown> = {};
      if (d.teamScope !== undefined) set.teamScope = d.teamScope;
      if (d.autoAssign?.enabled !== undefined) set["autoAssign.enabled"] = d.autoAssign.enabled;
      if (d.autoAssign?.users) set["autoAssign.users"] = await keepStaff(owner, d.autoAssign.users);
      for (const k of ["plan", "discount", "credit"] as const) {
        const c = d.approvals?.[k];
        if (!c) continue;
        if (c.enabled !== undefined) set[`approvals.${k}.enabled`] = c.enabled;
        if (c.minAmount !== undefined) set[`approvals.${k}.minAmount`] = c.minAmount;
        if (c.approvers) set[`approvals.${k}.approvers`] = await keepStaff(owner, c.approvers);
      }
      if (d.webform) {
        for (const [k, v] of Object.entries(d.webform)) if (v !== undefined && k !== "pipeline" && k !== "slug") set[`webform.${k}`] = v;
        if (d.webform.pipeline !== undefined) {
          if (d.webform.pipeline && !(await BizPipeline.exists({ ...own(owner), _id: d.webform.pipeline }))) throw new NotFoundError();
          set["webform.pipeline"] = d.webform.pipeline ? oid(d.webform.pipeline) : null;
        }
        if (d.webform.slug) {
          if (await BizCrmSettings.exists({ "webform.slug": d.webform.slug, $nor: [own(owner)] })) throw new AppError("این نشانی را مرکز دیگری گرفته است", 400);
          set["webform.slug"] = d.webform.slug;
        }
      }
      await settingsOf(owner);
      if (set["webform.enabled"] === true) {
        const cur = await BizCrmSettings.findOne(own(owner)).select("webform.slug").lean();
        if (!cur?.webform?.slug && !set["webform.slug"]) throw new AppError("نشانی فرم را بنویسید", 400);
      }
      ok(res, "crmSalesSettings", await BizCrmSettings.findOneAndUpdate(own(owner), { $set: set }, { new: true }).lean());
    }),

    // ------------------------------------------------------------ rules
    getRules: h(async (owner, req, res) => {
      const kind = req.query.kind === "score" ? "score" : "assign";
      ok(res, "crmSalesRules", await BizAssignRule.find({ ...own(owner), kind }).sort({ order: 1, createdAt: 1 }).lean());
    }),
    createRule: h(async (owner, req, res) => {
      const d = parse(
        z.object({
          kind: z.enum(["assign", "score"]).default("assign"),
          name: text(120).min(1),
          conditions: z.array(condition).max(10).default([]),
          assignType: z.enum(["user", "team"]).default("user"),
          user: optId,
          team: optId,
          stopOnMatch: z.boolean().default(true),
          points: z.coerce.number().int().min(-1000).max(1000).default(0),
          active: z.boolean().default(true),
        }),
        req.body,
      );
      if (d.kind === "score" && d.conditions.length !== 1) throw new AppError("قانون امتیاز یک شرط دارد", 400);
      if (d.kind === "assign") {
        if (d.assignType === "user" && !(d.user && (await keepStaff(owner, [d.user])).length)) throw new AppError("مسئول قانون را انتخاب کنید", 400);
        if (d.assignType === "team" && !(d.team && (await BizTeam.exists({ ...own(owner), _id: d.team })))) throw new AppError("تیم قانون را انتخاب کنید", 400);
      }
      const order = await BizAssignRule.countDocuments({ ...own(owner), kind: d.kind });
      const r = await BizAssignRule.create({ ...own(owner), ...d, user: d.user || undefined, team: d.team || undefined, order });
      if (d.kind === "score") await recomputeScores(owner);
      ok(res, "crmSalesRule", r, 201);
    }),
    updateRule: h(async (owner, req, res) => {
      const d = parse(
        z
          .object({
            name: text(120).min(1),
            conditions: z.array(condition).max(10),
            assignType: z.enum(["user", "team"]),
            user: optId,
            team: optId,
            stopOnMatch: z.boolean(),
            points: z.coerce.number().int().min(-1000).max(1000),
            active: z.boolean(),
          })
          .partial(),
        req.body,
      );
      const r = await BizAssignRule.findOne({ ...own(owner), _id: param(req, "ruleId") });
      if (!r) throw new NotFoundError();
      if (d.user) d.user = (await keepStaff(owner, [d.user])).length ? d.user : null;
      if (d.team && !(await BizTeam.exists({ ...own(owner), _id: d.team }))) d.team = null;
      Object.assign(r, { ...d, ...(d.user !== undefined ? { user: d.user || undefined } : {}), ...(d.team !== undefined ? { team: d.team || undefined } : {}) });
      if (r.kind === "score" && r.conditions.length !== 1) throw new AppError("قانون امتیاز یک شرط دارد", 400);
      await r.save();
      if (r.kind === "score") await recomputeScores(owner);
      ok(res, "crmSalesRule", r);
    }),
    // priority up / down, among rules of the same kind (Nexxa moveRule)
    moveRule: h(async (owner, req, res) => {
      const { dir } = parse(z.object({ dir: z.enum(["up", "down"]) }), req.body);
      const r = await BizAssignRule.findOne({ ...own(owner), _id: param(req, "ruleId") });
      if (!r) throw new NotFoundError();
      const list = await BizAssignRule.find({ ...own(owner), kind: r.kind }).sort({ order: 1, createdAt: 1 });
      const i = list.findIndex((x) => String(x._id) === String(r._id));
      const j = dir === "up" ? i - 1 : i + 1;
      if (j >= 0 && j < list.length) {
        [list[i], list[j]] = [list[j], list[i]];
        await Promise.all(list.map((x, k) => (x.order !== k ? BizAssignRule.updateOne({ _id: x._id }, { $set: { order: k } }) : null)));
      }
      ok(res, "crmSalesRules", await BizAssignRule.find({ ...own(owner), kind: r.kind }).sort({ order: 1 }).lean());
    }),
    deleteRule: h(async (owner, req, res) => {
      const r = await BizAssignRule.findOneAndDelete({ ...own(owner), _id: param(req, "ruleId") });
      if (!r) throw new NotFoundError();
      if (r.kind === "score") await recomputeScores(owner);
      ok(res, "crmSalesRuleDeleted");
    }),
    recompute: h(async (owner, _req, res) => ok(res, "crmSalesRecomputed", { count: await recomputeScores(owner) })),

    // ------------------------------------------------------------ teams
    getTeams: h(async (owner, _req, res) => ok(res, "crmSalesTeams", await BizTeam.find(own(owner)).sort({ createdAt: 1 }).lean())),
    saveTeam: h(async (owner, req, res) => {
      const d = parse(z.object({ name: text(80).min(1), manager: optId, members: z.array(id).max(100) }).partial(), req.body);
      const t = req.params.teamId ? await BizTeam.findOne({ ...own(owner), _id: param(req, "teamId") }) : new BizTeam({ ...own(owner) });
      if (!t) throw new NotFoundError();
      if (d.name !== undefined) t.name = d.name;
      if (!t.name) throw new AppError("نام تیم را بنویسید", 400);
      if (d.manager !== undefined) t.manager = d.manager ? ((await keepStaff(owner, [d.manager]))[0] as never) : undefined;
      if (d.members) t.members = (await keepStaff(owner, d.members)) as never;
      // the manager is always a member (Nexxa createTeam / updateTeam)
      if (t.manager && !t.members.some((m) => String(m) === String(t.manager))) t.members.push(t.manager);
      await t.save();
      ok(res, "crmSalesTeam", t, req.params.teamId ? 200 : 201);
    }),
    deleteTeam: h(async (owner, req, res) => {
      const t = await BizTeam.findOne({ ...own(owner), _id: param(req, "teamId") });
      if (!t) throw new NotFoundError();
      // no rule left pointing at nothing: a team rule falls back to its order
      await BizAssignRule.updateMany({ ...own(owner), team: t._id }, { $unset: { team: 1 }, $set: { active: false } });
      await t.deleteOne();
      ok(res, "crmSalesTeamDeleted");
    }),

    // ------------------------------------------------------------ custom fields
    getFields: h(async (owner, req, res) => {
      const entity = req.query.entity === "lead" ? "lead" : req.query.entity === "contact" ? "contact" : null;
      ok(res, "crmSalesFields", await BizCustomField.find({ ...own(owner), ...(entity ? { entity } : {}) }).sort({ entity: 1, sequence: 1, createdAt: 1 }).lean());
    }),
    createField: h(async (owner, req, res) => {
      const d = parse(
        z.object({
          entity: z.enum(["contact", "lead"]),
          label: text(80).min(1),
          type: z.enum(cfTypes).default("text"),
          options: z.array(text(80).min(1)).max(50).default([]),
          required: z.boolean().default(false),
        }),
        req.body,
      );
      if (d.type === "select" && !d.options.length) throw new AppError("گزینه‌های فهرست را بنویسید", 400);
      const taken = (await BizCustomField.find({ ...own(owner), entity: d.entity }).select("key").lean()).map((f) => f.key);
      const f = await BizCustomField.create({ ...own(owner), ...d, key: fieldKey(d.label, taken), sequence: taken.length });
      ok(res, "crmSalesField", f, 201);
    }),
    updateField: h(async (owner, req, res) => {
      // the key never changes, so saved values stay readable
      const d = parse(
        z.object({ label: text(80).min(1), type: z.enum(cfTypes), options: z.array(text(80).min(1)).max(50), required: z.boolean(), active: z.boolean(), sequence: z.coerce.number().int().min(0).max(1000) }).partial(),
        req.body,
      );
      const f = await BizCustomField.findOneAndUpdate({ ...own(owner), _id: param(req, "fieldId") }, { $set: d }, { new: true });
      if (!f) throw new NotFoundError();
      ok(res, "crmSalesField", f);
    }),
    deleteField: h(async (owner, req, res) => {
      const f = await BizCustomField.findOneAndDelete({ ...own(owner), _id: param(req, "fieldId") });
      if (!f) throw new NotFoundError();
      ok(res, "crmSalesFieldDeleted");
    }),

    // ------------------------------------------------------------ contact sales card
    getContactSales: h(async (owner, req, res) => {
      const c = await contactOf(owner, req.params.contactId);
      if (!c) throw new NotFoundError();
      const scope = await leadScope(owner, userOf(req));
      const [ext, leads, plans, contracts, carePlans, calls, credit] = await Promise.all([
        extOf(owner, c._id),
        BizLead.find({ ...own(owner), contact: c._id, ...scope }).sort({ updatedAt: -1 }).select("title status value stage pipeline kind updatedAt").limit(50).lean(),
        BizPlan.find({ ...own(owner), contact: c._id }).sort({ date: -1 }).select("number subject status total invoice date").limit(50).lean(),
        BizContract.find({ ...own(owner), contact: c._id }).sort({ startDate: -1 }).select("number subject state value startDate endDate").limit(50).lean(),
        BizCarePlan.find({ ...own(owner), contact: c._id }).sort({ createdAt: -1 }).select("name amount interval intervalCount status nextRunDate").limit(50).lean(),
        BizCall.find({ ...own(owner), contact: c._id }).sort({ startedAt: -1 }).limit(20).lean(),
        creditOf(owner, c._id),
      ]);
      ok(res, "crmSalesContact", { ext, leads, plans, contracts, carePlans, calls, credit });
    }),
    updateContactExt: h(async (owner, req, res) => {
      const d = parse(
        z
          .object({
            nationalId: z.string().trim().regex(/^\d{10}$|^$/),
            email: z.string().trim().email().max(120).or(z.literal("")),
            customFields: z.record(z.string(), z.unknown()),
            creditLimit: money,
            freeCredit: z.boolean(),
            assignee: optId,
          })
          .partial(),
        req.body,
      );
      const c = await contactOf(owner, req.params.contactId);
      if (!c) throw new NotFoundError();
      const ext = await extOf(owner, c._id);
      const set: Partial<IBizContactExt> = {};
      if (d.nationalId !== undefined) set.nationalId = d.nationalId || undefined;
      if (d.email !== undefined) set.email = d.email || undefined;
      if (d.customFields) set.customFields = await customValues(owner, "contact", d.customFields, ext.customFields);
      if (d.assignee !== undefined) set.assignee = d.assignee ? ((await keepStaff(owner, [d.assignee]))[0] as never) : undefined;
      // with a credit approval chain the limit changes only by request
      if (d.creditLimit !== undefined || d.freeCredit !== undefined) {
        const cfg = await settingsOf(owner);
        if (cfg.approvals?.credit?.enabled && String(userOf(req)) !== (await ownerUser(owner))) throw new AppError("سقف اعتبار فقط با درخواست و تأیید مدیر تغییر می‌کند", 403);
        if (d.creditLimit !== undefined) set.creditLimit = d.creditLimit;
        if (d.freeCredit !== undefined) set.freeCredit = d.freeCredit;
      }
      ok(res, "crmSalesContactExt", await BizContactExt.findOneAndUpdate({ contact: c._id }, { $set: set }, { new: true }).lean());
    }),

    // ------------------------------------------------------------ duplicates
    getDuplicates: h(async (owner, _req, res) => {
      const [contacts, exts] = await Promise.all([
        BizContact.find({ ...own(owner), isActive: true }).select("name phone user birthYear visits orders spent lastSeenAt source").limit(20000).lean<IBizContact[]>(),
        BizContactExt.find({ ...own(owner), nationalId: { $exists: true, $ne: "" } }).select("contact nationalId").lean<IBizContactExt[]>(),
      ]);
      const nid = new Map(exts.map((e) => [String(e.contact), e.nationalId]));
      const groups = duplicateGroups(
        contacts.map((c) => ({ id: String(c._id), name: c.name, nationalId: nid.get(String(c._id)), user: c.user ? String(c.user) : undefined, birthYear: c.birthYear })),
      );
      const byId = new Map(contacts.map((c) => [String(c._id), { ...c, nationalId: nid.get(String(c._id)) }]));
      ok(res, "crmSalesDuplicates", groups.slice(0, 200).map((g) => ({ ...g, contacts: g.ids.map((i) => byId.get(i)).filter(Boolean) })));
    }),
    merge: h(async (owner, req, res) => {
      const d = parse(z.object({ primary: id, duplicates: z.array(id).min(1).max(20) }), req.body);
      ok(res, "crmSalesMerged", await mergeContacts(owner, d.primary, d.duplicates));
    }),

    // ------------------------------------------------------------ plans
    getPlans: h(async (owner, req, res) => {
      const st = String(req.query.status || "");
      const term = String(req.query.q || "").trim().slice(0, 60);
      ok(
        res,
        "crmSalesPlans",
        await BizPlan.find({
          ...own(owner),
          ...(["draft", "sent", "accepted", "declined", "revised"].includes(st) ? { status: st } : {}),
          ...(isId(String(req.query.contact || "")) ? { contact: oid(req.query.contact) } : {}),
          ...(term ? { subject: new RegExp(escape(term), "i") } : {}),
        })
          .sort({ date: -1, number: -1 })
          .select("-signature -terms")
          .populate("contact", "name phone")
          .limit(500)
          .lean(),
      );
    }),
    createPlan: h(async (owner, req, res) => {
      const d = parse(planBody, req.body);
      let contact = d.contact ? await contactOf(owner, d.contact) : null;
      if (!contact && d.phone) contact = await findOrCreateContact(owner, { name: d.name, phone: d.phone });
      if (d.phone && !contact) throw new AppError("شماره‌ی موبایل معتبر نیست", 400);
      const lead = d.lead ? await BizLead.findOne({ ...own(owner), _id: d.lead }).lean<IBizLead>() : null;
      const items = cleanItems(d.items);
      const plan = await BizPlan.create({
        ...own(owner),
        number: await planDocNumber(owner),
        subject: d.subject,
        contact: contact?._id || lead?.contact,
        lead: lead?._id,
        doctorName: d.doctorName || lead?.doctor?.name,
        referrerName: d.referrerName || lead?.referrerName,
        date: dateOf(d.date) || new Date(),
        openTill: dateOf(d.openTill),
        discountPercent: d.discountPercent,
        items,
        ...pricePlan(items, d.discountPercent),
        note: d.note,
        terms: d.terms,
        token: newToken(),
        createdBy: userOf(req),
      });
      if (lead && !lead.plan) await BizLead.updateOne({ _id: lead._id }, { $set: { plan: plan._id } });
      if (plan.contact) await BizActivity.create({ ...own(owner), contact: plan.contact, kind: "note", text: `طرح درمان شماره‌ی ${plan.number.toLocaleString("fa-IR")}: ${plan.subject}`, createdBy: userOf(req) }).catch(() => {});
      ok(res, "crmSalesPlan", plan, 201);
    }),
    getPlan: h(async (owner, req, res) => {
      const plan = await BizPlan.findOne({ ...own(owner), _id: param(req, "planId") }).populate("contact", "name phone").lean<IBizPlan>();
      if (!plan) throw new NotFoundError();
      const [invoice, approvals, credit] = await Promise.all([
        plan.invoice ? BizInvoice.findById(plan.invoice).select("number status total paid").lean() : null,
        BizRequest.find({ ...own(owner), kind: { $in: ["plan", "discount"] }, plan: plan._id }).sort({ createdAt: -1 }).lean(),
        plan.contact ? creditOf(owner, (plan.contact as unknown as { _id: unknown })._id) : null,
      ]);
      ok(res, "crmSalesPlan", { ...plan, link: await planLink(plan), invoiceInfo: invoice, approvals, credit });
    }),
    updatePlan: h(async (owner, req, res) => {
      const d = parse(planPatch, req.body);
      const plan = await BizPlan.findOne({ ...own(owner), _id: param(req, "planId") });
      if (!plan) throw new NotFoundError();
      if (plan.invoice) throw new AppError("طرحی که صورتحساب شده ویرایش نمی‌شود", 400);
      if (plan.status === "accepted") throw new AppError("طرح پذیرفته‌شده ویرایش نمی‌شود؛ طرح تازه بسازید", 400);
      if (plan.approval?.status === "pending") throw new AppError("این طرح منتظر تأیید مدیر است", 400);
      if (d.subject !== undefined) plan.subject = d.subject;
      if (d.contact !== undefined) {
        const c = d.contact ? await contactOf(owner, d.contact) : null;
        plan.contact = c?._id as never;
      }
      if (d.date !== undefined) plan.date = dateOf(d.date) || plan.date;
      if (d.openTill !== undefined) plan.openTill = dateOf(d.openTill);
      if (d.note !== undefined) plan.note = d.note;
      if (d.terms !== undefined) plan.terms = d.terms;
      if (d.doctorName !== undefined) plan.doctorName = d.doctorName || undefined;
      const priceChanged = d.items !== undefined || d.discountPercent !== undefined;
      if (d.discountPercent !== undefined) plan.discountPercent = d.discountPercent;
      if (d.items) plan.items = cleanItems(d.items) as never;
      Object.assign(plan, pricePlan(plan.items, plan.discountPercent));
      // a sent plan edited goes back as a revision; an approval given for
      // the old amount does not cover a new one
      if (plan.status === "sent" || plan.status === "declined") plan.status = "revised";
      if (priceChanged && plan.approval?.status === "approved") plan.approval = { status: "none" };
      await plan.save();
      ok(res, "crmSalesPlan", plan);
    }),
    deletePlan: h(async (owner, req, res) => {
      const plan = await BizPlan.findOne({ ...own(owner), _id: param(req, "planId") });
      if (!plan) throw new NotFoundError();
      if (plan.invoice) {
        const inv = await BizInvoice.findById(plan.invoice).select("status").lean<{ status: string }>();
        if (inv && inv.status !== "void" && inv.status !== "draft") throw new AppError("این طرح صورتحساب صادرشده دارد؛ اول صورتحساب را باطل کنید", 400);
        // a draft invoice made from it goes with it
        if (inv?.status === "draft") await BizInvoice.deleteOne({ _id: plan.invoice, status: "draft" });
      }
      await Promise.all([
        BizLead.updateMany({ ...own(owner), plan: plan._id }, { $unset: { plan: 1 } }),
        cancelOpen({ ...own(owner), plan: plan._id }),
      ]);
      await plan.deleteOne();
      ok(res, "crmSalesPlanDeleted");
    }),
    sendPlan: h(async (owner, req, res) => ok(res, "crmSalesPlanSent", await sendPlan(owner, param(req, "planId"), userOf(req)))),
    // the patient's answer taken at the desk (signed on paper)
    setPlanStatus: h(async (owner, req, res) => {
      const d = parse(z.object({ status: z.enum(["accepted", "declined", "draft"]), name: text(120).optional() }), req.body);
      const plan = await BizPlan.findOne({ ...own(owner), _id: param(req, "planId") });
      if (!plan) throw new NotFoundError();
      if (plan.invoice) throw new AppError("طرحی که صورتحساب شده تغییر وضعیت نمی‌دهد", 400);
      if (d.status !== "draft" && plan.approval?.status === "pending") throw new AppError("این طرح منتظر تأیید مدیر است", 400);
      const cfg = await settingsOf(owner);
      if (d.status === "accepted" && salesApprovalOn(owner, "plan") && cfg.approvals?.plan?.enabled && plan.total >= (cfg.approvals.plan.minAmount || 0) && plan.approval?.status !== "approved")
        throw new AppError("این طرح پیش از پذیرش، تأیید مدیر لازم دارد", 400);
      plan.status = d.status;
      plan.decidedAt = d.status === "draft" ? undefined : new Date();
      if (d.status === "accepted") plan.acceptedName = d.name || plan.acceptedName;
      await plan.save();
      ok(res, "crmSalesPlan", plan);
    }),
    planInvoice: h(async (owner, req, res) => {
      const d = parse(z.object({ issue: z.boolean().default(false) }), req.body);
      ok(res, "crmSalesPlanInvoiced", await planToInvoice(owner, param(req, "planId"), userOf(req), d.issue));
    }),

    // ------------------------------------------------------------ approvals
    createApproval: h(async (owner, req, res) => {
      const d = parse(
        z.object({
          kind: z.enum(["discount", "credit"]),
          contact: optId,
          plan: optId,
          invoice: optId,
          amount: money.default(0),
          percent: pct.default(0),
          requestedLimit: money.default(0),
          description: text(1000).optional(),
        }),
        req.body,
      );
      if (d.kind === "credit") {
        const c = d.contact ? await contactOf(owner, d.contact) : null;
        if (!c) throw new AppError("بیمار یا مشتری را انتخاب کنید", 400);
        if (!(d.requestedLimit > 0)) throw new AppError("سقف اعتبار درخواستی را بنویسید", 400);
        return ok(res, "crmSalesApproval", await startApproval(owner, { kind: "credit", contact: c._id, requestedLimit: d.requestedLimit, description: d.description }, userOf(req)), 201);
      }
      if (!(d.amount > 0) && !(d.percent > 0)) throw new AppError("مبلغ یا درصد تخفیف را بنویسید", 400);
      if (d.plan) {
        const p = await BizPlan.findOne({ ...own(owner), _id: d.plan }).lean<IBizPlan>();
        if (!p) throw new NotFoundError();
        if (p.invoice || p.status === "accepted") throw new AppError("طرح دیگر قابل تخفیف نیست", 400);
        return ok(res, "crmSalesApproval", await startApproval(owner, { kind: "discount", plan: p._id, contact: p.contact, amount: d.amount, percent: d.percent, description: d.description }, userOf(req)), 201);
      }
      if (d.invoice) {
        const inv = await BizInvoice.findOne({ ...own(owner), _id: d.invoice }).select("status total").lean<{ _id: unknown; status: string; total: number }>();
        if (!inv) throw new NotFoundError();
        if (inv.status !== "draft") throw new AppError("تخفیف فقط روی صورتحساب پیش‌نویس اعمال می‌شود", 400);
        if (d.amount > inv.total) throw new AppError("تخفیف از مبلغ صورتحساب بیشتر است", 400);
        return ok(res, "crmSalesApproval", await startApproval(owner, { kind: "discount", invoice: inv._id, contact: d.contact, amount: d.amount, percent: d.percent, description: d.description }, userOf(req)), 201);
      }
      throw new AppError("طرح درمان یا صورتحساب را انتخاب کنید", 400);
    }),
    // the draft invoices a discount can be asked for
    getDraftInvoices: h(async (owner, _req, res) =>
      ok(res, "crmSalesDraftInvoices", await BizInvoice.find({ ...own(owner), status: "draft" }).sort({ date: -1 }).select("number party total date").limit(200).lean()),
    ),

    // ------------------------------------------------------------ contracts
    getContracts: h(async (owner, req, res) => {
      const st = String(req.query.state || "");
      ok(
        res,
        "crmSalesContracts",
        await BizContract.find({ ...own(owner), ...(["draft", "active", "expired", "canceled"].includes(st) ? { state: st } : {}) })
          .sort({ startDate: -1 })
          .select("-content -signature -members")
          .populate("contact", "name phone")
          .populate("type", "name")
          .limit(500)
          .lean(),
      );
    }),
    createContract: h(async (owner, req, res) => {
      const d = parse(contractBody, req.body);
      const contact = d.contact ? await contactOf(owner, d.contact) : null;
      if (!contact && !d.party?.name) throw new AppError("طرف قرارداد را مشخص کنید", 400);
      const type = d.type ? await BizContentBlock.findOne({ ...own(owner), kind: "type", _id: d.type }).lean() : null;
      const start = dateOf(d.startDate) || new Date();
      const end = dateOf(d.endDate);
      if (end && end < start) throw new AppError("پایان قرارداد پیش از شروع آن است", 400);
      const c = await BizContract.create({
        ...own(owner),
        number: await nextDocNumber("crmContract", owner),
        subject: d.subject,
        contact: contact?._id,
        party: d.party?.name ? d.party : { name: contact?.name || contact?.phone || "", phone: contact?.phone, kind: "person" },
        type: type?._id,
        value: Math.round(d.value),
        startDate: start,
        endDate: end,
        content: d.content,
        note: d.note,
        token: newToken(),
        createdBy: userOf(req),
      });
      ok(res, "crmSalesContract", c, 201);
    }),
    getContract: h(async (owner, req, res) => {
      const c = await BizContract.findOne({ ...own(owner), _id: param(req, "contractId") }).populate("contact", "name phone").populate("type", "name").lean<IBizContract>();
      if (!c) throw new NotFoundError();
      const invoice = c.invoice ? await BizInvoice.findById(c.invoice).select("number status total paid").lean() : null;
      ok(res, "crmSalesContract", { ...c, link: await contractLink(c), invoiceInfo: invoice });
    }),
    updateContract: h(async (owner, req, res) => {
      const d = parse(contractPatch, req.body);
      const c = await BizContract.findOne({ ...own(owner), _id: param(req, "contractId") });
      if (!c) throw new NotFoundError();
      // a signed text is what was signed: only the note and the end date move
      if (c.signed && (d.content !== undefined || d.value !== undefined || d.subject !== undefined))
        throw new AppError("متن و مبلغ قرارداد امضاشده تغییر نمی‌کند؛ قرارداد تازه یا الحاقیه بسازید", 400);
      if (d.subject) c.subject = d.subject;
      if (d.contact !== undefined) c.contact = (d.contact ? (await contactOf(owner, d.contact))?._id : undefined) as never;
      if (d.party) c.party = d.party as never;
      if (d.type !== undefined) c.type = (d.type ? (await BizContentBlock.findOne({ ...own(owner), kind: "type", _id: d.type }).lean())?._id : undefined) as never;
      if (d.value !== undefined) {
        if (c.invoice) throw new AppError("مبلغ قراردادی که صورتحساب شده تغییر نمی‌کند", 400);
        c.value = Math.round(d.value);
      }
      if (d.startDate) c.startDate = dateOf(d.startDate)!;
      if (d.endDate !== undefined) {
        c.endDate = dateOf(d.endDate);
        c.renewNotifiedAt = undefined;
        if (c.state === "expired" && c.endDate && c.endDate > new Date()) c.state = "active";
      }
      if (c.endDate && c.endDate < c.startDate) throw new AppError("پایان قرارداد پیش از شروع آن است", 400);
      if (d.content !== undefined) c.content = d.content;
      if (d.note !== undefined) c.note = d.note;
      await c.save();
      ok(res, "crmSalesContract", c);
    }),
    // sign (in person) / activate / cancel / reopen (Nexxa setContractState)
    setContractState: h(async (owner, req, res) => {
      const d = parse(z.object({ action: z.enum(["sign", "activate", "cancel", "reopen"]), name: text(120).optional() }), req.body);
      const c = await BizContract.findOne({ ...own(owner), _id: param(req, "contractId") });
      if (!c) throw new NotFoundError();
      if (d.action === "sign") {
        if (c.signed) throw new AppError("این قرارداد قبلاً امضا شده است", 400);
        c.signed = true;
        c.signedAt = new Date();
        c.signerName = d.name || c.party?.name;
        c.state = "active";
      } else if (d.action === "activate") c.state = "active";
      else if (d.action === "cancel") c.state = "canceled";
      else {
        c.state = "draft";
      }
      await c.save();
      ok(res, "crmSalesContract", c);
    }),
    deleteContract: h(async (owner, req, res) => {
      const c = await BizContract.findOne({ ...own(owner), _id: param(req, "contractId") });
      if (!c) throw new NotFoundError();
      if (c.invoice) {
        const inv = await BizInvoice.findById(c.invoice).select("status").lean<{ status: string }>();
        if (inv && inv.status !== "void" && inv.status !== "draft") throw new AppError("این قرارداد صورتحساب صادرشده دارد؛ اول صورتحساب را باطل کنید", 400);
        if (inv?.status === "draft") await BizInvoice.deleteOne({ _id: c.invoice, status: "draft" });
      }
      await c.deleteOne();
      ok(res, "crmSalesContractDeleted");
    }),
    contractInvoice: h(async (owner, req, res) => ok(res, "crmSalesContractInvoiced", await contractToInvoice(owner, param(req, "contractId"), userOf(req)))),
    sendContract: h(async (owner, req, res) => ok(res, "crmSalesContractSent", await sendContract(owner, param(req, "contractId")))),
    // the people a corporate contract covers: one by one or pasted as lines
    // ("name, mobile, national id, relation"); each matched to a contact
    addMembers: h(async (owner, req, res) => {
      const d = parse(
        z.object({ members: z.array(z.object({ name: text(120).min(1), phone: text(20).optional(), nationalId: text(10).optional(), relation: text(40).optional() })).min(1).max(2000) }),
        req.body,
      );
      const c = await BizContract.findOne({ ...own(owner), _id: param(req, "contractId") });
      if (!c) throw new NotFoundError();
      if (c.members.length + d.members.length > 5000) throw new AppError("هر قرارداد حداکثر ۵۰۰۰ نفر دارد", 400);
      let added = 0;
      for (const m of d.members) {
        const nid = (m.nationalId || "").replace(/\D/g, "");
        if (nid && c.members.some((x) => x.nationalId === nid)) continue;
        const contact = m.phone ? await findOrCreateContact(owner, { name: m.name, phone: m.phone }) : null;
        if (contact && nid) await BizContactExt.updateOne({ contact: contact._id, nationalId: { $exists: false } }, { $set: { nationalId: nid } }).catch(() => {});
        c.members.push({ name: m.name, phone: contact?.phone || m.phone, nationalId: nid || undefined, relation: m.relation, contact: contact?._id } as never);
        added++;
      }
      await c.save();
      ok(res, "crmSalesContractMembers", { added, total: c.members.length });
    }),
    removeMember: h(async (owner, req, res) => {
      const r = await BizContract.updateOne({ ...own(owner), _id: param(req, "contractId") }, { $pull: { members: { _id: oid(param(req, "memberId")) } } });
      if (!r.matchedCount) throw new NotFoundError();
      ok(res, "crmSalesContractMemberRemoved");
    }),
    // the contract's text kept as a template (Nexxa saveContractTemplate)
    contractTemplate: h(async (owner, req, res) => {
      const { name } = parse(z.object({ name: text(120).min(1) }), req.body);
      const c = await BizContract.findOne({ ...own(owner), _id: param(req, "contractId") }).select("content").lean();
      if (!c) throw new NotFoundError();
      if (!c.content) throw new AppError("متن قرارداد خالی است", 400);
      ok(res, "crmSalesBlock", await BizContentBlock.create({ ...own(owner), kind: "template", name, body: c.content }), 201);
    }),

    // ------------------------------------------------------------ library
    getBlocks: h(async (owner, req, res) => {
      const kind = String(req.query.kind || "");
      ok(res, "crmSalesBlocks", await BizContentBlock.find({ ...own(owner), ...(["type", "clause", "template"].includes(kind) ? { kind } : {}) }).sort({ kind: 1, name: 1 }).lean());
    }),
    saveBlock: h(async (owner, req, res) => {
      const d = parse(z.object({ kind: z.enum(["type", "clause", "template"]), name: text(120).min(1), body: z.string().max(60000).optional() }).partial(), req.body);
      const b = req.params.blockId ? await BizContentBlock.findOne({ ...own(owner), _id: param(req, "blockId") }) : new BizContentBlock({ ...own(owner), kind: d.kind });
      if (!b) throw new NotFoundError();
      if (d.name !== undefined) b.name = d.name;
      if (d.body !== undefined) b.body = d.body;
      if (!b.name) throw new AppError("نام را بنویسید", 400);
      if (b.kind !== "type" && !b.body?.trim()) throw new AppError("متن را بنویسید", 400);
      await b.save();
      ok(res, "crmSalesBlock", b, req.params.blockId ? 200 : 201);
    }),
    deleteBlock: h(async (owner, req, res) => {
      const b = await BizContentBlock.findOne({ ...own(owner), _id: param(req, "blockId") });
      if (!b) throw new NotFoundError();
      // its contracts keep going without a type (Nexxa deleteContractType)
      if (b.kind === "type") await BizContract.updateMany({ ...own(owner), type: b._id }, { $unset: { type: 1 } });
      await b.deleteOne();
      ok(res, "crmSalesBlockDeleted");
    }),

    // ------------------------------------------------------------ care plans
    getCarePlans: h(async (owner, req, res) => {
      const st = String(req.query.status || "");
      ok(
        res,
        "crmSalesCarePlans",
        await BizCarePlan.find({ ...own(owner), ...(["active", "paused", "canceled"].includes(st) ? { status: st } : {}) })
          .sort({ status: 1, nextRunDate: 1 })
          .populate("contact", "name phone")
          .limit(1000)
          .lean(),
      );
    }),
    createCarePlan: h(async (owner, req, res) => {
      const d = parse(carePlanBody, req.body);
      const c = await contactOf(owner, d.contact);
      if (!c) throw new AppError("بیمار برنامه را انتخاب کنید", 400);
      const start = dateOf(d.startDate) || new Date();
      const end = dateOf(d.endDate);
      if (end && end < start) throw new AppError("پایان برنامه پیش از شروع آن است", 400);
      const cp = await BizCarePlan.create({ ...own(owner), ...d, contact: c._id, startDate: start, endDate: end, nextRunDate: start, createdBy: userOf(req) });
      ok(res, "crmSalesCarePlan", cp, 201);
    }),
    updateCarePlan: h(async (owner, req, res) => {
      // the parameters change; the next due date is left as it is (Nexxa)
      const d = parse(carePlanPatch, req.body);
      const cp = await BizCarePlan.findOne({ ...own(owner), _id: param(req, "carePlanId") });
      if (!cp) throw new NotFoundError();
      Object.assign(cp, { ...d, ...(d.endDate !== undefined ? { endDate: dateOf(d.endDate) } : {}) });
      if (cp.endDate && cp.endDate < cp.startDate) throw new AppError("پایان برنامه پیش از شروع آن است", 400);
      await cp.save();
      ok(res, "crmSalesCarePlan", cp);
    }),
    setCarePlanStatus: h(async (owner, req, res) => {
      const { status } = parse(z.object({ status: z.enum(["active", "paused", "canceled"]) }), req.body);
      const cp = await BizCarePlan.findOne({ ...own(owner), _id: param(req, "carePlanId") });
      if (!cp) throw new NotFoundError();
      cp.status = status;
      // resumed after a long pause: periods missed while paused are not billed
      if (status === "active" && cp.nextRunDate < new Date(Date.now() - 86_400_000)) {
        let next = cp.nextRunDate;
        while (next < new Date()) next = advancePeriod(next, cp.interval, cp.intervalCount);
        cp.nextRunDate = next;
      }
      await cp.save();
      ok(res, "crmSalesCarePlan", cp);
    }),
    deleteCarePlan: h(async (owner, req, res) => {
      // its invoices stay; only the link goes (Nexxa deleteSubscription)
      const cp = await BizCarePlan.findOneAndDelete({ ...own(owner), _id: param(req, "carePlanId") });
      if (!cp) throw new NotFoundError();
      ok(res, "crmSalesCarePlanDeleted");
    }),
    runCarePlan: h(async (owner, req, res) => ok(res, "crmSalesCarePlanRun", { invoice: await runCarePlanNow(owner, param(req, "carePlanId"), userOf(req)) })),
    runDueCarePlans: h(async (owner, _req, res) => ok(res, "crmSalesCarePlansRun", { count: await runDueCarePlans(owner) })),

    // ------------------------------------------------------------ inquiries
    getInquiries: h(async (owner, req, res) => {
      const st = String(req.query.status || "");
      ok(res, "crmSalesInquiries", await BizInquiry.find({ ...own(owner), ...(["new", "reviewed", "converted", "closed"].includes(st) ? { status: st } : {}) }).sort({ createdAt: -1 }).limit(1000).lean());
    }),
    createInquiry: h(async (owner, req, res) => {
      const d = parse(
        z.object({
          name: text(120).min(1),
          phone: text(20).optional(),
          email: z.string().trim().email().max(120).optional().or(z.literal("")),
          company: text(120).optional(),
          subject: text(200).min(1),
          description: text(2000).optional(),
          kind: z.enum(bizLeadKinds).optional(),
          budget: money.default(0),
          address: text(500).optional(),
          preferredAt: text(120).optional(),
          referrerName: text(120).optional(),
        }),
        req.body,
      );
      const phone = d.phone ? normalizeMobile(d.phone) : undefined;
      if (d.phone && !phone) throw new AppError("شماره‌ی موبایل معتبر نیست", 400);
      ok(res, "crmSalesInquiry", await BizInquiry.create({ ...own(owner), ...d, email: d.email || undefined, phone: phone || undefined, source: "manual" }), 201);
    }),
    updateInquiry: h(async (owner, req, res) => {
      const d = parse(
        z.object({ status: z.enum(["new", "reviewed", "closed"]), subject: text(200).min(1), description: text(2000), budget: money, address: text(500), preferredAt: text(120), referrerName: text(120) }).partial(),
        req.body,
      );
      const q = await BizInquiry.findOne({ ...own(owner), _id: param(req, "inquiryId") });
      if (!q) throw new NotFoundError();
      if (q.status === "converted" && d.status) throw new AppError("این درخواست به پرونده‌ی درمان تبدیل شده است", 400);
      Object.assign(q, d);
      await q.save();
      ok(res, "crmSalesInquiry", q);
    }),
    deleteInquiry: h(async (owner, req, res) => {
      const q = await BizInquiry.findOneAndDelete({ ...own(owner), _id: param(req, "inquiryId") });
      if (!q) throw new NotFoundError();
      if (q.lead) await BizLead.updateOne({ ...own(owner), _id: q.lead }, { $unset: { inquiry: 1 } });
      ok(res, "crmSalesInquiryDeleted");
    }),
    convertInquiry: h(async (owner, req, res) => ok(res, "crmSalesInquiryConverted", await inquiryToLead(owner, param(req, "inquiryId"), userOf(req)))),

    // ------------------------------------------------------------ calls
    getCalls: h(async (owner, req, res) => {
      const dir = String(req.query.direction || "");
      ok(
        res,
        "crmSalesCalls",
        await BizCall.find({
          ...own(owner),
          ...(isId(String(req.query.contact || "")) ? { contact: oid(req.query.contact) } : {}),
          ...(["inbound", "outbound"].includes(dir) ? { direction: dir } : {}),
          ...(bizCallStatuses.includes(req.query.status as never) ? { status: req.query.status } : {}),
        })
          .sort({ startedAt: -1 })
          .populate("contact", "name phone")
          .populate("lead", "title")
          .limit(1000)
          .lean(),
      );
    }),
    saveCall: h(async (owner, req, res) => {
      const d = parse(
        z
          .object({
            contact: optId,
            phone: text(20),
            name: text(120),
            lead: optId,
            direction: z.enum(["inbound", "outbound"]),
            status: z.enum(bizCallStatuses),
            startedAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
            durationSec: z.coerce.number().int().min(0).max(86400),
            summary: text(4000),
            nextAction: text(300),
            assignee: optId,
          })
          .partial(),
        req.body,
      );
      const editing = !!req.params.callId;
      const call = editing ? await BizCall.findOne({ ...own(owner), _id: param(req, "callId") }) : new BizCall({ ...own(owner), createdBy: userOf(req) });
      if (!call) throw new NotFoundError();
      // a contact or a lead of another owner is dropped (Nexxa createCall)
      if (d.contact !== undefined) call.contact = (d.contact ? (await contactOf(owner, d.contact))?._id : undefined) as never;
      if (!call.contact && d.phone) {
        const c = await findOrCreateContact(owner, { name: d.name, phone: d.phone });
        if (c) call.contact = c._id as never;
      }
      if (d.lead !== undefined) call.lead = (d.lead ? (await BizLead.findOne({ ...own(owner), _id: d.lead }).select("_id contact").lean())?._id : undefined) as never;
      if (d.assignee !== undefined) call.assignee = (d.assignee ? (await keepStaff(owner, [d.assignee]))[0] : undefined) as never;
      if (!editing && !call.assignee && userOf(req)) call.assignee = oid(userOf(req)) as never;
      if (d.direction) call.direction = d.direction;
      if (d.status) call.status = d.status;
      if (d.phone !== undefined) call.phone = d.phone || undefined;
      if (d.startedAt) call.startedAt = dateOf(d.startedAt)!;
      if (d.durationSec !== undefined) call.durationSec = d.durationSec;
      if (d.summary !== undefined) call.summary = d.summary;
      if (d.nextAction !== undefined) call.nextAction = d.nextAction;
      if (!call.contact && !call.phone) throw new AppError("بیمار یا شماره‌ی تماس را مشخص کنید", 400);
      if (!call.phone && call.contact) call.phone = (await BizContact.findById(call.contact).select("phone").lean<{ phone: string }>())?.phone;
      // the timeline entry follows the call
      const line = [call.direction === "inbound" ? "تماس ورودی" : "تماس خروجی", call.summary].filter(Boolean).join(": ").slice(0, 1000);
      if (call.activity && (!call.contact || !(await BizActivity.exists({ _id: call.activity, contact: call.contact })))) {
        await BizActivity.deleteOne({ _id: call.activity });
        call.activity = undefined;
      }
      if (call.contact) {
        if (call.activity) await BizActivity.updateOne({ _id: call.activity }, { $set: { text: line } });
        else call.activity = (await BizActivity.create({ ...own(owner), contact: call.contact, kind: "call", text: line, createdBy: userOf(req) }))._id as never;
      }
      await call.save();
      if (call.lead) await BizLead.updateOne({ _id: call.lead }, { $set: { lastActivityAt: new Date() } });
      ok(res, "crmSalesCall", call, editing ? 200 : 201);
    }),
    deleteCall: h(async (owner, req, res) => {
      const call = await BizCall.findOneAndDelete({ ...own(owner), _id: param(req, "callId") });
      if (!call) throw new NotFoundError();
      if (call.activity) await BizActivity.deleteOne({ _id: call.activity });
      ok(res, "crmSalesCallDeleted");
    }),

    // ------------------------------------------------------------ goals
    getGoals: h(async (owner, _req, res) => {
      const goals = await BizGoal.find(own(owner)).sort({ endDate: -1 }).limit(200).lean<IBizGoal[]>();
      ok(res, "crmSalesGoals", await Promise.all(goals.map((g) => goalView(owner, g))));
    }),
    saveGoal: h(async (owner, req, res) => {
      const f = await goalFields(owner, parse(goalBody, req.body));
      const g = req.params.goalId
        ? await BizGoal.findOneAndUpdate({ ...own(owner), _id: param(req, "goalId") }, { $set: f, ...(f.assignee ? {} : { $unset: { assignee: 1 } }) }, { new: true })
        : await BizGoal.create({ ...own(owner), ...f });
      if (!g) throw new NotFoundError();
      ok(res, "crmSalesGoal", await goalView(owner, g.toObject() as IBizGoal), req.params.goalId ? 200 : 201);
    }),
    deleteGoal: h(async (owner, req, res) => {
      if (!(await BizGoal.findOneAndDelete({ ...own(owner), _id: param(req, "goalId") }))) throw new NotFoundError();
      ok(res, "crmSalesGoalDeleted");
    }),

    // ------------------------------------------------------------ commission
    getCommissions: h(async (owner, _req, res) => {
      const rules = await BizCommissionRule.find(own(owner)).sort({ periodEnd: -1 }).limit(200).lean<IBizCommissionRule[]>();
      ok(res, "crmSalesCommissions", await Promise.all(rules.map(async (r) => ({ ...r, result: r.active ? await commissionResult(owner, r).catch(() => null) : null }))));
    }),
    saveCommission: h(async (owner, req, res) => {
      const d = parse(commissionBody, req.body);
      if (d.user ? !(await keepStaff(owner, [d.user])).length : !d.doctorName) throw new AppError("کارمند یا پزشک این کمیسیون را انتخاب کنید", 400);
      const range = d.period === "custom" ? { start: dateOf(d.periodStart), end: dateOf(d.periodEnd) } : periodRange(d.period, dateOf(d.periodStart) || new Date());
      if (!range.start || !range.end || range.end <= range.start) throw new AppError("بازه‌ی کمیسیون معتبر نیست", 400);
      const fields = { ...d, user: d.user ? oid(d.user) : undefined, doctorName: d.user ? undefined : d.doctorName, periodStart: range.start, periodEnd: range.end };
      const r = req.params.ruleId
        ? await BizCommissionRule.findOneAndUpdate({ ...own(owner), _id: param(req, "ruleId") }, { $set: fields }, { new: true })
        : await BizCommissionRule.create({ ...own(owner), ...fields });
      if (!r) throw new NotFoundError();
      ok(res, "crmSalesCommission", r, req.params.ruleId ? 200 : 201);
    }),
    deleteCommission: h(async (owner, req, res) => {
      if (!(await BizCommissionRule.findOneAndDelete({ ...own(owner), _id: param(req, "ruleId") }))) throw new NotFoundError();
      ok(res, "crmSalesCommissionDeleted");
    }),

    // ------------------------------------------------------------ day plan
    getDayPlan: h(async (owner, req, res) => {
      const want = String(req.query.user || "me");
      const me = userOf(req);
      const top = await ownerUser(owner);
      // someone else's plan: the owner, or that person's team manager
      let user: string | null = want === "all" ? null : want === "me" ? me || null : want;
      if (user && user !== me && me !== top) {
        const manages = await BizTeam.exists({ ...own(owner), manager: oid(me), members: oid(user) });
        if (!manages) user = me || null;
      }
      if (!user && me !== top) user = me || null;
      ok(res, "crmSalesDayPlan", await dayPlan(owner, user));
    }),
    completeTask: h(async (owner, req, res) => {
      const d = parse(z.object({ kind: z.enum(["lead", "followUp", "overdueClose", "refill"]), id: text(40).min(1), note: text(900).optional() }), req.body);
      await completeTask(owner, d, userOf(req));
      ok(res, "crmSalesTaskDone");
    }),

    // ------------------------------------------------------------ reports
    getReport: h(async (owner, req, res) => {
      const from = dateOf(String(req.query.from || "")) || new Date(Date.now() - 90 * 86_400_000);
      const to = dateOf(String(req.query.to || "")) || new Date();
      const leads = await BizLead.find({ ...own(owner), createdAt: { $gte: from, $lte: to } })
        .select("status value probability assignee lostReason kind sourceName createdAt closedAt doctor referrerName")
        .lean<IBizLead[]>();
      const open = leads.filter((l) => l.status === "open");
      const won = leads.filter((l) => l.status === "won");
      const lost = leads.filter((l) => l.status === "lost");
      const cycle = won.filter((l) => l.closedAt).map((l) => (+new Date(l.closedAt!) - +new Date(l.createdAt)) / 86_400_000);
      const group = <K extends string>(rows: IBizLead[], key: (l: IBizLead) => K | undefined) => {
        const m = new Map<string, { key: string; count: number; won: number; lost: number; value: number; wonValue: number }>();
        for (const l of rows) {
          const k = key(l) || "";
          const e = m.get(k) || { key: k, count: 0, won: 0, lost: 0, value: 0, wonValue: 0 };
          e.count++;
          e.value += l.value || 0;
          if (l.status === "won") {
            e.won++;
            e.wonValue += l.value || 0;
          }
          if (l.status === "lost") e.lost++;
          m.set(k, e);
        }
        return [...m.values()].sort((a, b) => b.count - a.count);
      };
      const plans = await BizPlan.find({ ...own(owner), status: "accepted", decidedAt: { $gte: from, $lte: to } }).select("items discountPercent").lean<IBizPlan[]>();
      const services = new Map<string, { title: string; qty: number; value: number }>();
      for (const p of plans) {
        const { rows } = (await import("../Lib/business/crmSalesCore")).planTotals(p.items, p.discountPercent);
        p.items.forEach((it, i) => {
          const e = services.get(it.title) || { title: it.title, qty: 0, value: 0 };
          e.qty += it.qty;
          e.value += rows[i].net;
          services.set(it.title, e);
        });
      }
      ok(res, "crmSalesReport", {
        from,
        to,
        count: leads.length,
        openValue: open.reduce((s, l) => s + (l.value || 0), 0),
        weighted: Math.round(open.reduce((s, l) => s + ((l.value || 0) * (l.probability || 0)) / 100, 0)),
        wonValue: won.reduce((s, l) => s + (l.value || 0), 0),
        lostValue: lost.reduce((s, l) => s + (l.value || 0), 0),
        winRate: won.length + lost.length ? won.length / (won.length + lost.length) : 0,
        cycleDays: cycle.length ? Math.round(cycle.reduce((s, x) => s + x, 0) / cycle.length) : null,
        byAssignee: group(leads, (l) => (l.assignee ? String(l.assignee) : undefined)),
        byKind: group(leads, (l) => l.kind),
        bySource: group(leads, (l) => l.sourceName),
        lossReasons: group(lost, (l) => l.lostReason),
        byDoctor: group(leads.filter((l) => l.doctor?.name), (l) => l.doctor?.name),
        byReferrer: group(leads.filter((l) => l.referrerName), (l) => l.referrerName),
        topServices: [...services.values()].sort((a, b) => b.value - a.value).slice(0, 15),
      });
    }),
    // the report builder: one entity grouped by one field, one measure
    runReport: h(async (owner, req, res) => {
      const d = parse(
        z.object({
          entity: z.enum(["lead", "contact", "plan"]),
          groupBy: z.string().max(30),
          measure: z.enum(["count", "sum"]).default("count"),
          status: z.string().max(20).optional(),
          from: day,
          to: day,
        }),
        req.body,
      );
      const range = d.from || d.to ? { createdAt: { ...(d.from ? { $gte: dateOf(d.from) } : {}), ...(d.to ? { $lte: dateOf(d.to) } : {}) } } : {};
      const allowed: Record<string, string[]> = {
        lead: ["status", "kind", "stage", "sourceName", "assignee", "priority", "lostReason", "month"],
        contact: ["source", "insurer", "city", "gender", "tags", "month"],
        plan: ["status", "createdBy", "month"],
      };
      if (!allowed[d.entity].includes(d.groupBy)) throw new BadInputError();
      const model = d.entity === "lead" ? BizLead : d.entity === "plan" ? BizPlan : BizContact;
      const sumField = d.entity === "lead" ? "$value" : d.entity === "plan" ? "$total" : "$spent";
      const key = d.groupBy === "month" ? { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "Asia/Tehran" } } : `$${d.groupBy}`;
      const rows = await (model as unknown as typeof BizLead).aggregate<{ _id: unknown; count: number; sum: number }>([
        { $match: { ...own(owner), ...range, ...(d.status ? { status: d.status } : {}), ...(d.entity === "contact" ? { isActive: true } : {}) } },
        ...(d.groupBy === "tags" ? [{ $unwind: { path: "$tags", preserveNullAndEmptyArrays: true } }] : []),
        { $group: { _id: key, count: { $sum: 1 }, sum: { $sum: sumField } } },
        { $sort: { [d.measure === "sum" ? "sum" : "count"]: -1 } },
        { $limit: 200 },
      ]);
      ok(res, "crmSalesReportRun", rows.map((r) => ({ key: r._id === null || r._id === undefined ? "" : String(r._id), count: r.count, sum: Math.round(r.sum || 0) })));
    }),
    getReports: h(async (owner, _req, res) => ok(res, "crmSalesReports", await BizSavedReport.find({ ...own(owner), kind: "report" }).sort({ createdAt: -1 }).lean())),
    saveReport: h(async (owner, req, res) => {
      const d = parse(z.object({ name: text(120).min(1), entity: z.enum(["lead", "contact", "plan"]), config: z.record(z.string(), z.string().max(40)).default({}) }), req.body);
      ok(res, "crmSalesSavedReport", await BizSavedReport.create({ ...own(owner), kind: "report", ...d, createdBy: userOf(req) }), 201);
    }),
    deleteReport: h(async (owner, req, res) => {
      if (!(await BizSavedReport.findOneAndDelete({ ...own(owner), kind: "report", _id: param(req, "reportId") }))) throw new NotFoundError();
      ok(res, "crmSalesSavedReportDeleted");
    }),
    staffCheck: h(async (owner, _req, res) => ok(res, "crmSalesStaff", [...(await staffIds(owner))])),
  };
};

// the routes, mounted inside the panel's /crm router (Routers/crmRoutes.ts)
export const mountCrmSales = (router: express.Router, { ownerOf, read, write }: { ownerOf: OwnerOf; read: RequestHandler[]; write: RequestHandler[] }) => {
  const c = makeCrmSalesController(ownerOf);
  // what a profile does not have (Lib/business/crmProfiles.ts
  // SALES_FEATURES, the twin of the frontend's PROFILES): a pharmacy has no
  // lead funnel, a doctor no teams, commission or approvals, ...
  // (these run before the panel's access middleware: the profile is the
  // panel's kind, OwnerOf.kind)
  const onlyIf =
    (test: (owner: BizOwner, req: Request) => boolean): RequestHandler =>
    (req, _res, next) => {
      const kind = ownerOf.kind || ownerOf(req)?.kind;
      if (kind && !test({ kind } as BizOwner, req)) return next(new AppError("این بخش برای این نوع حساب نیست", 400));
      next();
    };
  const part = (p: SalesPart) => onlyIf((o) => salesPartOn(o, p));
  const feature = (f: SalesFeature) => onlyIf((o) => salesFeatureOn(o, f));
  router.use(["/pipelines", "/leads", "/lead-views", "/lead-sources"], feature("funnel"));
  router.use("/inquiries", part("inquiries"));
  router.use("/plans", part("plans"));
  router.use(["/contracts", "/contract-blocks"], part("contracts"));
  router.use("/care-plans", part("carePlans"));
  router.use("/calls", part("calls"));
  router.use("/goals", part("targets"));
  router.use(["/sales/report", "/sales/reports"], part("reports"));
  router.use("/teams", feature("teams"));
  router.use("/commissions", feature("commission"));
  // assignment rules and scoring rules share /rules (kind=assign|score)
  router.use(
    "/rules",
    onlyIf((o, req) => {
      const kind = String((req.query.kind as string) || (req.body as { kind?: string } | undefined)?.kind || "");
      if (kind === "score") return salesFeatureOn(o, "scoring");
      if (kind === "assign") return salesFeatureOn(o, "assignment");
      return salesFeatureOn(o, "scoring") || salesFeatureOn(o, "assignment");
    }),
  );
  // a discount or a credit limit asked for: the profile's approval kinds
  router.use(
    "/approvals",
    onlyIf((o, req) => {
      if (req.method === "GET") return salesApprovalOn(o, "discount");
      const kind = (req.body as { kind?: string } | undefined)?.kind;
      return kind === "discount" || kind === "credit" ? salesApprovalOn(o, kind) : salesApprovalOn(o, "discount") || salesApprovalOn(o, "credit");
    }),
  );
  router.get("/sales/meta", ...read, c.getMeta);
  router.get("/sales/catalog", ...read, c.getCatalog);
  router.get("/sales/settings", ...read, c.getSettings);
  router.patch("/sales/settings", ...write, c.updateSettings);
  router.get("/sales/report", ...read, c.getReport);
  router.post("/sales/report/run", ...read, c.runReport);
  router.get("/sales/reports", ...read, c.getReports);
  router.post("/sales/reports", ...write, c.saveReport);
  router.delete("/sales/reports/:reportId", ...write, c.deleteReport);

  router.post("/pipelines", ...write, c.createPipeline);
  router.patch("/pipelines/:pipelineId", ...write, c.updatePipeline);
  router.delete("/pipelines/:pipelineId", ...write, c.deletePipeline);
  router.post("/pipelines/:pipelineId/stages", ...write, c.createStage);
  router.patch("/pipelines/:pipelineId/stages/:stageId", ...write, c.updateStage);
  router.post("/pipelines/:pipelineId/stages/:stageId/move", ...write, c.moveStage);
  router.delete("/pipelines/:pipelineId/stages/:stageId", ...write, c.deleteStage);

  router.post("/lead-sources", ...write, c.createSource);
  router.patch("/lead-sources/:sourceId", ...write, c.updateSource);
  router.delete("/lead-sources/:sourceId", ...write, c.deleteSource);

  router.get("/leads", ...read, c.getLeads);
  router.post("/leads", ...write, c.createLead);
  router.get("/leads/:leadId", ...read, c.getLead);
  router.patch("/leads/:leadId", ...write, c.updateLead);
  router.post("/leads/:leadId/move", ...write, c.moveLead);
  router.post("/leads/:leadId/status", ...write, c.setLeadStatus);
  router.post("/leads/:leadId/plan", ...write, c.leadToPlan);
  router.delete("/leads/:leadId", ...write, c.deleteLead);
  router.get("/lead-views", ...read, c.getViews);
  router.post("/lead-views", ...write, c.createView);
  router.delete("/lead-views/:viewId", ...write, c.deleteView);

  router.get("/rules", ...read, c.getRules);
  router.post("/rules", ...write, c.createRule);
  router.post("/rules/recompute", ...write, c.recompute);
  router.patch("/rules/:ruleId", ...write, c.updateRule);
  router.post("/rules/:ruleId/move", ...write, c.moveRule);
  router.delete("/rules/:ruleId", ...write, c.deleteRule);

  router.get("/teams", ...read, c.getTeams);
  router.post("/teams", ...write, c.saveTeam);
  router.patch("/teams/:teamId", ...write, c.saveTeam);
  router.delete("/teams/:teamId", ...write, c.deleteTeam);

  router.get("/custom-fields", ...read, c.getFields);
  router.post("/custom-fields", ...write, c.createField);
  router.patch("/custom-fields/:fieldId", ...write, c.updateField);
  router.delete("/custom-fields/:fieldId", ...write, c.deleteField);

  router.get("/contacts/:contactId/sales", ...read, c.getContactSales);
  router.patch("/contacts/:contactId/ext", ...write, c.updateContactExt);
  router.get("/duplicates", ...read, c.getDuplicates);
  router.post("/duplicates/merge", ...write, c.merge);

  router.get("/plans", ...read, c.getPlans);
  router.post("/plans", ...write, c.createPlan);
  router.get("/plans/:planId", ...read, c.getPlan);
  router.patch("/plans/:planId", ...write, c.updatePlan);
  router.delete("/plans/:planId", ...write, c.deletePlan);
  router.post("/plans/:planId/send", ...write, c.sendPlan);
  router.post("/plans/:planId/status", ...write, c.setPlanStatus);
  router.post("/plans/:planId/invoice", ...write, c.planInvoice);

  // a discount or a credit limit asked for; it is decided in the panel's
  // «کارتابل» (Routers/kartablRoutes.ts)
  router.get("/approvals/draft-invoices", ...read, c.getDraftInvoices);
  router.post("/approvals", ...write, c.createApproval);

  router.get("/contracts", ...read, c.getContracts);
  router.post("/contracts", ...write, c.createContract);
  router.get("/contracts/:contractId", ...read, c.getContract);
  router.patch("/contracts/:contractId", ...write, c.updateContract);
  router.delete("/contracts/:contractId", ...write, c.deleteContract);
  router.post("/contracts/:contractId/state", ...write, c.setContractState);
  router.post("/contracts/:contractId/invoice", ...write, c.contractInvoice);
  router.post("/contracts/:contractId/send", ...write, c.sendContract);
  router.post("/contracts/:contractId/template", ...write, c.contractTemplate);
  router.post("/contracts/:contractId/members", ...write, c.addMembers);
  router.delete("/contracts/:contractId/members/:memberId", ...write, c.removeMember);
  router.get("/contract-blocks", ...read, c.getBlocks);
  router.post("/contract-blocks", ...write, c.saveBlock);
  router.patch("/contract-blocks/:blockId", ...write, c.saveBlock);
  router.delete("/contract-blocks/:blockId", ...write, c.deleteBlock);

  router.get("/care-plans", ...read, c.getCarePlans);
  router.post("/care-plans", ...write, c.createCarePlan);
  router.post("/care-plans/run-due", ...write, c.runDueCarePlans);
  router.patch("/care-plans/:carePlanId", ...write, c.updateCarePlan);
  router.post("/care-plans/:carePlanId/status", ...write, c.setCarePlanStatus);
  router.post("/care-plans/:carePlanId/run", ...write, c.runCarePlan);
  router.delete("/care-plans/:carePlanId", ...write, c.deleteCarePlan);

  router.get("/inquiries", ...read, c.getInquiries);
  router.post("/inquiries", ...write, c.createInquiry);
  router.patch("/inquiries/:inquiryId", ...write, c.updateInquiry);
  router.post("/inquiries/:inquiryId/convert", ...write, c.convertInquiry);
  router.delete("/inquiries/:inquiryId", ...write, c.deleteInquiry);

  router.get("/calls", ...read, c.getCalls);
  router.post("/calls", ...write, c.saveCall);
  router.patch("/calls/:callId", ...write, c.saveCall);
  router.delete("/calls/:callId", ...write, c.deleteCall);

  router.get("/goals", ...read, c.getGoals);
  router.post("/goals", ...write, c.saveGoal);
  router.patch("/goals/:goalId", ...write, c.saveGoal);
  router.delete("/goals/:goalId", ...write, c.deleteGoal);
  router.get("/commissions", ...read, c.getCommissions);
  router.post("/commissions", ...write, c.saveCommission);
  router.patch("/commissions/:ruleId", ...write, c.saveCommission);
  router.delete("/commissions/:ruleId", ...write, c.deleteCommission);

  router.get("/day-plan", ...read, c.getDayPlan);
  router.post("/day-plan/done", ...write, c.completeTask);
};
