import crypto from "crypto";
import mongoose from "mongoose";
import AppError from "../AppError";
import { sendSMS } from "../sendSms";
import { getAppConfig } from "../appConfig";
import BizContact, { IBizContact } from "../../Models/BizContact";
import BizActivity from "../../Models/BizActivity";
import BizMessage from "../../Models/BizMessage";
import BizInvoice, { IBizInvoice } from "../../Models/BizInvoice";
import BizPayment from "../../Models/BizPayment";
import BizItem from "../../Models/BizItem";
import BizPipeline, { IBizPipeline, IBizStage } from "../../Models/BizPipeline";
import BizLead, { bizLeadKinds, IBizLead, IBizLeadItem } from "../../Models/BizLead";
import BizLeadSource from "../../Models/BizLeadSource";
import BizCrmSettings, { IBizCrmSettings } from "../../Models/BizCrmSettings";
import BizAssignRule, { IBizAssignRule } from "../../Models/BizAssignRule";
import BizTeam from "../../Models/BizTeam";
import BizGoal, { IBizGoal } from "../../Models/BizGoal";
import BizCommissionRule, { IBizCommissionRule } from "../../Models/BizCommissionRule";
import BizPlan, { IBizPlan, IBizPlanItem } from "../../Models/BizPlan";
import BizContract, { IBizContract } from "../../Models/BizContract";
import BizCarePlan, { IBizCarePlan } from "../../Models/BizCarePlan";
import BizInquiry, { IBizInquiry } from "../../Models/BizInquiry";
import BizApproval, { IBizApproval } from "../../Models/BizApproval";
import BizContactExt, { IBizContactExt } from "../../Models/BizContactExt";
import BizCall from "../../Models/BizCall";
import Notification from "../../Models/Notification";
import Secretary, { nodesWithAclToSecreataryAclPathDict } from "../../Models/Secretary";
import User from "../../Models/User";
import UserIdentity from "../../Models/UserIdentity";
import Service from "../../Models/Service";
import ServicePackage from "../../Models/ServicePackage";
import ClinicDoctor from "../../Models/ClinicDoctor";
import { BizOwner } from "./coa";
import { newOptCode, normalizeMobile, own } from "./crm";
import { orgInfo } from "./campaign";
import { createInvoice, issueInvoice, updateInvoice } from "./invoices";
import { nextDocNumber } from "./voucher";
import {
  advancePeriod,
  commissionFor,
  DAY,
  dueInDaysFor,
  expectedPacePct,
  isReorderDue,
  leadTaskScore,
  matchAll,
  mergeFields,
  pickLeastLoaded,
  planTotals,
  priorityFromScore,
  purchaseCadence,
  ruleScore,
  stageMissing,
  type StageField,
} from "./crmSalesCore";

// The CRM sales side (2026-10, docs/nexxa-crm-parity.md in the frontend
// repo): Nexxa's pipeline, leads, assignment, scoring, treatment plans
// (proposals / proforma), contracts, care plans (subscriptions), estimate
// requests, approval chains, goals, commission, the day plan, duplicates
// and merge - each action with the effect Nexxa's BEHAVIOR-SPEC gives it.
// Money always lands in the finance suite's invoices (invoices.ts), never in
// a second ledger of our own.

export const oid = (v: unknown) => new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));
export const isId = (v: unknown): v is string => typeof v === "string" && mongoose.isValidObjectId(v) && /^[0-9a-f]{24}$/i.test(v);
export const newToken = () => crypto.randomBytes(9).toString("base64url");
const siteBase = async () => ((await getAppConfig()).siteBaseUrl || "").replace(/\/+$/, "");

// ---------------------------------------------------------------- defaults

type Group = "care" | "insurance" | "pharmacy";
const groupOf = (owner: BizOwner): Group => (owner.kind === "insurance" ? "insurance" : owner.kind === "pharmacy" ? "pharmacy" : "care");

// the built-in stages of the first pipeline (stored in SOURCE_LOCALE; the
// panel shows a built-in one by its key until it is renamed)
const DEFAULT_STAGES: Record<Group, { key: string; name: string; probability: number }[]> = {
  care: [
    { key: "inquiry", name: "استعلام", probability: 10 },
    { key: "consult", name: "مشاوره", probability: 30 },
    { key: "plan", name: "طرح درمان", probability: 50 },
    { key: "accepted", name: "پذیرش", probability: 80 },
    { key: "treatment", name: "در حال درمان", probability: 90 },
    { key: "done", name: "انجام شد", probability: 100 },
  ],
  insurance: [
    { key: "inquiry", name: "استعلام", probability: 10 },
    { key: "needs", name: "نیازسنجی", probability: 30 },
    { key: "quote", name: "پیشنهاد قیمت", probability: 50 },
    { key: "negotiation", name: "مذاکره", probability: 70 },
    { key: "contract", name: "قرارداد", probability: 90 },
  ],
  pharmacy: [
    { key: "inquiry", name: "استعلام", probability: 10 },
    { key: "quote", name: "پیش‌فاکتور", probability: 50 },
    { key: "accepted", name: "پذیرش", probability: 90 },
  ],
};
export const DEFAULT_PIPELINE_NAME: Record<Group, string> = { care: "قیف درمان", insurance: "قیف فروش سازمانی", pharmacy: "قیف فروش" };

const DEFAULT_SOURCES = [
  { system: "instagram", name: "اینستاگرام" },
  { system: "referral", name: "معرفی بیمار" },
  { system: "website", name: "وب‌سایت" },
  { system: "phone", name: "تلفن" },
  { system: "webform", name: "فرم سایت" },
  { system: "noyan", name: "نویان" },
  { system: "walkIn", name: "مراجعه‌ی حضوری" },
  { system: "other", name: "سایر" },
];
const DEFAULT_LOSS = [
  { system: "price", name: "هزینه‌ی بالا" },
  { system: "fear", name: "نگرانی از درمان" },
  { system: "competitor", name: "مرکز دیگر" },
  { system: "noAnswer", name: "پاسخ نداد" },
  { system: "timing", name: "زمان مناسب نبود" },
  { system: "notCandidate", name: "شرایط پزشکی مناسب نبود" },
];

// the owner's pipelines; the first (default) one with the built-in stages
// is made on first use, and exactly one is the default (Nexxa
// ensureDefaultPipeline)
export const ensurePipelines = async (owner: BizOwner) => {
  let list = await BizPipeline.find(own(owner)).sort({ isDefault: -1, sequence: 1, createdAt: 1 }).lean<IBizPipeline[]>();
  if (!list.length) {
    const g = groupOf(owner);
    await BizPipeline.create({
      ...own(owner),
      name: DEFAULT_PIPELINE_NAME[g],
      isDefault: true,
      stages: DEFAULT_STAGES[g].map((s, i) => ({ ...s, sequence: i })),
    }).catch(() => null);
    list = await BizPipeline.find(own(owner)).sort({ isDefault: -1, sequence: 1, createdAt: 1 }).lean<IBizPipeline[]>();
  }
  if (list.length && !list.some((p) => p.isDefault)) {
    await BizPipeline.updateOne({ _id: list[0]._id }, { $set: { isDefault: true } });
    list[0].isDefault = true;
  }
  for (const p of list) p.stages = [...(p.stages || [])].sort((a, b) => a.sequence - b.sequence);
  return list;
};

export const ensureSources = async (owner: BizOwner) => {
  if (await BizLeadSource.exists(own(owner))) return;
  await BizLeadSource.insertMany(
    [
      ...DEFAULT_SOURCES.map((s, i) => ({ ...own(owner), kind: "source", ...s, sequence: i })),
      ...DEFAULT_LOSS.map((s, i) => ({ ...own(owner), kind: "lossReason", ...s, sequence: i })),
    ],
    { ordered: false },
  ).catch(() => null);
};

export const settingsOf = async (owner: BizOwner) =>
  (await BizCrmSettings.findOneAndUpdate({ ...own(owner) }, { $setOnInsert: own(owner) }, { upsert: true, new: true }).lean<IBizCrmSettings>())!;

// ---------------------------------------------------------------- staff

