import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import BizContact, { IBizContact } from "../Models/BizContact";
import BizActivity from "../Models/BizActivity";
import BizTicket, { bizTicketCategories, bizTicketPriorities, bizTicketStatuses, IBizTicket } from "../Models/BizTicket";
import BizProject, { bizProjectStatuses, IBizProject } from "../Models/BizProject";
import BizTask, { IBizTask } from "../Models/BizTask";
import BizTimeLog, { IBizTimeLog } from "../Models/BizTimeLog";
import BizCalendarEvent, { bizEventKinds, IBizCalendarEvent } from "../Models/BizCalendarEvent";
import BizChecklist, { IBizChecklist } from "../Models/BizChecklist";
import BizChecklistItem, { bizRepeats, IBizChecklistItem } from "../Models/BizChecklistItem";
import { BizOwner } from "../Lib/business/coa";
import { nextDocNumber } from "../Lib/business/voucher";
import { orgInfo } from "../Lib/business/campaign";
import { crmLink, DAY, idRe, isId, isOwnerUser, notify, oid, own, team, teamMember } from "../Lib/business/crmService/common";
import { breachOf, computeSla, pickAssignee } from "../Lib/business/crmService/tickets";
import { advanceDue } from "../Lib/business/crmService/checklist";
import { fireFlows } from "../Lib/business/crmService/flow";
import { notifyWithSms } from "../Services/notificationSmsService";
import { OwnerOf } from "./businessController";

// The CRM's team work under /<panel>/crm (2026-10, nexxacrm's tickets,
// projects, timesheet, calendar and checklist): patients' requests with
// SLA and assignment, team tasks on boards with logged hours, the team
// calendar and checklists (with templates started for a patient). Routes
// and their access are in Routers/crmServiceRoutes.ts.

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
const date = z.coerce.date();
const ok = (res: Response, message: string, data?: unknown, code = 200) => res.status(code).json({ message, ...(data !== undefined ? { data } : {}) });
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ownContact = async (owner: BizOwner, contact?: string | null) => {
  if (!contact) return null;
  const c = await BizContact.findOne({ ...own(owner), _id: contact }).select("name phone user").lean<IBizContact>();
  if (!c) throw new AppError("این بیمار پیدا نشد", 404);
  return c;
};
const assertMember = async (owner: BizOwner, user?: string | null) => {
  if (user && !(await teamMember(owner, user))) throw new AppError("این شخص عضو تیم این بخش نیست", 400);
};

// "YYYY-MM-DD" + "HH:mm" in Tehran, or the day alone (all-day)
const tehran = (d: string, t?: string | null) => new Date(`${d}T${t || "00:00"}:00+03:30`);

const DEFAULT_STAGES = [
  { name: "انجام نشده", isClosed: false },
  { name: "در حال انجام", isClosed: false },
  { name: "انجام شد", isClosed: true },
];

// the ticket as the team sees it, with its SLA state
const ticketView = (t: IBizTicket) => ({ ...t, breach: breachOf(t) });

