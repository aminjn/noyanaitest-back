import BizFlow, { BizFlowTrigger, IBizFlow, IBizFlowCondition, IBizFlowStep } from "../../../Models/BizFlow";
import BizFlowRun, { IBizFlowLog, IBizFlowRun } from "../../../Models/BizFlowRun";
import { IBizRequest } from "../../../Models/BizRequest";
import { cancelOpen, fileRequest, KindHooks } from "../kartabl";
import BizContact, { IBizContact } from "../../../Models/BizContact";
import BizActivity from "../../../Models/BizActivity";
import BizProject, { IBizProject } from "../../../Models/BizProject";
import BizTask from "../../../Models/BizTask";
import BizInvoice from "../../../Models/BizInvoice";
import Reservation from "../../../Models/Reservation";
import { BizOwner } from "../coa";
import { syncContacts, visitsWhere } from "../crm";
import { clubSettings, memberRows, adjustPoints } from "./club";
import { crmLink, DAY, fill, HOUR, notify, oid, own, ownerOfDoc, ownerUser, teamMember } from "./common";
import { sendTemplateToContact } from "./sms";
import { enrollContacts } from "./sequence";

// The workflow engine (2026-10), nexxacrm's lib/automation.ts: an event
// (fireFlows, or found by the job for visits, new patients and invoices)
// starts a run of every switched-on workflow of the owner with that trigger
// whose filters the patient meets; the run walks the steps, stops at a
// delay (resumed by the job) or an approval (resumed by the decision in the
// inbox), and logs every step. A run never repeats for the same event
// (BizFlowRun.dedupeKey); an action that fails is logged and the run goes
// on (marked failed at the end), as in nexxacrm.

// ---------------------------------------------------------------- conditions

export type Facts = Record<string, string | number | string[]>;

const latin = (s: string) => s.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

// nexxacrm rules.ts matchCondition, on a patient's facts; a list field
// (tags) matches when any of its values does
export const matchCondition = (facts: Facts, c: IBizFlowCondition): boolean => {
  const raw = facts[c.field];
  const values = (Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : [raw]).map((v) => latin(String(v)).trim().toLowerCase());
  const target = latin(String(c.value ?? "")).trim().toLowerCase();
  const list = target.split(/[,،]/).map((s) => s.trim()).filter(Boolean);
  const num = (v: string) => Number(v);
  switch (c.op) {
    case "empty":
      return values.length === 0;
    case "notempty":
      return values.length > 0;
    case "eq":
      return values.some((v) => v === target);
    case "neq":
      return !values.some((v) => v === target);
    case "contains":
      return values.some((v) => v.includes(target));
    case "in":
      return values.some((v) => list.includes(v));
    case "gt":
      return values.some((v) => Number.isFinite(num(v)) && Number.isFinite(num(target)) && num(v) > num(target));
    case "lt":
      return values.some((v) => Number.isFinite(num(v)) && Number.isFinite(num(target)) && num(v) < num(target));
    default:
      return false;
  }
};
export const matchAll = (facts: Facts, conds?: IBizFlowCondition[]) => !conds?.length || conds.every((c) => matchCondition(facts, c));

export const factsOf = async (owner: BizOwner, c: IBizContact): Promise<Facts> => {
  const settings = await clubSettings(owner);
  const [m] = settings.enabled ? await memberRows(owner, [c], settings) : [];
  return {
    tags: c.tags || [],
    visits: c.visits || 0,
    orders: c.orders || 0,
    spent: c.spent || 0,
    noShows: c.noShows || 0,
    gender: c.gender || "",
    insurer: c.insurer || "",
    city: c.city || "",
    source: c.source || "",
    tier: m?.tier || "",
    age: c.birthYear ? new Date().getFullYear() - c.birthYear : "",
  };
};

// ---------------------------------------------------------------- runs

type Entity = { type: string; id: string; contact?: unknown };

const pushLog = (runId: unknown, entry: Omit<IBizFlowLog, "at">) => BizFlowRun.updateOne({ _id: runId }, { $push: { log: { ...entry, at: new Date() } } });