// the panel owner and its secretaries: the people a lead, a rule, a goal
// or a commission can name
export const staffOf = async (owner: BizOwner) => {
  const info = await orgInfo(owner);
  const path = nodesWithAclToSecreataryAclPathDict[owner.kind as keyof typeof nodesWithAclToSecreataryAclPathDict];
  const secs = path
    ? await Secretary.find({ owner: owner.id, ownerPath: path }).select("secretary displayName").lean<{ secretary: unknown; displayName?: string }[]>()
    : [];
  const ids = [info.user, ...secs.map((s) => s.secretary)].filter(Boolean).map(String);
  const [users, idns] = await Promise.all([
    User.find({ _id: { $in: ids } }).select("phone").lean<{ _id: unknown; phone?: string }[]>(),
    UserIdentity.find({ user: { $in: ids } }).select("user givenName lastName").lean<{ user?: unknown; givenName?: string; lastName?: string }[]>(),
  ]);
  const nameOf = (id: string) => {
    const i = idns.find((x) => String(x.user) === id);
    return (i ? `${i.givenName || ""} ${i.lastName || ""}`.trim() : "") || users.find((u) => String(u._id) === id)?.phone || "";
  };
  const out = [
    ...(info.user ? [{ _id: String(info.user), name: info.name || nameOf(String(info.user)), role: "owner" as const }] : []),
    ...secs.map((s) => ({ _id: String(s.secretary), name: s.displayName || nameOf(String(s.secretary)), role: "secretary" as const })),
  ];
  return out.filter((m, i) => out.findIndex((x) => x._id === m._id) === i);
};

// only people of this panel: anything else is dropped (Nexxa: an owner of
// another company is reset)
export const staffIds = async (owner: BizOwner) => new Set((await staffOf(owner)).map((s) => s._id));
export const keepStaff = async (owner: BizOwner, ids: (string | null | undefined)[]) => {
  const allowed = await staffIds(owner);
  return ids.filter((x): x is string => !!x && allowed.has(String(x))).map(oid);
};

// the panel owner's own account (always an approver, sees everything)
export const ownerUser = async (owner: BizOwner) => String((await orgInfo(owner)).user || "");

const notify = async (user: unknown, title: string, message: string, link?: string) => {
  if (!user) return;
  await Notification.create({ user, source: "System", title, message, ...(link ? { link } : {}) }).catch(() => {});
};

const panelPath: Record<string, string> = {
  doctor: "/doctorpanel",
  clinic: "/clinicpanel",
  hospital: "/hospitalpanel",
  pharmacy: "/pharmacypanel",
  paraClinic: "/paraClinicPanel",
  insurance: "/insurancepanel",
};
const linkOf = (owner: BizOwner, path: string) => `${panelPath[owner.kind] || ""}/crm/${path}`;

// ---------------------------------------------------------------- contacts

// the patient of a phone, made when new (an inquiry is consent to be
// called back; the visit figures stay those of Noyan's sync)
export const findOrCreateContact = async (owner: BizOwner, input: { name?: string; phone?: string | null }) => {
  const phone = normalizeMobile(input.phone);
  if (!phone) return null;
  const found = await BizContact.findOne({ ...own(owner), phone }).lean<IBizContact>();
  if (found) {
    if (!found.name && input.name) await BizContact.updateOne({ _id: found._id }, { $set: { name: input.name.trim().slice(0, 200) } });
    return found;
  }
  try {
    return (
      await BizContact.create({
        ...own(owner),
        name: (input.name || "").trim().slice(0, 200),
        phone,
        source: "manual",
        consentAt: new Date(),
        optCode: newOptCode(),
      })
    ).toObject() as IBizContact;
  } catch {
    // made at the same moment by another request
    return BizContact.findOne({ ...own(owner), phone }).lean<IBizContact>();
  }
};

export const contactOf = async (owner: BizOwner, id: unknown) =>
  isId(String(id || "")) ? BizContact.findOne({ ...own(owner), _id: String(id) }).lean<IBizContact>() : null;

export const extOf = async (owner: BizOwner, contactId: unknown) =>
  (await BizContactExt.findOneAndUpdate(
    { contact: oid(contactId) },
    { $setOnInsert: { ...own(owner), contact: oid(contactId) } },
    { upsert: true, new: true },
  ).lean<IBizContactExt>())!;

// what the patient still owes on this owner's issued invoices (their own
// share, by phone or national id) - the base of the credit limit (Nexxa
// credit-limit.ts, read-only)
export const contactBalance = async (owner: BizOwner, contact: Pick<IBizContact, "phone">, nationalId?: string) => {
  const phones = [contact.phone, `98${contact.phone.slice(1)}`, contact.phone.slice(1)];
  const rows = await BizInvoice.find({
    ...own(owner),
    status: { $in: ["issued", "partial"] },
    $or: [{ "party.phone": { $in: phones } }, ...(nationalId ? [{ "party.nationalId": nationalId }] : [])],
  })
    .select("patientShare paid")
    .lean<{ patientShare: number; paid: number }[]>();
  return rows.reduce((s, r) => s + Math.max(0, (r.patientShare || 0) - (r.paid || 0)), 0);
};

export const creditOf = async (owner: BizOwner, contactId: unknown) => {
  const c = await contactOf(owner, contactId);
  if (!c) return null;
  const ext = await extOf(owner, c._id);
  const balance = await contactBalance(owner, c, ext.nationalId);
  const enforced = ext.creditLimit > 0 && !ext.freeCredit;
  return { enforced, limit: ext.creditLimit, freeCredit: ext.freeCredit, balance, remaining: ext.creditLimit - balance };
};

// a new charge must stay within the limit (only when one is set)
export const assertCredit = async (owner: BizOwner, contactId: unknown, add: number) => {
  const c = await creditOf(owner, contactId);
  if (!c?.enforced) return;
  if (c.balance + add > c.limit + 1)
    throw new AppError(`این مبلغ از سقف اعتبار بیمار بیشتر است (مانده ${c.balance.toLocaleString("fa-IR")}، سقف ${c.limit.toLocaleString("fa-IR")})`, 400);
};

// ---------------------------------------------------------------- leads

// a lead with its patient's figures, as the rules see it
export const leadRecord = (lead: Partial<IBizLead>, contact?: Partial<IBizContact> | null): Record<string, unknown> => ({
  title: lead.title,
  kind: lead.kind,
  status: lead.status,
  sourceName: lead.sourceName,
  priority: lead.priority,
  value: lead.value,
  probability: lead.probability,
  contactVisits: contact?.visits,
  contactSpent: contact?.spent,
  contactInsurer: contact?.insurer,
  contactCity: contact?.city,
  contactGender: contact?.gender,
  contactAge: contact?.birthYear ? new Date().getFullYear() - contact.birthYear : undefined,
});