export const makeCrmWorkController = (ownerOf: OwnerOf) => ({
  // ---------------------------------------------------------------- tickets
  getTickets: withOwner(ownerOf, async (owner, req, res) => {
    const q = z
      .object({ status: z.enum([...bizTicketStatuses, "active", "all"]).default("active"), mine: z.enum(["0", "1"]).default("0"), q: z.string().max(60).optional(), contact: id.optional() })
      .safeParse(req.query);
    if (!q.success) throw new BadInputError();
    const term = q.data.q?.trim();
    const rows = await BizTicket.find({
      ...own(owner),
      ...(q.data.status === "active" ? { status: { $in: ["open", "pending"] } } : q.data.status === "all" ? {} : { status: q.data.status }),
      ...(q.data.mine === "1" ? { assignee: oid(me(req)) } : {}),
      ...(q.data.contact ? { contact: oid(q.data.contact) } : {}),
      ...(term ? { $or: [{ subject: { $regex: esc(term), $options: "i" } }, ...(/^\d+$/.test(term) ? [{ number: Number(term) }] : [])] } : {}),
    })
      .sort({ lastMessageAt: -1 })
      .limit(300)
      .select("-messages")
      .populate("contact", "name phone")
      .lean<IBizTicket[]>();
    ok(res, "crmTickets", rows.map(ticketView));
  }),
  createTicket: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        subject: z.string().trim().min(2).max(200),
        body: z.string().trim().min(2).max(5000),
        priority: z.enum(bizTicketPriorities).default("normal"),
        category: z.enum(bizTicketCategories).default("question"),
        contact: optId,
        assignee: optId,
      })
      .safeParse(req.body || {});
    if (!parsed.success) throw new AppError("موضوع و متن درخواست را بنویسید", 400);
    const d = parsed.data;
    const c = await ownContact(owner, d.contact);
    await assertMember(owner, d.assignee);
    const now = Date.now();
    const sla = computeSla(d.priority, now);
    const assignee = d.assignee || (await pickAssignee(owner, req.user?._id));
    const t = await BizTicket.create({
      ...own(owner),
      number: await nextDocNumber("bizTicket", owner),
      subject: d.subject,
      category: d.category,
      priority: d.priority,
      ...(c ? { contact: c._id, ...(c.user ? { user: c.user } : {}) } : {}),
      ...(assignee ? { assignee } : {}),
      responseDueAt: new Date(sla.responseDueMs),
      resolveDueAt: new Date(sla.resolveDueMs),
      messages: [{ body: d.body, internal: false, fromPatient: false, author: req.user?._id }],
      lastMessageAt: new Date(now),
      openedBy: req.user?._id,
    });
    if (assignee && assignee !== me(req)) await notify(assignee, "درخواست تازه به شما سپرده شد", `درخواست شماره‌ی ${t.number.toLocaleString("fa-IR")}: «${t.subject}»`, crmLink(owner, `tickets/${t._id}`));
    if (c) await fireFlows(owner, "ticket.created", { type: "ticket", id: String(t._id), contact: c._id });
    ok(res, "crmCreateTicket", t, 201);
  }),
  getTicket: withOwner(ownerOf, async (owner, req, res) => {
    const t = await BizTicket.findOne({ ...own(owner), _id: param(req, "ticketId") }).populate("contact", "name phone").lean<IBizTicket>();
    if (!t) throw new NotFoundError();
    ok(res, "crmTicket", ticketView(t));
  }),
  // a public reply or an internal note; the first public reply stops the
  // response clock and an open ticket moves to "waiting on the patient"
  replyTicket: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ body: z.string().trim().min(1).max(5000), internal: z.boolean().default(false) }).safeParse(req.body || {});
    if (!parsed.success) throw new AppError("متن پاسخ را بنویسید", 400);
    const t = await BizTicket.findOne({ ...own(owner), _id: param(req, "ticketId") }).lean<IBizTicket>();
    if (!t) throw new NotFoundError();
    if (t.status === "closed") throw new AppError("این درخواست بسته شده است", 400);
    const now = new Date();
    const pub = !parsed.data.internal;
    const out = await BizTicket.findOneAndUpdate(
      { _id: t._id },
      {
        $push: { messages: { body: parsed.data.body, internal: !pub, fromPatient: false, author: req.user?._id, at: now } },
        $set: {
          ...(pub ? { lastMessageAt: now } : {}),
          ...(pub && !t.firstResponseAt ? { firstResponseAt: now } : {}),
          ...(pub && t.status === "open" ? { status: "pending" } : {}),
        },
      },
      { new: true },
    ).lean<IBizTicket>();
    if (pub && t.user) {
      const info = await orgInfo(owner).catch(() => ({ name: "" }));
      await notifyWithSms(
        "crmTicketAnsweredUser",
        t.user,
        { ticketId: String(t.number), centre: info.name },
        { notification: { title: "پاسخ مرکز درمانی", message: `${info.name} به درخواست «${t.subject}» پاسخ داد.`, link: `/dashboard/centres/${t._id}` }, once: `crm:${t._id}` },
      );
    }
    ok(res, "crmReplyTicket", out ? ticketView(out) : null);
  }),
  // status, priority, category, assignee (the SLA keeps its first deadlines)
  updateTicket: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({ status: z.enum(bizTicketStatuses).optional(), priority: z.enum(bizTicketPriorities).optional(), category: z.enum(bizTicketCategories).optional(), assignee: optId })
      .safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const d = parsed.data;
    const t = await BizTicket.findOne({ ...own(owner), _id: param(req, "ticketId") }).lean<IBizTicket>();
    if (!t) throw new NotFoundError();
    await assertMember(owner, d.assignee);
    const resolved = d.status && (d.status === "resolved" || d.status === "closed");
    const out = await BizTicket.findOneAndUpdate(
      { _id: t._id },
      {
        $set: {
          ...(d.status ? { status: d.status } : {}),
          ...(d.priority ? { priority: d.priority } : {}),
          ...(d.category ? { category: d.category } : {}),
          ...(d.assignee ? { assignee: d.assignee } : {}),
          ...(resolved && !t.resolvedAt ? { resolvedAt: new Date() } : {}),
        },
        ...(d.assignee === null ? { $unset: { assignee: 1 } } : d.status && !resolved && t.resolvedAt ? { $unset: { resolvedAt: 1 } } : {}),
      },
      { new: true },
    ).lean<IBizTicket>();
    if (d.assignee && d.assignee !== String(t.assignee || "") && d.assignee !== me(req))
      await notify(d.assignee, "درخواست تازه به شما سپرده شد", `درخواست شماره‌ی ${t.number.toLocaleString("fa-IR")}: «${t.subject}»`, crmLink(owner, `tickets/${t._id}`));
    if (d.status === "resolved" && t.status !== "resolved" && t.contact) await fireFlows(owner, "ticket.resolved", { type: "ticket", id: String(t._id), contact: t.contact });
    ok(res, "crmUpdateTicket", out ? ticketView(out) : null);
  }),
  deleteTicket: withOwner(ownerOf, async (owner, req, res) => {
    const r = await BizTicket.deleteOne({ ...own(owner), _id: param(req, "ticketId") });
    if (!r.deletedCount) throw new NotFoundError();
    ok(res, "crmDeleteTicket");
  }),

  // ---------------------------------------------------------------- projects
  getProjects: withOwner(ownerOf, async (owner, req, res) => {
    const status = z.enum([...bizProjectStatuses, "all"]).default("active").safeParse(req.query.status || undefined);
    const rows = await BizProject.find({ ...own(owner), ...(status.success && status.data !== "all" ? { status: status.data } : {}) })
      .sort({ createdAt: -1 })
      .populate("contact", "name phone")
      .lean<IBizProject[]>();
    const counts = await BizTask.aggregate([
      { $match: { ...own(owner), project: { $in: rows.map((p) => p._id) }, parent: { $exists: false } } },
      { $group: { _id: "$project", total: { $sum: 1 }, done: { $sum: { $cond: ["$done", 1, 0] } } } },
    ]);
    const by = new Map(counts.map((c: { _id: unknown; total: number; done: number }) => [String(c._id), c]));
    ok(res, "crmProjects", rows.map((p) => ({ ...p, tasks: by.get(String(p._id))?.total || 0, done: by.get(String(p._id))?.done || 0 })));
  }),
  saveProject: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        name: z.string().trim().min(2).max(120),
        description: z.string().trim().max(2000).nullable().optional(),
        color,
        dueAt: date.nullable().optional(),
        contact: optId,
        status: z.enum(bizProjectStatuses).optional(),
        stages: z.array(z.object({ _id: id.optional(), name: z.string().trim().min(1).max(40), isClosed: z.boolean().default(false) })).min(1).max(10).optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام فهرست کار را بنویسید", 400);
    const d = parsed.data;
    await ownContact(owner, d.contact);
    const set: Record<string, unknown> = { name: d.name, ...(d.status ? { status: d.status } : {}) };
    const unset: Record<string, 1> = {};
    for (const k of ["description", "color", "dueAt", "contact"] as const) {
      if (d[k]) set[k] = d[k];
      else if (d[k] === null) unset[k] = 1;
    }
    const pid = req.params.projectId;
    if (pid) {
      if (!isId(pid)) throw new NotFoundError();
      const old = await BizProject.findOne({ ...own(owner), _id: pid }).lean<IBizProject>();
      if (!old) throw new NotFoundError();
      if (d.stages) {
        // a removed stage must be empty; a stage's closed flag rules its tasks' done
        const keep = new Set(d.stages.map((s) => s._id).filter(Boolean));
        const removed = old.stages.filter((s) => !keep.has(String(s._id)));
        if (removed.length && (await BizTask.exists({ project: old._id, stage: { $in: removed.map((s) => s._id) } })))
          throw new AppError("ستونی که کار دارد حذف نمی‌شود؛ اول کارهایش را جابه‌جا کنید", 400);
        set.stages = d.stages.map((s) => ({ ...(s._id ? { _id: s._id } : {}), name: s.name, isClosed: s.isClosed }));
      }
      const p = await BizProject.findOneAndUpdate({ _id: old._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true }).lean<IBizProject>();
      if (p && d.stages)
        for (const s of p.stages) await BizTask.updateMany({ project: p._id, stage: s._id, done: !s.isClosed }, { $set: { done: s.isClosed, ...(s.isClosed ? { doneAt: new Date() } : {}) } });
      return ok(res, "crmSaveProject", p);
    }
    const p = await BizProject.create({ ...own(owner), ...set, stages: d.stages || DEFAULT_STAGES, createdBy: req.user?._id });
    ok(res, "crmSaveProject", p, 201);
  }),
  // with its tasks and their hours
  deleteProject: withOwner(ownerOf, async (owner, req, res) => {
    const p = await BizProject.findOneAndDelete({ ...own(owner), _id: param(req, "projectId") }).lean<IBizProject>();
    if (!p) throw new NotFoundError();
    const tasks = await BizTask.find({ project: p._id }).select("_id").lean();
    await Promise.all([BizTimeLog.deleteMany({ task: { $in: tasks.map((t) => t._id) } }), BizTask.deleteMany({ project: p._id })]);
    ok(res, "crmDeleteProject");
  }),
  getProject: withOwner(ownerOf, async (owner, req, res) => {
    const p = await BizProject.findOne({ ...own(owner), _id: param(req, "projectId") }).populate("contact", "name phone").lean<IBizProject>();
    if (!p) throw new NotFoundError();
    const tasks = await BizTask.find({ project: p._id }).sort({ priority: -1, dueAt: 1, createdAt: 1 }).populate("contact", "name phone").lean<IBizTask[]>();
    const hours = await BizTimeLog.aggregate([{ $match: { task: { $in: tasks.map((t) => t._id) } } }, { $group: { _id: "$task", h: { $sum: "$hours" } } }]);
    const h = new Map(hours.map((x: { _id: unknown; h: number }) => [String(x._id), x.h]));
    ok(res, "crmProject", { project: p, tasks: tasks.map((t) => ({ ...t, hours: h.get(String(t._id)) || 0 })) });
  }),

  // ---------------------------------------------------------------- tasks
  // the viewer's open tasks across boards
  getMyTasks: withOwner(ownerOf, async (owner, req, res) => {
    const rows = await BizTask.find({ ...own(owner), assignee: oid(me(req)), done: false })
      .sort({ dueAt: 1, priority: -1 })
      .limit(300)
      .populate("project", "name color")
      .populate("contact", "name phone")
      .lean();
    ok(res, "crmMyTasks", rows);
  }),
  createTask: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(3000).nullable().optional(),
        stage: id,
        parent: optId,
        priority: z.coerce.number().int().min(0).max(3).default(1),
        dueAt: date.nullable().optional(),
        assignee: optId,
        contact: optId,
      })
      .safeParse(req.body || {});
    if (!parsed.success) throw new AppError("عنوان کار را بنویسید", 400);
    const d = parsed.data;
    const p = await BizProject.findOne({ ...own(owner), _id: param(req, "projectId") }).lean<IBizProject>();
    if (!p) throw new NotFoundError();
    const stage = p.stages.find((s) => String(s._id) === d.stage);
    if (!stage) throw new NotFoundError();
    await Promise.all([assertMember(owner, d.assignee), ownContact(owner, d.contact)]);
    // a sub-task's parent of another board quietly becomes none (nexxacrm)
    const parent = d.parent && (await BizTask.exists({ ...own(owner), _id: d.parent, project: p._id })) ? d.parent : undefined;
    const t = await BizTask.create({
      ...own(owner),
      project: p._id,
      stage: stage._id,
      title: d.title,
      ...(d.description ? { description: d.description } : {}),
      ...(parent ? { parent } : {}),
      priority: d.priority,
      ...(d.dueAt ? { dueAt: d.dueAt } : {}),
      ...(d.assignee ? { assignee: d.assignee } : {}),
      ...(d.contact ? { contact: d.contact } : {}),
      done: stage.isClosed,
      ...(stage.isClosed ? { doneAt: new Date() } : {}),
      createdBy: req.user?._id,
    });
    if (d.assignee && d.assignee !== me(req)) await notify(d.assignee, "کار تازه به شما سپرده شد", `«${t.title}»`, crmLink(owner, `tasks/${p._id}`));
    ok(res, "crmCreateTask", t, 201);
  }),
  // a move to a closed stage marks it done (and out of one, not done);
  // other edits leave done as it is
  updateTask: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(3000).nullable().optional(),
        stage: id.optional(),
        priority: z.coerce.number().int().min(0).max(3).optional(),
        dueAt: date.nullable().optional(),
        assignee: optId,
        contact: optId,
      })
      .safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const d = parsed.data;
    const t = await BizTask.findOne({ ...own(owner), _id: param(req, "taskId") }).lean<IBizTask>();
    if (!t) throw new NotFoundError();
    await Promise.all([assertMember(owner, d.assignee), ownContact(owner, d.contact)]);
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    if (d.title) set.title = d.title;
    if (d.priority !== undefined) set.priority = d.priority;
    for (const k of ["description", "dueAt", "assignee", "contact"] as const) {
      if (d[k]) set[k] = d[k];
      else if (d[k] === null) unset[k] = 1;
    }
    if (d.dueAt !== undefined) unset.remindedAt = 1;
    if (d.stage && d.stage !== String(t.stage)) {
      const p = await BizProject.findById(t.project).lean<IBizProject>();
      const s = p?.stages.find((x) => String(x._id) === d.stage);
      if (!s) throw new NotFoundError();
      set.stage = s._id;
      set.done = s.isClosed;
      if (s.isClosed) set.doneAt = new Date();
      else unset.doneAt = 1;
    }
    const out = await BizTask.findOneAndUpdate({ _id: t._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true }).lean();
    if (d.assignee && d.assignee !== String(t.assignee || "") && d.assignee !== me(req))
      await notify(d.assignee, "کار تازه به شما سپرده شد", `«${t.title}»`, crmLink(owner, `tasks/${t.project}`));
    ok(res, "crmUpdateTask", out);
  }),
  // ticking it done leaves its stage alone (nexxacrm toggleTaskDone)
  toggleTask: withOwner(ownerOf, async (owner, req, res) => {
    const t = await BizTask.findOne({ ...own(owner), _id: param(req, "taskId") }).select("done").lean<IBizTask>();
    if (!t) throw new NotFoundError();
    const out = await BizTask.findOneAndUpdate({ _id: t._id }, t.done ? { $set: { done: false }, $unset: { doneAt: 1 } } : { $set: { done: true, doneAt: new Date() } }, { new: true }).lean();
    ok(res, "crmToggleTask", out);
  }),
  // with its sub-tasks and the hours logged on them
  deleteTask: withOwner(ownerOf, async (owner, req, res) => {
    const t = await BizTask.findOne({ ...own(owner), _id: param(req, "taskId") }).select("_id").lean();
    if (!t) throw new NotFoundError();
    const ids = [t._id, ...(await BizTask.find({ parent: t._id }).select("_id").lean()).map((x) => x._id)];
    await Promise.all([BizTimeLog.deleteMany({ task: { $in: ids } }), BizTask.deleteMany({ _id: { $in: ids } })]);
    ok(res, "crmDeleteTask");
  }),

  // ---------------------------------------------------------------- time
  getTaskTime: withOwner(ownerOf, async (owner, req, res) => {
    const rows = await BizTimeLog.find({ ...own(owner), task: param(req, "taskId") }).sort({ date: -1 }).lean();
    ok(res, "crmTaskTime", rows);
  }),
  logTime: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({ hours: z.coerce.number().min(0.05).max(24), date: date.optional(), note: z.string().trim().max(300).nullable().optional(), billable: z.boolean().default(false) })
      .safeParse(req.body || {});
    if (!parsed.success) throw new AppError("ساعت را درست بنویسید", 400);
    const t = await BizTask.findOne({ ...own(owner), _id: param(req, "taskId") }).select("_id").lean();
    if (!t) throw new NotFoundError();
    const log = await BizTimeLog.create({
      ...own(owner),
      task: t._id,
      user: req.user?._id,
      hours: Math.round(parsed.data.hours * 100) / 100,
      date: parsed.data.date || new Date(),
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
      billable: parsed.data.billable,
    });
    ok(res, "crmLogTime", log, 201);
  }),
  // only whoever logged it, or the owner
  updateTime: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({ hours: z.coerce.number().min(0.05).max(24).optional(), date: date.optional(), note: z.string().trim().max(300).nullable().optional(), billable: z.boolean().optional() })
      .safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const l = await BizTimeLog.findOne({ ...own(owner), _id: param(req, "logId") }).lean<IBizTimeLog>();
    if (!l) throw new NotFoundError();
    if (String(l.user) !== me(req) && !(await isOwnerUser(owner, me(req)))) throw new AppError("فقط ثبت‌کننده این ساعت را تغییر می‌دهد", 403);
    const d = parsed.data;
    const out = await BizTimeLog.findOneAndUpdate(
      { _id: l._id },
      {
        $set: { ...(d.hours ? { hours: Math.round(d.hours * 100) / 100 } : {}), ...(d.date ? { date: d.date } : {}), ...(d.note ? { note: d.note } : {}), ...(d.billable !== undefined ? { billable: d.billable } : {}) },
        ...(d.note === null ? { $unset: { note: 1 } } : {}),
      },
      { new: true },
    ).lean();
    ok(res, "crmUpdateTime", out);
  }),
  deleteTime: withOwner(ownerOf, async (owner, req, res) => {
    const l = await BizTimeLog.findOne({ ...own(owner), _id: param(req, "logId") }).lean<IBizTimeLog>();
    if (!l) throw new NotFoundError();
    if (String(l.user) !== me(req) && !(await isOwnerUser(owner, me(req)))) throw new AppError("فقط ثبت‌کننده این ساعت را حذف می‌کند", 403);
    await BizTimeLog.deleteOne({ _id: l._id });
    ok(res, "crmDeleteTime");
  }),
  // hours per person and day in a range (default this week)
  getTimesheet: withOwner(ownerOf, async (owner, req, res) => {
    const q = z.object({ from: date.optional(), to: date.optional(), user: id.optional() }).safeParse(req.query);
    if (!q.success) throw new BadInputError();
    const to = q.data.to || new Date();
    const from = q.data.from || new Date(+to - 7 * DAY);
    const rows = await BizTimeLog.find({ ...own(owner), date: { $gte: from, $lte: to }, ...(q.data.user ? { user: oid(q.data.user) } : {}) })
      .sort({ date: -1 })
      .limit(2000)
      .populate({ path: "task", select: "title project", populate: { path: "project", select: "name" } })
      .lean();
    ok(res, "crmTimesheet", { from, to, rows, team: await team(owner) });
  }),

  // ---------------------------------------------------------------- calendar
  // events, open follow-ups and tasks due in [from, to]
  getCalendar: withOwner(ownerOf, async (owner, req, res) => {
    const q = z.object({ from: date, to: date }).safeParse(req.query);
    if (!q.success) throw new BadInputError();
    const { from, to } = q.data;
    if (+to - +from > 62 * DAY) throw new BadInputError();
    const [events, followUps, tasks] = await Promise.all([
      BizCalendarEvent.find({ ...own(owner), start: { $gte: from, $lte: to } }).sort({ start: 1 }).populate("contact", "name phone").lean(),
      BizActivity.find({ ...own(owner), kind: "followUp", dueAt: { $gte: from, $lte: to } }).select("text dueAt doneAt assignee contact").populate("contact", "name phone").lean(),
      BizTask.find({ ...own(owner), dueAt: { $gte: from, $lte: to } }).select("title dueAt done assignee project contact").populate("contact", "name phone").lean(),
    ]);
    ok(res, "crmCalendar", { events, followUps, tasks });
  }),
  saveEvent: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(160),
        kind: z.enum(bizEventKinds).default("meeting"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
        minutes: z.coerce.number().int().min(5).max(24 * 60).default(60),
        contact: optId,
        note: z.string().trim().max(1000).nullable().optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) throw new AppError("عنوان و تاریخ رویداد را بنویسید", 400);
    const d = parsed.data;
    await ownContact(owner, d.contact);
    // no time: all day (nexxacrm createEvent), times in Tehran
    const allDay = !d.time;
    const start = tehran(d.date, d.time);
    const set = { title: d.title, kind: d.kind, start, allDay, ...(allDay ? {} : { end: new Date(+start + d.minutes * 60_000) }), ...(d.note ? { note: d.note } : {}), ...(d.contact ? { contact: d.contact } : {}) };
    const unset = { ...(allDay ? { end: 1 } : {}), ...(d.note ? {} : { note: 1 }), ...(d.contact ? {} : { contact: 1 }) };
    const eid = req.params.eventId;
    if (eid) {
      if (!isId(eid)) throw new NotFoundError();
      const e = await BizCalendarEvent.findOneAndUpdate({ ...own(owner), _id: eid }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true }).lean();
      if (!e) throw new NotFoundError();
      return ok(res, "crmSaveEvent", e);
    }
    ok(res, "crmSaveEvent", await BizCalendarEvent.create({ ...own(owner), ...set, user: req.user?._id }), 201);
  }),
  toggleEvent: withOwner(ownerOf, async (owner, req, res) => {
    const e = await BizCalendarEvent.findOne({ ...own(owner), _id: param(req, "eventId") }).select("done").lean<IBizCalendarEvent>();
    if (!e) throw new NotFoundError();
    ok(res, "crmToggleEvent", await BizCalendarEvent.findOneAndUpdate({ _id: e._id }, { $set: { done: !e.done } }, { new: true }).lean());
  }),
  deleteEvent: withOwner(ownerOf, async (owner, req, res) => {
    await BizCalendarEvent.deleteOne({ ...own(owner), _id: param(req, "eventId") });
    ok(res, "crmDeleteEvent");
  }),

  // ---------------------------------------------------------------- checklists
  getChecklists: withOwner(ownerOf, async (owner, _req, res) => {
    const [lists, items] = await Promise.all([
      BizChecklist.find(own(owner)).sort({ isTemplate: 1, sequence: 1, createdAt: 1 }).populate("contact", "name phone").lean<IBizChecklist[]>(),
      BizChecklistItem.find(own(owner)).sort({ sequence: 1, createdAt: 1 }).limit(5000).lean<IBizChecklistItem[]>(),
    ]);
    ok(res, "crmChecklists", { lists, items });
  }),
  saveList: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(120), color, isTemplate: z.boolean().optional() }).safeParse(req.body || {});
    if (!parsed.success) throw new AppError("نام چک‌لیست را بنویسید", 400);
    const d = parsed.data;
    const lid = req.params.listId;
    if (lid) {
      if (!isId(lid)) throw new NotFoundError();
      const l = await BizChecklist.findOneAndUpdate(
        { ...own(owner), _id: lid },
        { $set: { name: d.name, ...(d.color ? { color: d.color } : {}), ...(d.isTemplate !== undefined ? { isTemplate: d.isTemplate } : {}) }, ...(d.color === null ? { $unset: { color: 1 } } : {}) },
        { new: true },
      ).lean();
      if (!l) throw new NotFoundError();
      return ok(res, "crmSaveList", l);
    }
    const sequence = await BizChecklist.countDocuments(own(owner));
    ok(res, "crmSaveList", await BizChecklist.create({ ...own(owner), name: d.name, ...(d.color ? { color: d.color } : {}), isTemplate: !!d.isTemplate, sequence, createdBy: req.user?._id }), 201);
  }),
  // its items stay, as loose items (nexxacrm deleteList)
  deleteList: withOwner(ownerOf, async (owner, req, res) => {
    const lid = param(req, "listId");
    const l = await BizChecklist.findOneAndDelete({ ...own(owner), _id: lid }).lean();
    if (!l) throw new NotFoundError();
    await BizChecklistItem.updateMany({ ...own(owner), list: lid }, { $unset: { list: 1 } });
    ok(res, "crmDeleteList");
  }),
  // a template started for one patient: a new list with its items, none done
  startList: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z.object({ contact: id }).safeParse(req.body || {});
    if (!parsed.success) throw new AppError("بیمار را انتخاب کنید", 400);
    const t = await BizChecklist.findOne({ ...own(owner), _id: param(req, "listId"), isTemplate: true }).lean<IBizChecklist>();
    if (!t) throw new NotFoundError();
    const c = await ownContact(owner, parsed.data.contact);
    const list = await BizChecklist.create({
      ...own(owner),
      name: `${t.name} · ${c?.name || c?.phone || ""}`.slice(0, 120),
      ...(t.color ? { color: t.color } : {}),
      isTemplate: false,
      contact: c!._id,
      template: t._id,
      sequence: await BizChecklist.countDocuments(own(owner)),
      createdBy: req.user?._id,
    });
    const items = await BizChecklistItem.find({ ...own(owner), list: t._id }).sort({ sequence: 1 }).lean<IBizChecklistItem[]>();
    const map = new Map<string, unknown>();
    // parents first, so a sub-item finds its new parent
    for (const it of [...items.filter((i) => !i.parent), ...items.filter((i) => i.parent)]) {
      const doc = await BizChecklistItem.create({
        ...own(owner),
        list: list._id,
        ...(it.parent && map.get(String(it.parent)) ? { parent: map.get(String(it.parent)) } : {}),
        title: it.title,
        ...(it.note ? { note: it.note } : {}),
        priority: it.priority,
        repeat: "none",
        sequence: it.sequence,
        createdBy: req.user?._id,
      });
      map.set(String(it._id), doc._id);
    }
    ok(res, "crmStartList", list, 201);
  }),
  createItem: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(300),
        list: optId,
        parent: optId,
        priority: z.coerce.number().int().min(0).max(3).default(0),
        dueAt: date.nullable().optional(),
        repeat: z.enum(bizRepeats).default("none"),
        note: z.string().trim().max(1000).nullable().optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) throw new AppError("عنوان کار را بنویسید", 400);
    const d = parsed.data;
    // a list or a parent that isn't the owner's quietly becomes none (nexxacrm)
    const list = d.list && (await BizChecklist.exists({ ...own(owner), _id: d.list })) ? d.list : undefined;
    const parent = d.parent && (await BizChecklistItem.exists({ ...own(owner), _id: d.parent })) ? d.parent : undefined;
    const sequence = await BizChecklistItem.countDocuments({ ...own(owner), list: list ? oid(list) : { $exists: false }, parent: parent ? oid(parent) : { $exists: false } });
    const it = await BizChecklistItem.create({
      ...own(owner),
      title: d.title,
      ...(list ? { list } : {}),
      ...(parent ? { parent } : {}),
      priority: d.priority,
      ...(d.dueAt ? { dueAt: d.dueAt } : {}),
      repeat: d.repeat,
      ...(d.note ? { note: d.note } : {}),
      sequence,
      createdBy: req.user?._id,
    });
    ok(res, "crmCreateItem", it, 201);
  }),
  updateItem: withOwner(ownerOf, async (owner, req, res) => {
    const parsed = z
      .object({
        title: z.string().trim().max(300).optional(),
        list: optId,
        priority: z.coerce.number().int().min(0).max(3).optional(),
        dueAt: date.nullable().optional(),
        repeat: z.enum(bizRepeats).optional(),
        note: z.string().trim().max(1000).nullable().optional(),
        starred: z.boolean().optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) throw new BadInputError();
    const d = parsed.data;
    const it = await BizChecklistItem.findOne({ ...own(owner), _id: param(req, "itemId") }).lean<IBizChecklistItem>();
    if (!it) throw new NotFoundError();
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    // an empty title is ignored (nexxacrm updateItem)
    if (d.title) set.title = d.title;
    if (d.priority !== undefined) set.priority = d.priority;
    if (d.repeat) set.repeat = d.repeat;
    if (d.starred !== undefined) set.starred = d.starred;
    if (d.dueAt) set.dueAt = d.dueAt;
    else if (d.dueAt === null) unset.dueAt = 1;
    if (d.note) set.note = d.note;
    else if (d.note === null) unset.note = 1;
    if (d.list) {
      if (await BizChecklist.exists({ ...own(owner), _id: d.list })) set.list = d.list;
      else unset.list = 1;
    } else if (d.list === null) unset.list = 1;
    const out = await BizChecklistItem.findOneAndUpdate({ _id: it._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true }).lean();
    ok(res, "crmUpdateItem", out);
  }),
  // done: a repeating top-level item with a due date makes its next one
  toggleItem: withOwner(ownerOf, async (owner, req, res) => {
    const it = await BizChecklistItem.findOne({ ...own(owner), _id: param(req, "itemId") }).lean<IBizChecklistItem>();
    if (!it) throw new NotFoundError();
    const done = !it.done;
    const claimed = await BizChecklistItem.findOneAndUpdate(
      { _id: it._id, done: it.done },
      done ? { $set: { done: true, doneAt: new Date(), doneBy: req.user?._id } } : { $set: { done: false }, $unset: { doneAt: 1, doneBy: 1 } },
      { new: true },
    ).lean();
    if (!claimed) return ok(res, "crmToggleItem", it);
    let next = null;
    if (done && it.repeat !== "none" && it.dueAt && !it.parent) {
      const due = advanceDue(it.dueAt, it.repeat);
      if (due)
        next = await BizChecklistItem.create({
          ...own(owner),
          ...(it.list ? { list: it.list } : {}),
          title: it.title,
          ...(it.note ? { note: it.note } : {}),
          priority: it.priority,
          repeat: it.repeat,
          dueAt: due,
          starred: it.starred,
          sequence: it.sequence,
          createdBy: it.createdBy,
        });
    }
    ok(res, "crmToggleItem", { item: claimed, next });
  }),
  // with its sub-items
  deleteItem: withOwner(ownerOf, async (owner, req, res) => {
    const iid = param(req, "itemId");
    const r = await BizChecklistItem.deleteOne({ ...own(owner), _id: iid });
    if (!r.deletedCount) throw new NotFoundError();
    await BizChecklistItem.deleteMany({ ...own(owner), parent: iid });
    ok(res, "crmDeleteItem");
  }),
});