const finish = async (run: IBizFlowRun, status: "done" | "failed" | "cancelled") => {
  await BizFlowRun.updateOne({ _id: run._id }, { $set: { status, finishedAt: new Date() }, $unset: { resumeAt: 1 } });
};

const execAction = async (flow: IBizFlow, run: IBizFlowRun, i: number, step: IBizFlowStep, c: IBizContact | null): Promise<{ result: IBizFlowLog["result"]; note?: string; retry?: boolean }> => {
  const owner = ownerOfDoc(flow);
  if (!c) return { result: "skipped", note: "contact" };
  const vars = { name: c.name || "", firstName: (c.name || "").split(/\s+/)[0] || "", phone: c.phone };
  const text = fill(step.text || flow.name, vars).slice(0, 1000);
  const assignee = (await teamMember(owner, step.assignee)) || (await ownerUser(owner));
  switch (step.action) {
    case "sendSms": {
      const r = await sendTemplateToContact(owner, c, step.template, { source: "flow", dedupeKey: `flow:${run._id}:${i}` });
      if (r.ok) return { result: "ok" };
      if (r.reason === "window" || r.reason === "noCredit") return { result: "waiting", note: r.reason, retry: true };
      if (r.reason === "duplicate") return { result: "ok" };
      return { result: r.reason === "gateway" ? "failed" : "skipped", note: r.reason };
    }
    case "followUp":
      await BizActivity.create({
        ...own(owner),
        contact: c._id,
        kind: "followUp",
        text,
        dueAt: new Date(Date.now() + (step.dueDays || 0) * DAY),
        ...(assignee ? { assignee } : {}),
      });
      return { result: "ok" };
    case "note":
      await BizActivity.create({ ...own(owner), contact: c._id, kind: "note", text });
      return { result: "ok" };
    case "task": {
      const project = step.project
        ? await BizProject.findOne({ ...own(owner), _id: step.project }).lean<IBizProject>()
        : await BizProject.findOne({ ...own(owner), status: "active" }).sort({ createdAt: 1 }).lean<IBizProject>();
      const stage = project?.stages.find((s) => !s.isClosed) || project?.stages[0];
      if (!project || !stage) return { result: "skipped", note: "project" };
      const task = await BizTask.create({
        ...own(owner),
        project: project._id,
        stage: stage._id,
        title: text.slice(0, 200),
        contact: c._id,
        priority: 1,
        ...(step.dueDays !== undefined ? { dueAt: new Date(Date.now() + (step.dueDays || 0) * DAY) } : {}),
        ...(assignee ? { assignee } : {}),
        done: stage.isClosed,
      });
      if (assignee) await notify(assignee, "کار تازه به شما سپرده شد", `«${task.title}»`, crmLink(owner, `tasks/${project._id}`));
      return { result: "ok" };
    }
    case "addTag":
    case "removeTag": {
      const tag = (step.tag || "").trim();
      if (!tag) return { result: "skipped", note: "tag" };
      await BizContact.updateOne({ _id: c._id }, step.action === "addTag" ? { $addToSet: { tags: tag } } : { $pull: { tags: tag } });
      return { result: "ok" };
    }
    case "notify":
      if (!assignee) return { result: "skipped", note: "user" };
      await notify(assignee, `گردش‌کار «${flow.name}»`, `${text} (${c.name || c.phone})`, crmLink(owner, `contacts/${c._id}`));
      return { result: "ok" };
    case "enrollSequence": {
      if (!step.sequence) return { result: "skipped", note: "sequence" };
      const r = await enrollContacts(owner, step.sequence, [c._id], undefined, `flow:${run._id}`);
      return r.enrolled ? { result: "ok" } : { result: "skipped", note: "enrolled" };
    }
    case "clubPoints": {
      if (!step.points) return { result: "skipped", note: "points" };
      await adjustPoints(owner, c._id, step.points, flow.name, undefined, `flow:${run._id}:${i}`);
      return { result: "ok" };
    }
    default:
      return { result: "skipped", note: "action" };
  }
};