const openLoad = async (owner: BizOwner, ids: string[]) => {
  const rows = await BizLead.aggregate<{ _id: unknown; n: number }>([
    { $match: { ...own(owner), status: "open", assignee: { $in: ids.map(oid) } } },
    { $group: { _id: "$assignee", n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
};

// who takes a new lead: the first matching rule (one person, or the
// least-loaded member of a team), else the round-robin pool, else the
// person who made it (Nexxa resolveOwnerByRules -> pickAssignee -> user)
export const resolveAssignee = async (owner: BizOwner, record: Record<string, unknown>, fallback?: unknown) => {
  const allowed = await staffIds(owner);
  const rules = await BizAssignRule.find({ ...own(owner), kind: "assign", active: true }).sort({ order: 1 }).lean<IBizAssignRule[]>();
  for (const r of rules) {
    if (!matchAll(record, r.conditions)) continue;
    let pick: string | null = null;
    if (r.assignType === "user") pick = r.user && allowed.has(String(r.user)) ? String(r.user) : null;
    else if (r.team) {
      const team = await BizTeam.findOne({ ...own(owner), _id: r.team }).lean<{ members: unknown[] }>();
      const pool = (team?.members || []).map(String).filter((id) => allowed.has(id));
      pick = pickLeastLoaded(pool, await openLoad(owner, pool));
    }
    if (pick) return oid(pick);
    if (r.stopOnMatch) break;
  }
  const cfg = await settingsOf(owner);
  if (cfg.autoAssign?.enabled) {
    const pool = (cfg.autoAssign.users || []).map(String).filter((id) => allowed.has(id));
    const pick = pickLeastLoaded(pool, await openLoad(owner, pool));
    if (pick) return oid(pick);
  }
  return fallback && allowed.has(String(fallback)) ? oid(fallback) : undefined;
};

// the rule score of one lead, written on it (0 with no rules)
export const scoreLead = async (owner: BizOwner, leadId: unknown) => {
  const lead = await BizLead.findOne({ ...own(owner), _id: oid(leadId) }).lean<IBizLead>();
  if (!lead) return null;
  const [contact, rules] = await Promise.all([
    lead.contact ? BizContact.findById(lead.contact).lean<IBizContact>() : null,
    BizAssignRule.find({ ...own(owner), kind: "score", active: true }).lean<IBizAssignRule[]>(),
  ]);
  const score = ruleScore(
    leadRecord(lead, contact),
    rules.map((r) => ({ ...(r.conditions[0] || { field: "", op: "", value: "" }), points: r.points })),
  );
  await BizLead.updateOne({ _id: lead._id }, { $set: { ruleScore: score } });
  return score;
};

export const recomputeScores = async (owner: BizOwner) => {
  const leads = await BizLead.find({ ...own(owner), status: "open" }).select("_id").limit(5000).lean();
  for (const l of leads) await scoreLead(owner, l._id);
  return leads.length;
};

export const stageOf = (pipe: IBizPipeline | null | undefined, stageId: unknown) => pipe?.stages.find((s) => String(s._id) === String(stageId)) || null;

// the logged work on a lead: its calls and its patient's notes, calls and
// follow-ups since it was opened
export const leadActivityCount = async (owner: BizOwner, lead: Pick<IBizLead, "_id" | "contact" | "createdAt">) => {
  const [calls, acts] = await Promise.all([
    BizCall.countDocuments({ ...own(owner), lead: lead._id }),
    lead.contact ? BizActivity.countDocuments({ ...own(owner), contact: lead.contact, createdAt: { $gte: lead.createdAt } }) : 0,
  ]);
  return calls + acts;
};

const blueprintView = (lead: Partial<IBizLead>): Partial<Record<StageField, unknown>> => ({
  title: lead.title,
  value: lead.value,
  expectedClose: lead.expectedClose,
  contact: lead.contact,
  probability: lead.probability,
  assignee: lead.assignee,
  items: lead.items,
});

// a stage's blueprint must hold before a lead enters it (Nexxa
// checkStageRequirements); the missing fields are named
export const assertStage = async (owner: BizOwner, lead: IBizLead, stage: IBizStage) => {
  const needs = stage.requireActivity ? await leadActivityCount(owner, lead) : 1;
  const missing = stageMissing(blueprintView(lead), stage, needs);
  if (missing.length) throw new AppError(`برای ورود به این مرحله این‌ها لازم است: ${missing.map((m) => FIELD_LABEL[m] || m).join("، ")}`, 400);
};
export const FIELD_LABEL: Record<string, string> = {
  title: "عنوان",
  value: "ارزش",
  expectedClose: "تاریخ پیش‌بینی",
  contact: "بیمار",
  probability: "احتمال",
  assignee: "مسئول",
  items: "اقلام درمان",
  activity: "یک فعالیت ثبت‌شده",
};

export const itemsValue = (items: Pick<IBizLeadItem, "qty" | "unitPrice" | "discount">[]) => planTotals(items).total;

export const pushHistory = (kind: IBizLead["history"][number]["kind"], text: string, by?: unknown) => ({
  $push: { history: { $each: [{ at: new Date(), by: by ? oid(by) : undefined, kind, text: text.slice(0, 300) }], $slice: -100 } },
});

// ---------------------------------------------------------------- plans

export const planDocNumber = (owner: BizOwner) => nextDocNumber("crmPlan", owner);

// the totals cached on the plan from its lines
export const pricePlan = (items: Pick<IBizPlanItem, "qty" | "unitPrice" | "discount" | "taxRate">[], discountPercent: number) => {
  const t = planTotals(items, discountPercent);
  return { subtotal: t.subtotal, discount: t.discount, tax: t.tax, total: t.total };
};

export const planLink = async (p: Pick<IBizPlan, "token">) => `${await siteBase()}/tp/${p.token}`;
export const contractLink = async (c: Pick<IBizContract, "token">) => `${await siteBase()}/ct/${c.token}`;

// the link to the patient by SMS (pattern CRM_DOC_LINK_PATTERN: center,
// title, link); without a pattern nothing is sent and the link is shown
const smsLink = async (owner: BizOwner, phone: string | undefined, title: string, link: string) => {
  const p = normalizeMobile(phone);
  if (!p) return false;
  const { name } = await orgInfo(owner).catch(() => ({ name: "" }));
  return sendSMS(`98${p.slice(1)}`, { center: name, title: title.slice(0, 60), link }, "CRM_DOC_LINK_PATTERN");
};

// send = the patient can accept it; a plan above the threshold waits for
// the approval chain first (Nexxa proforma approval)
export const sendPlan = async (owner: BizOwner, id: string, by?: unknown) => {
  const plan = await BizPlan.findOne({ ...own(owner), _id: id });
  if (!plan) throw new AppError("طرح درمان پیدا نشد", 404);
  if (plan.invoice || plan.status === "accepted") throw new AppError("این طرح پذیرفته شده است", 400);
  if (!plan.items.length) throw new AppError("دست‌کم یک ردیف به طرح اضافه کنید", 400);
  const cfg = await settingsOf(owner);
  const chain = cfg.approvals?.plan;
  if (chain?.enabled && plan.total >= (chain.minAmount || 0) && plan.approval?.status !== "approved") {
    if (plan.approval?.status === "pending") throw new AppError("این طرح منتظر تأیید مدیر است", 400);
    const req = await startApproval(owner, { kind: "plan", plan: plan._id, contact: plan.contact, amount: plan.total, description: plan.subject }, by);
    plan.approval = { status: "pending", request: req._id };
    await plan.save();
    return { pending: true, link: "" };
  }
  plan.status = "sent";
  plan.sentAt = new Date();
  await plan.save();
  const link = await planLink(plan);
  const c = plan.contact ? await BizContact.findById(plan.contact).select("phone").lean<{ phone: string }>() : null;
  const sent = await smsLink(owner, c?.phone, plan.subject, link).catch(() => false);
  return { pending: false, link, sms: sent };
};

// the plan made into a draft finance invoice, once: a second call returns
// the same invoice (Nexxa convertProposalToInvoice)
export const planToInvoice = async (owner: BizOwner, id: string, by?: unknown, issue = false) => {
  const plan = await BizPlan.findOne({ ...own(owner), _id: id });
  if (!plan) throw new AppError("طرح درمان پیدا نشد", 404);
  if (plan.invoice) return { invoice: String(plan.invoice), existed: true };
  if (!plan.items.length) throw new AppError("دست‌کم یک ردیف به طرح اضافه کنید", 400);
  if (plan.status === "declined") throw new AppError("بیمار این طرح را رد کرده است", 400);
  if (plan.approval?.status === "pending") throw new AppError("این طرح منتظر تأیید مدیر است", 400);
  const contact = plan.contact ? await BizContact.findOne({ ...own(owner), _id: plan.contact }).lean<IBizContact>() : null;
  if (!contact) throw new AppError("برای صدور صورتحساب، بیمار طرح را مشخص کنید", 400);
  await assertCredit(owner, contact._id, plan.total);
  const ext = await extOf(owner, contact._id);
  const t = planTotals(plan.items, plan.discountPercent);
  const inv = await createInvoice(
    owner,
    {
      date: new Date(),
      party: { name: contact.name || contact.phone, phone: contact.phone, nationalId: ext.nationalId },
      lines: plan.items.map((l, i) => ({
        title: l.sessions ? `${l.title} (${l.sessions.toLocaleString("fa-IR")} جلسه)` : l.title,
        qty: l.qty,
        unitPrice: l.unitPrice,
        // the invoice keeps a discount amount per line: the line's and the
        // plan's share together
        discount: t.rows[i].gross - t.rows[i].net,
        taxRate: l.taxRate,
      })),
      note: `طرح درمان شماره‌ی ${plan.number.toLocaleString("fa-IR")}: ${plan.subject}`.slice(0, 1000),
    },
    false,
    by,
  );
  const invId = String((inv as { _id: unknown })._id);
  // claim the plan: a double click made a second invoice, which is dropped
  const claimed = await BizPlan.updateOne({ _id: plan._id, invoice: { $exists: false } }, { $set: { invoice: oid(invId), status: "accepted", decidedAt: plan.decidedAt || new Date() } });
  if (!claimed.modifiedCount) {
    await BizInvoice.deleteOne({ _id: invId, status: "draft" });
    const again = await BizPlan.findById(plan._id).select("invoice").lean<{ invoice?: unknown }>();
    return { invoice: String(again?.invoice || ""), existed: true };
  }
  await BizInvoice.updateOne({ _id: invId }, { $set: { source: { type: "crmPlan", id: plan._id } } });
  if (issue) await issueInvoice(owner, invId, by);
  if (plan.lead) {
    const lead = await BizLead.findOne({ ...own(owner), _id: plan.lead, status: "open" });
    if (lead) {
      lead.status = "won";
      lead.probability = 100;
      lead.closedAt = new Date();
      await lead.save();
      await BizLead.updateOne({ _id: lead._id }, pushHistory("status", "won", by));
    }
  }
  return { invoice: invId, existed: false };
};

// ---------------------------------------------------------------- approvals

const KIND_TITLE: Record<IBizApproval["kind"], string> = { plan: "تأیید طرح درمان", discount: "درخواست تخفیف", credit: "درخواست سقف اعتبار" };

// a request walking its chain: the configured approvers of this panel, in
// order; with none, the panel owner alone
export const startApproval = async (
  owner: BizOwner,
  input: { kind: IBizApproval["kind"]; plan?: unknown; invoice?: unknown; contact?: unknown; amount?: number; percent?: number; requestedLimit?: number; description?: string },
  by?: unknown,
) => {
  const cfg = await settingsOf(owner);
  const wanted = (cfg.approvals?.[input.kind]?.approvers || []).map(String);
  let chain = await keepStaff(owner, wanted);
  if (!chain.length) {
    const top = await ownerUser(owner);
    if (top) chain = [oid(top)];
  }
  if (!chain.length) throw new AppError("تأییدکننده‌ای برای این درخواست تعریف نشده است", 400);
  const number = await nextDocNumber(`crmApproval:${input.kind}`, owner);
  const row = await BizApproval.create({
    ...own(owner),
    kind: input.kind,
    number,
    requester: by ? oid(by) : undefined,
    ...(input.plan ? { plan: oid(input.plan) } : {}),
    ...(input.invoice ? { invoice: oid(input.invoice) } : {}),
    ...(input.contact ? { contact: oid(input.contact) } : {}),
    amount: Math.max(0, Math.round(Number(input.amount) || 0)),
    percent: Math.min(100, Math.max(0, Number(input.percent) || 0)),
    requestedLimit: Math.max(0, Math.round(Number(input.requestedLimit) || 0)),
    description: input.description?.slice(0, 1000),
    chain,
    level: 0,
    status: "pending",
  });
  await notify(chain[0], "درخواست تأیید", `${KIND_TITLE[row.kind]} شماره‌ی ${row.number.toLocaleString("fa-IR")} منتظر تأیید شماست.`, linkOf(owner, "approvals"));
  return row;
};

// the final approval's effect: the plan may be sent; the discount is put
// on the plan or the draft invoice; the credit limit is set
const applyApproval = async (owner: BizOwner, row: IBizApproval) => {
  if (row.kind === "plan" && row.plan) {
    await BizPlan.updateOne({ ...own(owner), _id: row.plan }, { $set: { "approval.status": "approved" } });
  } else if (row.kind === "discount") {
    if (row.plan) {
      const plan = await BizPlan.findOne({ ...own(owner), _id: row.plan });
      if (!plan || plan.invoice || plan.status === "accepted") throw new AppError("طرح دیگر قابل تخفیف نیست", 400);
      const before = pricePlan(plan.items, 0).total;
      const pct = row.percent > 0 ? row.percent : before > 0 ? Math.min(100, (row.amount / before) * 100) : 0;
      plan.discountPercent = Math.round(pct * 100) / 100;
      Object.assign(plan, pricePlan(plan.items, plan.discountPercent));
      if (plan.status === "sent") plan.status = "revised";
      await plan.save();
    } else if (row.invoice) {
      const inv = await BizInvoice.findOne({ ...own(owner), _id: row.invoice }).lean<IBizInvoice>();
      if (!inv || inv.status !== "draft") throw new AppError("تخفیف فقط روی صورتحساب پیش‌نویس اعمال می‌شود", 400);
      const gross = inv.lines.reduce((s, l) => s + Math.round(l.qty * l.unitPrice) - l.discount, 0);
      const want = row.percent > 0 ? Math.round((gross * row.percent) / 100) : Math.min(gross, row.amount);
      let left = want;
      const lines = inv.lines.map((l, i) => {
        const net = Math.round(l.qty * l.unitPrice) - l.discount;
        const share = i === inv.lines.length - 1 ? left : Math.min(left, Math.round((want * net) / Math.max(1, gross)));
        left -= share;
        return { title: l.title, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount + share, taxRate: l.taxRate, account: l.account ? String(l.account) : undefined };
      });
      await updateInvoice(owner, String(inv._id), {
        date: inv.date,
        dueDate: inv.dueDate,
        party: inv.party,
        doctorName: inv.doctorName,
        lines,
        insurer: inv.insurer ? { kind: inv.insurer.kind, name: inv.insurer.name, share: inv.insurer.share } : null,
        note: inv.note,
        center: inv.center ? String(inv.center) : undefined,
      });
    }
  } else if (row.kind === "credit" && row.contact) {
    await BizContactExt.updateOne(
      { contact: row.contact },
      { $set: { creditLimit: row.requestedLimit, freeCredit: false }, $setOnInsert: { ...own(owner), contact: row.contact } },
      { upsert: true },
    );
  }
};

export const decideApproval = async (owner: BizOwner, id: string, user: unknown, decision: "approved" | "rejected", note?: string) => {
  const row = await BizApproval.findOne({ ...own(owner), _id: id });
  if (!row) throw new AppError("درخواست پیدا نشد", 404);
  if (row.status !== "pending") throw new AppError("این درخواست قبلاً تصمیم گرفته شده است", 400);
  const top = await ownerUser(owner);
  const current = String(row.chain[row.level] || "");
  if (String(user) !== current && String(user) !== top) throw new AppError("تصمیم این مرحله با شما نیست", 403);
  row.decisions.push({ by: oid(user), decision, note: note?.slice(0, 500), at: new Date() });
  if (decision === "rejected") {
    row.status = "rejected";
    await row.save();
    // a rejected plan is unlocked to be edited and sent again
    if (row.kind === "plan" && row.plan) await BizPlan.updateOne({ ...own(owner), _id: row.plan }, { $set: { "approval.status": "rejected" } });
    await notify(row.requester, "نتیجه‌ی درخواست", `${KIND_TITLE[row.kind]} شماره‌ی ${row.number.toLocaleString("fa-IR")} رد شد.`, linkOf(owner, "approvals"));
    return row.toObject();
  }
  if (row.level + 1 < row.chain.length && String(user) !== top) {
    row.level += 1;
    await row.save();
    await notify(row.chain[row.level], "درخواست تأیید", `${KIND_TITLE[row.kind]} شماره‌ی ${row.number.toLocaleString("fa-IR")} منتظر تأیید شماست.`, linkOf(owner, "approvals"));
    return row.toObject();
  }
  row.status = "approved";
  await row.save();
  try {
    await applyApproval(owner, row.toObject() as IBizApproval);
    row.status = "applied";
    row.appliedAt = new Date();
    await row.save();
  } catch (err) {
    // approved stays, the effect is shown and can be retried
    await notify(row.requester, "نتیجه‌ی درخواست", `${KIND_TITLE[row.kind]} شماره‌ی ${row.number.toLocaleString("fa-IR")} تأیید شد ولی اعمال نشد.`, linkOf(owner, "approvals"));
    throw err;
  }
  await notify(row.requester, "نتیجه‌ی درخواست", `${KIND_TITLE[row.kind]} شماره‌ی ${row.number.toLocaleString("fa-IR")} تأیید شد.`, linkOf(owner, "approvals"));
  return row.toObject();
};

// an approved request whose effect failed (the plan moved on, say): try again
export const reapplyApproval = async (owner: BizOwner, id: string) => {
  const row = await BizApproval.findOne({ ...own(owner), _id: id, status: "approved" });
  if (!row) throw new AppError("درخواست تأییدشده‌ی اعمال‌نشده پیدا نشد", 404);
  await applyApproval(owner, row.toObject() as IBizApproval);
  row.status = "applied";
  row.appliedAt = new Date();
  await row.save();
  return row.toObject();
};

export const cancelApproval = async (owner: BizOwner, id: string, user: unknown) => {
  const row = await BizApproval.findOne({ ...own(owner), _id: id, status: "pending" });
  if (!row) throw new AppError("درخواست در انتظار پیدا نشد", 404);
  const top = await ownerUser(owner);
  if (String(row.requester || "") !== String(user) && String(user) !== top) throw new AppError("فقط درخواست‌دهنده درخواست را لغو می‌کند", 403);
  row.status = "cancelled";
  await row.save();
  if (row.kind === "plan" && row.plan) await BizPlan.updateOne({ ...own(owner), _id: row.plan, "approval.status": "pending" }, { $set: { "approval.status": "none" } });
  return row.toObject();
};

// ---------------------------------------------------------------- contracts

export const contractToInvoice = async (owner: BizOwner, id: string, by?: unknown) => {
  const c = await BizContract.findOne({ ...own(owner), _id: id });
  if (!c) throw new AppError("قرارداد پیدا نشد", 404);
  if (c.invoice) return { invoice: String(c.invoice), existed: true };
  if (c.value <= 0) throw new AppError("مبلغ قرارداد صفر است", 400);
  if (c.state === "canceled") throw new AppError("قرارداد لغو شده است", 400);
  const contact = c.contact ? await BizContact.findOne({ ...own(owner), _id: c.contact }).lean<IBizContact>() : null;
  if (contact) await assertCredit(owner, contact._id, c.value);
  const inv = await createInvoice(
    owner,
    {
      date: new Date(),
      party: { name: c.party?.name || contact?.name || "", phone: c.party?.phone || contact?.phone, nationalId: c.party?.nationalId },
      lines: [{ title: `قرارداد شماره‌ی ${c.number.toLocaleString("fa-IR")}: ${c.subject}`.slice(0, 300), qty: 1, unitPrice: c.value }],
    },
    false,
    by,
  );
  const invId = String((inv as { _id: unknown })._id);
  const claimed = await BizContract.updateOne({ _id: c._id, invoice: { $exists: false } }, { $set: { invoice: oid(invId) } });
  if (!claimed.modifiedCount) {
    await BizInvoice.deleteOne({ _id: invId, status: "draft" });
    const again = await BizContract.findById(c._id).select("invoice").lean<{ invoice?: unknown }>();
    return { invoice: String(again?.invoice || ""), existed: true };
  }
  await BizInvoice.updateOne({ _id: invId }, { $set: { source: { type: "crmContract", id: c._id } } });
  return { invoice: invId, existed: false };
};

export const sendContract = async (owner: BizOwner, id: string) => {
  const c = await BizContract.findOne({ ...own(owner), _id: id }).lean<IBizContract>();
  if (!c) throw new AppError("قرارداد پیدا نشد", 404);
  const link = await contractLink(c);
  const contact = c.contact ? await BizContact.findById(c.contact).select("phone").lean<{ phone: string }>() : null;
  const sms = await smsLink(owner, c.party?.phone || contact?.phone, c.subject, link).catch(() => false);
  return { link, sms };
};

// ---------------------------------------------------------------- care plans

// one period of one care plan: claim it (nextRunDate moves on in the same
// update), then bill it; a failure gives the period back
const billPeriod = async (cp: IBizCarePlan, by?: unknown, outOfTurn = false) => {
  const owner = { kind: cp.ownerKind, id: String(cp.ownerId) } as BizOwner;
  const now = new Date();
  const due = cp.nextRunDate <= now;
  const next = advancePeriod(cp.nextRunDate, cp.interval, cp.intervalCount);
  if (!outOfTurn || due) {
    // the end date ends it once the next period would start after it
    const ends = cp.endDate && next > cp.endDate;
    const claimed = await BizCarePlan.updateOne(
      { _id: cp._id, status: "active", nextRunDate: cp.nextRunDate },
      { $set: { nextRunDate: next, ...(ends ? { status: "canceled" } : {}) } },
    );
    if (!claimed.modifiedCount) return null;
  }
  try {
    const contact = await BizContact.findOne({ ...own(owner), _id: cp.contact }).lean<IBizContact>();
    if (!contact) throw new AppError("بیمار این برنامه پیدا نشد", 400);
    const amount = Math.round(cp.amount * (1 + (cp.taxRate || 0) / 100));
    await assertCredit(owner, contact._id, amount);
    const ext = await extOf(owner, contact._id);
    const inv = await createInvoice(
      owner,
      {
        date: now,
        party: { name: contact.name || contact.phone, phone: contact.phone, nationalId: ext.nationalId },
        lines: [{ title: cp.name, qty: 1, unitPrice: cp.amount, taxRate: cp.taxRate || 0 }],
        note: `برنامه‌ی مراقبت: ${cp.name}`.slice(0, 1000),
      },
      false,
      by || cp.createdBy,
    );
    const invId = String((inv as { _id: unknown })._id);
    await BizInvoice.updateOne({ _id: invId }, { $set: { source: { type: "crmCarePlan", id: cp._id } } });
    if (cp.autoIssue) await issueInvoice(owner, invId, by || cp.createdBy).catch(() => null);
    await BizCarePlan.updateOne({ _id: cp._id }, { $set: { lastRunAt: now }, $unset: { lastError: 1 }, $inc: { generatedCount: 1 }, $push: { invoices: oid(invId) } });
    return invId;
  } catch (err) {
    if (!outOfTurn || due)
      await BizCarePlan.updateOne({ _id: cp._id, nextRunDate: next }, { $set: { nextRunDate: cp.nextRunDate, status: "active", lastError: String((err as Error)?.message || err).slice(0, 300) } });
    throw err;
  }
};

// "bill now": out of turn on purpose; the next due date only moves when
// it has been reached (no period is skipped - Nexxa runSubscriptionNow)
export const runCarePlanNow = async (owner: BizOwner, id: string, by?: unknown) => {
  const cp = await BizCarePlan.findOne({ ...own(owner), _id: id }).lean<IBizCarePlan>();
  if (!cp) throw new AppError("برنامه‌ی مراقبت پیدا نشد", 404);
  if (cp.status !== "active") throw new AppError("فقط برنامه‌ی فعال صادر می‌شود", 400);
  const inv = await billPeriod(cp, by, true);
  if (!inv) throw new AppError("این دوره همین حالا صادر شد", 400);
  return inv;
};

// every due period of one owner (or of all, from the job); each claimed
export const runDueCarePlans = async (owner?: BizOwner) => {
  let count = 0;
  const filter = { ...(owner ? own(owner) : {}), status: "active", nextRunDate: { $lte: new Date() } };
  for (let round = 0; round < 24; round++) {
    const due = await BizCarePlan.find(filter).limit(200).lean<IBizCarePlan[]>();
    if (!due.length) break;
    let any = false;
    for (const cp of due) {
      const r = await billPeriod(cp).catch(() => null);
      if (r) {
        count++;
        any = true;
      }
    }
    if (!any) break;
  }
  return count;
};

// ---------------------------------------------------------------- inquiries

export const inquiryToLead = async (owner: BizOwner, id: string, by?: unknown) => {
  const q = await BizInquiry.findOne({ ...own(owner), _id: id }).lean<IBizInquiry>();
  if (!q) throw new AppError("درخواست پیدا نشد", 404);
  if (q.lead) return { lead: String(q.lead), existed: true };
  const contact = await findOrCreateContact(owner, { name: q.name, phone: q.phone });
  const lead = await createLead(
    owner,
    {
      title: q.subject,
      kind: q.kind,
      contact: contact ? String(contact._id) : undefined,
      note: [q.description, q.company, q.email].filter(Boolean).join("\n").slice(0, 2000),
      items: q.budget > 0 ? [{ title: q.subject, qty: 1, unitPrice: q.budget, discount: 0 }] : [],
      sourceSystem: q.source === "web" ? "webform" : undefined,
      inquiry: String(q._id),
    },
    by,
  );
  const claimed = await BizInquiry.updateOne({ _id: q._id, lead: { $exists: false } }, { $set: { lead: lead._id, status: "converted" } });
  if (!claimed.modifiedCount) {
    await BizLead.deleteOne({ _id: lead._id });
    const again = await BizInquiry.findById(q._id).select("lead").lean<{ lead?: unknown }>();
    return { lead: String(again?.lead || ""), existed: true };
  }
  return { lead: String(lead._id), existed: false };
};

// ---------------------------------------------------------------- lead create

export type LeadInput = {
  title: string;
  kind?: string;
  contact?: string;
  name?: string;
  phone?: string;
  pipeline?: string;
  stage?: string;
  value?: number;
  probability?: number;
  priority?: number;
  expectedClose?: Date;
  source?: string;
  sourceSystem?: string;
  assignee?: string;
  note?: string;
  items?: { title: string; ref?: { kind: string; id: string }; qty?: number; unitPrice?: number; discount?: number; sessions?: number | null }[];
  customFields?: Record<string, string>;
  inquiry?: string;
};

export const createLead = async (owner: BizOwner, input: LeadInput, by?: unknown) => {
  const title = String(input.title || "").trim();
  if (!title) throw new AppError("عنوان درخواست را بنویسید", 400);
  const pipes = await ensurePipelines(owner);
  const pipe = pipes.find((p) => String(p._id) === input.pipeline) || pipes.find((p) => p.isDefault) || pipes[0];
  if (!pipe?.stages.length) throw new AppError("قیف درمان مرحله‌ای ندارد", 400);
  const stage = stageOf(pipe, input.stage) || pipe.stages[0];
  let contact: IBizContact | null = null;
  if (input.contact) contact = await contactOf(owner, input.contact);
  if (!contact && input.phone) contact = await findOrCreateContact(owner, { name: input.name, phone: input.phone });
  if (input.phone && !contact) throw new AppError("شماره‌ی موبایل معتبر نیست", 400);
  await ensureSources(owner);
  const source = input.source && isId(input.source)
    ? await BizLeadSource.findOne({ ...own(owner), kind: "source", _id: input.source }).lean<{ _id: unknown; name: string }>()
    : input.sourceSystem
      ? await BizLeadSource.findOne({ ...own(owner), kind: "source", system: input.sourceSystem }).lean<{ _id: unknown; name: string }>()
      : null;
  const items = (input.items || [])
    .filter((l) => String(l.title || "").trim() && (Number(l.qty ?? 1) || 0) > 0)
    .slice(0, 100)
    .map((l) => ({
      title: String(l.title).trim().slice(0, 300),
      ...(l.ref && isId(l.ref.id) && ["service", "package", "item"].includes(l.ref.kind) ? { ref: { kind: l.ref.kind, id: oid(l.ref.id) } } : {}),
      qty: Math.max(0, Number(l.qty ?? 1) || 0),
      unitPrice: Math.max(0, Math.round(Number(l.unitPrice) || 0)),
      discount: Math.min(100, Math.max(0, Number(l.discount) || 0)),
      ...(l.sessions ? { sessions: Math.min(1000, Math.max(0, Math.round(Number(l.sessions) || 0))) } : {}),
    }));
  const value = items.length ? itemsValue(items) : Math.max(0, Math.round(Number(input.value) || 0));
  const base = {
    title: title.slice(0, 200),
    kind: (bizLeadKinds.includes(input.kind as never) ? input.kind : "other") as IBizLead["kind"],
    status: "open" as const,
    value,
    priority: Math.min(3, Math.max(0, Math.round(Number(input.priority) || 0))),
    sourceName: source?.name,
  };
  const allowed = await staffIds(owner);
  const assignee =
    input.assignee && allowed.has(input.assignee) ? oid(input.assignee) : await resolveAssignee(owner, leadRecord(base, contact), by);
  const lead = await BizLead.create({
    ...own(owner),
    ...base,
    contact: contact?._id,
    pipeline: pipe._id,
    stage: stage._id,
    probability: input.probability !== undefined ? Math.min(100, Math.max(0, Math.round(Number(input.probability) || 0))) : stage.probability || 0,
    expectedClose: input.expectedClose,
    source: source?._id,
    assignee,
    note: input.note?.slice(0, 2000),
    items,
    customFields: input.customFields,
    inquiry: input.inquiry && isId(input.inquiry) ? oid(input.inquiry) : undefined,
    createdBy: by ? oid(by) : undefined,
    history: [{ at: new Date(), by: by ? oid(by) : undefined, kind: "created", text: stage.name }],
  });
  await scoreLead(owner, lead._id).catch(() => null);
  if (assignee && String(assignee) !== String(by || ""))
    await notify(assignee, "درخواست درمان تازه", `درخواست «${lead.title}» به شما سپرده شد.`, linkOf(owner, `leads/${lead._id}`));
  return lead.toObject();
};

// ---------------------------------------------------------------- goals

const attributedUsers = async (owner: BizOwner, inv: Pick<IBizInvoice, "createdBy" | "source">, cache: Map<string, string | null>) => {
  const s = inv.source;
  if (s?.type && s.id) {
    const key = `${s.type}:${s.id}`;
    if (!cache.has(key)) {
      let who: unknown = null;
      if (s.type === "crmPlan") {
        const p = await BizPlan.findById(s.id).select("createdBy lead").lean<{ createdBy?: unknown; lead?: unknown }>();
        const l = p?.lead ? await BizLead.findById(p.lead).select("assignee").lean<{ assignee?: unknown }>() : null;
        who = l?.assignee || p?.createdBy;
      } else if (s.type === "crmContract") who = (await BizContract.findById(s.id).select("createdBy").lean<{ createdBy?: unknown }>())?.createdBy;
      else if (s.type === "crmCarePlan") who = (await BizCarePlan.findById(s.id).select("createdBy").lean<{ createdBy?: unknown }>())?.createdBy;
      cache.set(key, who ? String(who) : null);
    }
    const v = cache.get(key);
    if (v) return v;
  }
  return inv.createdBy ? String(inv.createdBy) : null;
};

// the issued invoices of a period with the staff member each counts for
export const invoicesOf = async (owner: BizOwner, start: Date, end: Date) => {
  const rows = await BizInvoice.find({ ...own(owner), status: { $in: ["issued", "partial", "paid"] }, date: { $gte: start, $lte: end } })
    .select("total tax createdBy source date")
    .limit(20000)
    .lean<IBizInvoice[]>();
  const cache = new Map<string, string | null>();
  const out: { _id: string; total: number; net: number; user: string | null }[] = [];
  for (const r of rows) out.push({ _id: String(r._id), total: r.total || 0, net: (r.total || 0) - (r.tax || 0), user: await attributedUsers(owner, r, cache) });
  return out;
};

export const goalProgress = async (owner: BizOwner, g: IBizGoal) => {
  const range = { $gte: g.startDate, $lte: g.endDate };
  const who = g.assignee ? { assignee: g.assignee } : {};
  switch (g.metric) {
    case "leadsCreated":
      return BizLead.countDocuments({ ...own(owner), createdAt: range, ...who });
    case "wonCount":
      return BizLead.countDocuments({ ...own(owner), status: "won", closedAt: range, ...who });
    case "wonValue": {
      const r = await BizLead.aggregate<{ v: number }>([{ $match: { ...own(owner), status: "won", closedAt: range, ...who } }, { $group: { _id: null, v: { $sum: "$value" } } }]);
      return r[0]?.v || 0;
    }
    case "plansSent":
      return BizPlan.countDocuments({ ...own(owner), sentAt: range, ...(g.assignee ? { createdBy: g.assignee } : {}) });
    case "invoiced": {
      const rows = await invoicesOf(owner, g.startDate, g.endDate);
      return rows.filter((r) => !g.assignee || r.user === String(g.assignee)).reduce((s, r) => s + r.total, 0);
    }
    case "serviceSales": {
      const ids = g.lines.map((l) => (l.service ? String(l.service) : "")).filter(Boolean);
      if (!ids.length) return 0;
      const useValue = g.lines.some((l) => l.targetValue > 0);
      const plans = await BizPlan.find({ ...own(owner), status: "accepted", decidedAt: range, "items.ref.id": { $in: ids.map(oid) } })
        .select("items discountPercent createdBy lead")
        .limit(20000)
        .lean<IBizPlan[]>();
      let total = 0;
      for (const p of plans) {
        if (g.assignee) {
          const l = p.lead ? await BizLead.findById(p.lead).select("assignee").lean<{ assignee?: unknown }>() : null;
          if (String(l?.assignee || p.createdBy || "") !== String(g.assignee)) continue;
        }
        const t = planTotals(p.items, p.discountPercent);
        p.items.forEach((it, i) => {
          if (it.ref && ids.includes(String(it.ref.id))) total += useValue ? t.rows[i].net : it.qty;
        });
      }
      return total;
    }
    default:
      return 0;
  }
};

export const goalView = async (owner: BizOwner, g: IBizGoal) => {
  const done = await goalProgress(owner, g).catch(() => 0);
  const now = Date.now();
  const expected = expectedPacePct(+new Date(g.startDate), now, +new Date(g.endDate));
  const pct = g.target > 0 ? Math.round((done / g.target) * 100) : 0;
  return { ...g, done, pct, expected, behind: pct < expected && now < +new Date(g.endDate) };
};

// ---------------------------------------------------------------- commission

export const commissionResult = async (owner: BizOwner, rule: IBizCommissionRule) => {
  const users = new Set<string>([String(rule.user)]);
  if (rule.scope === "team") {
    const teams = await BizTeam.find({ ...own(owner), manager: rule.user }).select("members").lean<{ members: unknown[] }[]>();
    for (const t of teams) for (const m of t.members) users.add(String(m));
  }
  const invoices = await invoicesOf(owner, rule.periodStart, rule.periodEnd);
  const mine = invoices.filter((r) => r.user && users.has(r.user));
  const salesBase = mine.reduce((s, r) => s + r.net, 0);
  // collected: receipts dated in the period on any invoice of these people
  const allInvoices = await BizInvoice.find({ ...own(owner), status: { $in: ["issued", "partial", "paid"] } })
    .select("createdBy source")
    .limit(50000)
    .lean<IBizInvoice[]>();
  const cache = new Map<string, string | null>();
  const theirs: mongoose.Types.ObjectId[] = [];
  for (const inv of allInvoices) {
    const u = await attributedUsers(owner, inv, cache);
    if (u && users.has(u)) theirs.push(inv._id as unknown as mongoose.Types.ObjectId);
  }
  const pays = theirs.length
    ? await BizPayment.find({
        ...own(owner),
        direction: "in",
        invoice: { $in: theirs },
        voidedAt: { $exists: false },
        date: { $gte: rule.periodStart, $lte: rule.periodEnd },
      })
        .select("amount")
        .lean<{ amount: number }[]>()
    : [];
  const collectionBase = pays.reduce((s, p) => s + (p.amount || 0), 0);
  const salesCommission = commissionFor(salesBase, rule.salesPct, rule.salesTiers || [], rule.mode, rule.tierMethod);
  const collectionCommission = commissionFor(collectionBase, rule.collectionPct, rule.collectionTiers || [], rule.mode, rule.tierMethod);
  return {
    salesBase,
    salesCommission,
    collectionBase,
    collectionCommission,
    total: salesCommission + collectionCommission,
    invoiceCount: mine.length,
    receiptCount: pays.length,
    peopleCount: users.size,
  };
};

// ---------------------------------------------------------------- day plan

export type DayTask = {
  kind: "lead" | "followUp" | "overdueClose" | "refill";
  id: string;
  title: string;
  contact?: { _id: string; name?: string; phone?: string } | null;
  score: number;
  priority: number;
  dueAt?: Date;
  meta?: Record<string, unknown>;
};

// today's work of one person (or everyone): stale leads ranked like
// Nexxa's planner, due follow-ups, leads past their expected date, and
// for a pharmacy the customers whose refill is due by their own cadence
export const dayPlan = async (owner: BizOwner, user?: string | null) => {
  const now = Date.now();
  const tasks: DayTask[] = [];
  const who = user && isId(user) ? { assignee: oid(user) } : {};
  const leads = await BizLead.find({ ...own(owner), status: "open", ...who })
    .select("title value probability ruleScore lastActivityAt expectedClose contact")
    .populate("contact", "name phone")
    .limit(500)
    .lean<(IBizLead & { contact?: { _id: unknown; name?: string; phone?: string } })[]>();
  for (const l of leads) {
    const idle = Math.floor((now - +new Date(l.lastActivityAt || l.createdAt)) / DAY);
    const score = leadTaskScore(idle, l.value || 0, l.ruleScore || 0, l.probability || 0);
    const contact = l.contact ? { _id: String(l.contact._id), name: l.contact.name, phone: l.contact.phone } : null;
    const late = l.expectedClose && +new Date(l.expectedClose) < now;
    if (late) tasks.push({ kind: "overdueClose", id: String(l._id), title: l.title, contact, score: score + 20, priority: priorityFromScore(score + 20), dueAt: l.expectedClose, meta: { idle } });
    else if (idle >= 3) tasks.push({ kind: "lead", id: String(l._id), title: l.title, contact, score, priority: priorityFromScore(score), meta: { idle } });
  }
  const fus = await BizActivity.find({
    ...own(owner),
    kind: "followUp",
    doneAt: { $exists: false },
    dueAt: { $lte: new Date(now + DAY) },
    ...(user && isId(user) ? { assignee: oid(user) } : {}),
  })
    .populate("contact", "name phone")
    .limit(200)
    .lean<{ _id: unknown; text: string; dueAt: Date; contact?: { _id: unknown; name?: string; phone?: string } }[]>();
  for (const f of fus) {
    const overdue = +new Date(f.dueAt) < now;
    const score = overdue ? 50 : 35;
    tasks.push({
      kind: "followUp",
      id: String(f._id),
      title: f.text,
      contact: f.contact ? { _id: String(f.contact._id), name: f.contact.name, phone: f.contact.phone } : null,
      score,
      priority: priorityFromScore(score),
      dueAt: f.dueAt,
    });
  }
  if (owner.kind === "pharmacy") {
    // the customers' paid invoices (counter sales and Noyan orders)
    const invs = await BizInvoice.find({ ...own(owner), status: { $in: ["issued", "partial", "paid"] }, date: { $gte: new Date(now - 365 * DAY) }, "party.phone": { $exists: true } })
      .select("party.phone party.name date")
      .limit(20000)
      .lean<{ party: { phone?: string; name?: string }; date: Date }[]>();
    const by = new Map<string, { name?: string; dates: number[] }>();
    for (const i of invs) {
      const p = normalizeMobile(i.party.phone);
      if (!p) continue;
      const e = by.get(p) || { name: i.party.name, dates: [] };
      e.dates.push(+new Date(i.date));
      by.set(p, e);
    }
    const phones = [...by.keys()];
    const contacts = phones.length ? await BizContact.find({ ...own(owner), phone: { $in: phones } }).select("name phone").lean<{ _id: unknown; name?: string; phone: string }[]>() : [];
    for (const [phone, e] of by) {
      const cadence = purchaseCadence(e.dates);
      const last = Math.max(...e.dates);
      const due = dueInDaysFor(last, cadence, now);
      if (!isReorderDue(e.dates.length, due, cadence)) continue;
      const c = contacts.find((x) => x.phone === phone);
      const score = 30 + (due <= 0 ? 10 : 0) + Math.min(10, e.dates.length * 2);
      tasks.push({
        kind: "refill",
        id: phone,
        title: e.name || phone,
        contact: c ? { _id: String(c._id), name: c.name, phone } : { _id: "", name: e.name, phone },
        score,
        priority: priorityFromScore(score),
        meta: { cadence, dueIn: due, count: e.dates.length },
      });
    }
  }
  return tasks.sort((a, b) => b.score - a.score).slice(0, 100);
};

// a task done: its trace on the patient's timeline (tomorrow's plan reads it)
export const completeTask = async (owner: BizOwner, task: { kind: DayTask["kind"]; id: string; note?: string }, by?: unknown) => {
  const note = (task.note || "").trim().slice(0, 900);
  if (task.kind === "followUp") {
    const f = await BizActivity.findOne({ ...own(owner), _id: task.id, kind: "followUp" });
    if (!f) throw new AppError("پیگیری پیدا نشد", 404);
    f.doneAt = new Date();
    await f.save();
    if (note) await BizActivity.create({ ...own(owner), contact: f.contact, kind: "note", text: note, createdBy: by });
    return;
  }
  if (task.kind === "refill") {
    const c = await BizContact.findOne({ ...own(owner), phone: normalizeMobile(task.id) }).lean<IBizContact>();
    if (!c) throw new AppError("مشتری پیدا نشد", 404);
    await BizActivity.create({ ...own(owner), contact: c._id, kind: "call", text: note || "پیگیری تمدید دارو", createdBy: by });
    return;
  }
  const lead = await BizLead.findOne({ ...own(owner), _id: task.id });
  if (!lead) throw new AppError("درخواست پیدا نشد", 404);
  lead.lastActivityAt = new Date();
  await lead.save();
  if (lead.contact) await BizActivity.create({ ...own(owner), contact: lead.contact, kind: "note", text: note || `پیگیری درخواست «${lead.title}»`, createdBy: by });
};

// ---------------------------------------------------------------- catalog

// what a plan or a lead line can be picked from: the doctor's services and
// packages (a clinic: those of its doctors), and stock items
export const catalogOf = async (owner: BizOwner, q?: string) => {
  const re = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
  const doctors =
    owner.kind === "doctor"
      ? [oid(owner.id)]
      : owner.kind === "clinic"
        ? (await ClinicDoctor.find({ clinic: owner.id }).select("doctor").lean<{ doctor: unknown }[]>()).map((d) => oid(d.doctor))
        : [];
  const [services, packages, items] = await Promise.all([
    doctors.length ? Service.find({ owner: { $in: doctors }, ...(re ? { name: re } : {}) }).select("name price discount").limit(200).lean<{ _id: unknown; name?: string; price: number; discount: number }[]>() : [],
    doctors.length ? ServicePackage.find({ owner: { $in: doctors }, ...(re ? { name: re } : {}) }).select("name price discount").limit(100).lean<{ _id: unknown; name?: string; price: number; discount: number }[]>() : [],
    BizItem.find({ ...own(owner), isActive: true, ...(re ? { name: re } : {}) }).select("name lastCost").limit(200).lean<{ _id: unknown; name: string; lastCost: number }[]>(),
  ]);
  return [
    ...services.map((s) => ({ kind: "service" as const, id: String(s._id), title: s.name || "", price: Math.max(0, (s.price || 0) - (s.discount || 0)) })),
    ...packages.map((s) => ({ kind: "package" as const, id: String(s._id), title: s.name || "", price: Math.max(0, (s.price || 0) - (s.discount || 0)) })),
    ...items.map((s) => ({ kind: "item" as const, id: String(s._id), title: s.name, price: s.lastCost || 0 })),
  ].filter((x) => x.title);
};

// ---------------------------------------------------------------- merge

// the duplicates' whole history moves to the primary, its blanks are
// filled and tags joined; a hand-made duplicate is deleted, one Noyan's
// sync keeps (it has visits on an account) is archived pointing at the
// primary, so nothing comes back and nothing is lost (Nexxa mergeContacts)
export const mergeContacts = async (owner: BizOwner, primaryId: string, dupIds: string[]) => {
  const ids = [...new Set(dupIds.filter(isId))].filter((d) => d !== primaryId);
  if (!isId(primaryId) || !ids.length) throw new AppError("پرونده‌ی اصلی و دست‌کم یک تکراری را انتخاب کنید", 400);
  const [primary, dups] = await Promise.all([
    BizContact.findOne({ ...own(owner), _id: primaryId }).lean<IBizContact>(),
    BizContact.find({ ...own(owner), _id: { $in: ids.map(oid) } }).lean<IBizContact[]>(),
  ]);
  if (!primary || dups.length !== ids.length) throw new AppError("پرونده پیدا نشد", 404);
  const dupOids = dups.map((d) => d._id);
  const to = { $set: { contact: primary._id } };
  await Promise.all([
    BizActivity.updateMany({ ...own(owner), contact: { $in: dupOids } }, to),
    BizMessage.updateMany({ ...own(owner), contact: { $in: dupOids } }, to),
    BizLead.updateMany({ ...own(owner), contact: { $in: dupOids } }, to),
    BizPlan.updateMany({ ...own(owner), contact: { $in: dupOids } }, to),
    BizContract.updateMany({ ...own(owner), contact: { $in: dupOids } }, to),
    BizCarePlan.updateMany({ ...own(owner), contact: { $in: dupOids } }, to),
    BizCall.updateMany({ ...own(owner), contact: { $in: dupOids } }, to),
    BizApproval.updateMany({ ...own(owner), contact: { $in: dupOids } }, to),
  ]);
  const merged = mergeFields(primary as never, dups as never);
  await BizContact.updateOne(
    { _id: primary._id },
    {
      $set: {
        ...Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)),
        ...(!primary.user ? { user: dups.find((d) => d.user)?.user } : {}),
      },
    },
  );
  // the sales side: blanks from the duplicates, custom values joined, the
  // higher credit limit
  const exts = await BizContactExt.find({ contact: { $in: [primary._id, ...dupOids] } }).lean<IBizContactExt[]>();
  const mine = exts.find((e) => String(e.contact) === String(primary._id));
  const others = exts.filter((e) => String(e.contact) !== String(primary._id));
  if (others.length) {
    const cf = { ...Object.assign({}, ...others.map((o) => o.customFields || {})), ...(mine?.customFields || {}) };
    await BizContactExt.updateOne(
      { contact: primary._id },
      {
        $set: {
          nationalId: mine?.nationalId || others.find((o) => o.nationalId)?.nationalId,
          email: mine?.email || others.find((o) => o.email)?.email,
          customFields: cf,
          creditLimit: Math.max(mine?.creditLimit || 0, ...others.map((o) => o.creditLimit || 0)),
          assignee: mine?.assignee || others.find((o) => o.assignee)?.assignee,
        },
        $setOnInsert: { ...own(owner), contact: primary._id },
      },
      { upsert: true },
    );
  }
  const synced = dups.filter((d) => d.user && (d.visits || d.orders));
  const manual = dups.filter((d) => !synced.includes(d));
  if (manual.length) {
    await BizContactExt.deleteMany({ contact: { $in: manual.map((d) => d._id) } });
    await BizContact.deleteMany({ _id: { $in: manual.map((d) => d._id) } });
  }
  for (const d of synced) {
    await BizContact.updateOne({ _id: d._id }, { $set: { isActive: false, smsOptOut: true } });
    await BizContactExt.updateOne(
      { contact: d._id },
      { $set: { mergedInto: primary._id, mergedAt: new Date() }, $setOnInsert: { ...own(owner), contact: d._id } },
      { upsert: true },
    );
  }
  return { merged: dups.length, deleted: manual.length, archived: synced.length };
};

// ---------------------------------------------------------------- job

// contracts past their end expire; 30 days before, the owner is reminded
// once (Nexxa renewNotifiedAt)
export const sweepContracts = async () => {
  const now = new Date();
  await BizContract.updateMany({ state: "active", endDate: { $lt: now } }, { $set: { state: "expired" } });
  const soon = await BizContract.find({ state: "active", endDate: { $gte: now, $lte: new Date(+now + 30 * DAY) }, renewNotifiedAt: { $exists: false } })
    .limit(200)
    .lean<IBizContract[]>();
  for (const c of soon) {
    const claimed = await BizContract.updateOne({ _id: c._id, renewNotifiedAt: { $exists: false } }, { $set: { renewNotifiedAt: now } });
    if (!claimed.modifiedCount) continue;
    const owner = { kind: c.ownerKind, id: String(c.ownerId) } as BizOwner;
    const user = await ownerUser(owner).catch(() => "");
    await notify(user, "تمدید قرارداد", `قرارداد «${c.subject}» با ${c.party?.name || ""} به‌زودی تمام می‌شود.`, linkOf(owner, `contracts/${c._id}`));
  }
};

let running = false;
export const startCrmSalesJob = () => {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueCarePlans().catch((err) => console.log("[crm sales] care plans failed:", err));
      await sweepContracts().catch((err) => console.log("[crm sales] contracts failed:", err));
    } finally {
      running = false;
    }
  };
  setInterval(() => tick(), 15 * 60_000);
};

// ---------------------------------------------------------------- scope

// the leads one person sees (Nexxa leadScopeWhere), when the owner turned
// team scope on; closed on doubt - only their own
export const leadScope = async (owner: BizOwner, user: unknown): Promise<Record<string, unknown>> => {
  const cfg = await settingsOf(owner);
  if (!cfg.teamScope) return {};
  try {
    const top = await ownerUser(owner);
    if (!user || String(user) === top) return {};
    const teams = await BizTeam.find({ ...own(owner), manager: oid(user) }).select("members").lean<{ members: unknown[] }[]>();
    const ids = new Set<string>([String(user)]);
    for (const t of teams) for (const m of t.members) ids.add(String(m));
    return { $or: [{ assignee: { $in: [...ids].map(oid) } }, { assignee: { $exists: false } }, { assignee: null }] };
  } catch {
    return { assignee: user ? oid(user) : null };
  }
};