// walks the run from its current step until it ends or has to wait
export const walk = async (runId: unknown) => {
  const run = await BizFlowRun.findById(runId).lean<IBizFlowRun>();
  if (!run || run.status !== "running") return;
  const flow = await BizFlow.findById(run.flow).lean<IBizFlow>();
  if (!flow) return finish(run, "cancelled");
  const owner = ownerOfDoc(flow);
  const contact = run.contact ? await BizContact.findOne({ ...own(owner), _id: run.contact }).lean<IBizContact>() : null;
  let failed = (run.log || []).some((l) => l.result === "failed");
  for (let i = run.step; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    if (step.kind === "condition") {
      const ok = !!contact && matchAll(await factsOf(owner, contact), step.conditions);
      await pushLog(run._id, { step: i, kind: "condition", result: ok ? "yes" : "no" });
      if (!ok) {
        await BizFlowRun.updateOne({ _id: run._id }, { $set: { step: i } });
        return finish(run, failed ? "failed" : "done");
      }
      continue;
    }
    if (step.kind === "delay") {
      const ms = (step.days || 0) * DAY + (step.hours || 0) * HOUR;
      if (ms <= 0) continue;
      const resumeAt = new Date(Date.now() + ms);
      await pushLog(run._id, { step: i, kind: "delay", result: "waiting", note: resumeAt.toISOString() });
      await BizFlowRun.updateOne({ _id: run._id }, { $set: { status: "waitingDelay", step: i + 1, resumeAt } });
      return;
    }
    if (step.kind === "approval") {
      const approver = (await teamMember(owner, step.approver)) || (await ownerUser(owner));
      if (!approver) {
        await pushLog(run._id, { step: i, kind: "approval", result: "skipped", note: "approver" });
        continue;
      }
      const title = fill(step.title || flow.name, { name: contact?.name || "", firstName: (contact?.name || "").split(/\s+/)[0] || "", phone: contact?.phone || "" });
      // the step waits in the approver's «کارتابل» (Lib/business/kartabl.ts)
      await fileRequest(owner, {
        kind: "flow",
        run: run._id,
        step: i,
        title: title.slice(0, 300),
        detail: contact ? `${contact.name || ""} ${contact.phone}`.trim() : undefined,
        ...(contact ? { contact: contact._id } : {}),
        approvers: [approver],
      });
      await pushLog(run._id, { step: i, kind: "approval", result: "waiting" });
      await BizFlowRun.updateOne({ _id: run._id }, { $set: { status: "waitingApproval", step: i } });
      return;
    }
    // an action
    let r: Awaited<ReturnType<typeof execAction>>;
    try {
      r = await execAction(flow, run, i, step, contact);
    } catch (err) {
      r = { result: "failed", note: String((err as Error)?.message || err).slice(0, 200) };
    }
    if (r.retry) {
      // outside the send window / no credit: the same step in an hour
      const last = (await BizFlowRun.findById(run._id).select("log").lean<IBizFlowRun>())?.log?.slice(-1)[0];
      if (!(last && last.step === i && last.result === "waiting")) await pushLog(run._id, { step: i, kind: step.action || "action", result: "waiting", note: r.note });
      await BizFlowRun.updateOne({ _id: run._id }, { $set: { status: "waitingDelay", step: i, resumeAt: new Date(Date.now() + HOUR) } });
      return;
    }
    if (r.result === "failed") failed = true;
    await pushLog(run._id, { step: i, kind: step.action || "action", result: r.result, note: r.note });
  }
  await BizFlowRun.updateOne({ _id: run._id }, { $set: { step: flow.steps.length } });
  return finish(run, failed ? "failed" : "done");
};

const startRun = async (flow: IBizFlow, trigger: string, entity: Entity) => {
  const run = await BizFlowRun.create({
    ownerKind: flow.ownerKind,
    ownerId: flow.ownerId,
    flow: flow._id,
    trigger,
    entityType: entity.type,
    entityId: entity.id,
    ...(entity.contact ? { contact: oid(entity.contact) } : {}),
    dedupeKey: `${flow._id}:${trigger}:${entity.id}`,
    status: "running",
    step: 0,
  }).catch((err) => ((err as { code?: number })?.code === 11000 ? null : Promise.reject(err)));
  if (!run) return null;
  await BizFlow.updateOne({ _id: flow._id }, { $inc: { runCount: 1 }, $set: { lastRunAt: new Date() } });
  await walk(run._id).catch((err) => console.log(`[crm] flow run ${run._id} failed:`, err));
  return run;
};

// An event of the owner: every switched-on workflow with this trigger whose
// filters the patient meets. Never throws (the caller's own work goes on).
export const fireFlows = async (owner: BizOwner, trigger: BizFlowTrigger, entity: Entity, only?: unknown) => {
  try {
    const flows = await BizFlow.find({ ...own(owner), trigger, active: true, ...(only ? { _id: only } : {}) }).lean<IBizFlow[]>();
    if (!flows.length) return;
    const contact = entity.contact ? await BizContact.findOne({ ...own(owner), _id: oid(entity.contact) }).lean<IBizContact>() : null;
    const facts = contact ? await factsOf(owner, contact) : null;
    for (const f of flows) {
      if (f.filters?.length && !(facts && matchAll(facts, f.filters))) continue;
      await startRun(f, trigger, entity);
    }
  } catch (err) {
    console.log(`[crm] fireFlows ${trigger} failed:`, err);
  }
};

// ---------------------------------------------------------------- approvals

// a flow approval decided in the inbox: approve goes on; reject stops the
// run or goes on (the step's onReject)
export const decideFlowApproval = async (a: IBizRequest, decision: "approved" | "rejected") => {
  if (!a.run) return;
  const run = await BizFlowRun.findById(a.run).lean<IBizFlowRun>();
  if (!run || run.status !== "waitingApproval" || run.step !== a.step) return;
  const flow = await BizFlow.findById(run.flow).lean<IBizFlow>();
  const step = flow?.steps[run.step];
  const note = decision === "rejected" ? a.rejectReason : undefined;
  await pushLog(run._id, { step: run.step, kind: "approval", result: decision, ...(note ? { note: note.slice(0, 300) } : {}) });
  if (decision === "rejected" && (step?.onReject || "stop") === "stop") return finish(run, "cancelled");
  await BizFlowRun.updateOne({ _id: run._id, status: "waitingApproval" }, { $set: { status: "running", step: run.step + 1 } });
  await walk(run._id);
};

// cancel a waiting run (from its log page): its open approval goes too
export const cancelRun = async (owner: BizOwner, runId: unknown) => {
  const run = await BizFlowRun.findOneAndUpdate(
    { ...own(owner), _id: oid(runId), status: { $in: ["running", "waitingDelay", "waitingApproval"] } },
    { $set: { status: "cancelled", finishedAt: new Date() }, $unset: { resumeAt: 1 } },
    { new: true },
  ).lean<IBizFlowRun>();
  if (!run) return false;
  await cancelOpen({ kind: "flow", run: run._id });
  return true;
};

// the inbox's side of a workflow step: approving goes on with the run,
// rejecting follows the step's onReject; it is cancelled with its run and
// never reopened (the run has moved on)
export const flowHooks: KindHooks = {
  title: "تأیید گردش کار",
  domain: "crm",
  apply: async (_owner, r) => {
    await decideFlowApproval(r, "approved");
  },
  onReject: (_owner, r) => decideFlowApproval(r, "rejected"),
  reopenable: false,
  cancellable: false,
};

// ---------------------------------------------------------------- job

const POLLED: BizFlowTrigger[] = ["visit.completed", "visit.noShow", "visit.cancelled", "contact.created", "invoice.issued"];
const BATCH = 200;

// the events of a polled trigger after `since`, oldest first
const pollEvents = async (owner: BizOwner, trigger: BizFlowTrigger, since: Date, until: Date): Promise<{ at: Date; entity: Entity }[]> => {
  if (trigger === "contact.created") {
    const cs = await BizContact.find({ ...own(owner), createdAt: { $gt: since, $lte: until } }).sort({ createdAt: 1 }).limit(BATCH).select("createdAt").lean<IBizContact[]>();
    return cs.map((c) => ({ at: c.createdAt, entity: { type: "contact", id: String(c._id), contact: c._id } }));
  }
  if (trigger === "invoice.issued") {
    const invs = await BizInvoice.find({ ...own(owner), origin: "manual", issuedAt: { $gt: since, $lte: until } })
      .sort({ issuedAt: 1 })
      .limit(BATCH)
      .select("issuedAt party")
      .lean<{ _id: unknown; issuedAt: Date; party?: { phone?: string } }[]>();
    const phones = invs.map((i) => (i.party?.phone || "").replace(/\D/g, "").replace(/^98/, "0")).filter(Boolean);
    const cs = phones.length ? await BizContact.find({ ...own(owner), phone: { $in: phones } }).select("phone").lean<IBizContact[]>() : [];
    const byPhone = new Map(cs.map((c) => [c.phone, c._id]));
    return invs.map((i) => ({ at: i.issuedAt, entity: { type: "invoice", id: String(i._id), contact: byPhone.get((i.party?.phone || "").replace(/\D/g, "").replace(/^98/, "0")) } }));
  }
  const where = await visitsWhere(owner);
  if (!where) return [];
  const field = trigger === "visit.cancelled" ? "cancelledAt" : "finalizedAt";
  const status = trigger === "visit.completed" ? "completed" : trigger === "visit.noShow" ? "noShow" : "cancelled";
  const rs = await Reservation.find({
    ...where,
    status,
    user: { $exists: true },
    [field]: { $gt: since, $lte: until },
    ...(status === "noShow" ? { noShowParty: { $ne: "doctor" } } : {}),
  })
    .sort({ [field]: 1 })
    .limit(BATCH)
    .select(`user ${field}`)
    .lean<Record<string, unknown>[]>();
  if (!rs.length) return [];
  await syncContacts(owner);
  const cs = await BizContact.find({ ...own(owner), user: { $in: rs.map((r) => r.user) } }).select("user").lean<IBizContact[]>();
  const byUser = new Map(cs.map((c) => [String(c.user), c._id]));
  return rs.map((r) => ({ at: r[field] as Date, entity: { type: "reservation", id: String(r._id), contact: byUser.get(String(r.user)) } }));
};

let running = false;
export const runFlowSweep = async () => {
  if (running) return;
  running = true;
  try {
    // delays that fell due
    const due = await BizFlowRun.find({ status: "waitingDelay", resumeAt: { $lte: new Date() } }).limit(200).select("_id").lean();
    for (const r of due) {
      const claim = await BizFlowRun.updateOne({ _id: r._id, status: "waitingDelay" }, { $set: { status: "running" }, $unset: { resumeAt: 1 } });
      if (claim.modifiedCount) await walk(r._id).catch((err) => console.log(`[crm] flow resume ${r._id} failed:`, err));
    }
    // the polled triggers: only events after the workflow was switched on
    const flows = await BizFlow.find({ active: true, trigger: { $in: POLLED } }).limit(300).lean<IBizFlow[]>();
    for (const f of flows) {
      const owner = ownerOfDoc(f);
      const until = new Date();
      const since = new Date(Math.max(+(f.cursor || 0), +(f.enabledAt || f.createdAt)));
      const events = await pollEvents(owner, f.trigger, since, until).catch(() => []);
      for (const e of events) if (e.entity.contact) await fireFlows(owner, f.trigger, e.entity, f._id);
      const cursor = events.length >= BATCH ? events[events.length - 1].at : until;
      await BizFlow.updateOne({ _id: f._id }, { $set: { cursor } });
    }
  } finally {
    running = false;
  }
};

// a run for one patient now, whatever the trigger (a test or a manual start)
export const startManualRun = async (flow: IBizFlow, contact: unknown) => {
  const run = await startRun(flow, "manual", { type: "manual", id: `${contact}:${Date.now()}`, contact });
  return run ? BizFlowRun.findById(run._id).lean() : null;
};
