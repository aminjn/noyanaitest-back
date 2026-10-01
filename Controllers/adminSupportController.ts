import { NextFunction, Request, RequestHandler, Response } from "express";
import mongoose, { isValidObjectId, Model } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  MiddlewareError,
  NotFoundError,
} from "../Lib/AppError";
import User from "../Models/User";
import Ticket, {
  ticketPriorities,
  ticketSlaHours,
  ticketStatuses,
  ticketSubjects,
  TicketPriority,
  TicketStatus,
  TicketSubject,
} from "../Models/Ticket";
import TicketMessage from "../Models/TicketMessage";
import ContactRequest, {
  contactRequestStatuses,
  ContactRequestSubject,
} from "../Models/ContactRequest";
import Comment from "../Models/Comment";
import DoctorFeedBack from "../Models/DoctorFeedback";
import Reservation from "../Models/Reservation";
import Order from "../Models/Order";
import SmsLog, { smsLogStatuses } from "../Models/SmsLog";

// Support desk for the super admin panel (2026-10 audit P1-5, P2-14, P2-15,
// P3-17). Benchmarked on Doctolib Pro / Docplanner back office and
// Zendesk-style desks: one queue with assignee, priority and a first-response
// target; staff-only notes; tickets opened for a patient who called in.
// Every write here is recorded by auditAdminActions (mounted on /admin).

const MAX_LIMIT = 100;
const BULK_LIMIT = 200;

const objectId = z.string().refine((v) => isValidObjectId(v), "invalid id");

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toAsciiDigits = (text: string) =>
  text
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

// Any typed phone ("0912…", "+98 912…", Persian digits) -> stored 98XXXXXXXXXX
const normalizePhone = (raw: string): string | undefined => {
  const digits = toAsciiDigits(raw || "").replace(/\D/g, "");
  const local = digits.replace(/^(0098|98|0)/, "");
  return /^9\d{9}$/.test(local) ? `98${local}` : undefined;
};

const userSelect = "phone username role status";

const isStaff = (user?: { role?: string; status?: string } | null) =>
  !!user && (user.role === "admin" || user.role === "notadmin") && user.status !== "deleted";

// ---------------------------------------------------------------- tickets

const listTicketsSchema = z.object({
  status: z.string().trim().optional(), // one status or a comma list
  priority: z.enum(ticketPriorities).optional(),
  assignee: z.union([z.enum(["me", "none"]), objectId]).optional(),
  user: objectId.optional(),
  q: z.string().trim().max(100).optional(),
  overdue: z.enum(["1", "true"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
});

type LastMessage = { _id: unknown; isAdmin: boolean; at: Date; count: number; firstAdminAt?: Date };

// Who the ticket waits on, since when, and whether support is past its
// first-response target for the ticket's priority.
const ticketTiming = (
  ticket: { status: TicketStatus; priority?: TicketPriority; submittedAt: Date },
  last?: LastMessage,
) => {
  const open = ticket.status === "Open" || ticket.status === "InProgress";
  const waitingOn: "support" | "user" | null = !open
    ? null
    : !last || !last.isAdmin
      ? "support"
      : "user";
  const waitingSince = last?.at || ticket.submittedAt;
  const priority = ticket.priority || "normal";
  const slaDueAt =
    waitingOn === "support"
      ? new Date(new Date(waitingSince).getTime() + ticketSlaHours[priority] * 3600_000)
      : null;
  return {
    waitingOn,
    waitingSince,
    slaDueAt,
    overdue: !!slaDueAt && slaDueAt.getTime() < Date.now(),
    ageHours: Math.max(0, Math.round((Date.now() - new Date(ticket.submittedAt).getTime()) / 3600_000)),
  };
};

const lastMessagesOf = async (ids: mongoose.Types.ObjectId[]) => {
  if (!ids.length) return new Map<string, LastMessage>();
  const rows = await TicketMessage.aggregate<LastMessage>([
    { $match: { ticket: { $in: ids } } },
    { $sort: { submittedAt: -1 } },
    {
      $group: {
        _id: "$ticket",
        isAdmin: { $first: "$isAdmin" },
        at: { $first: "$submittedAt" },
        count: { $sum: 1 },
        firstAdminAt: {
          $min: { $cond: [{ $eq: ["$isAdmin", true] }, "$submittedAt", null] },
        },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
};

// GET /admin/support/tickets
export const listTickets: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const parsed = listTicketsSchema.safeParse(req.query);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const { status, priority, assignee, user, q, overdue, page, limit } = parsed.data;

    const filter: Record<string, unknown> = {};
    if (status) {
      const list = status
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is TicketStatus => (ticketStatuses as readonly string[]).includes(s));
      if (list.length) filter.status = { $in: list };
    }
    if (priority)
      filter.priority = priority === "normal" ? { $in: ["normal", null] } : priority;
    if (assignee === "me") filter.assignee = req.user._id;
    else if (assignee === "none") filter.assignee = { $in: [null] };
    else if (assignee) filter.assignee = assignee;
    if (user) filter.submittedBy = user;
    if (q) {
      const text = toAsciiDigits(q);
      const or: Record<string, unknown>[] = [{ title: new RegExp(escapeRegex(text), "i") }];
      const digits = text.replace(/\D/g, "");
      if (digits.length >= 3) {
        const users = await User.find({
          phone: new RegExp(escapeRegex(digits.replace(/^(98|0)/, ""))),
        })
          .select("_id")
          .limit(500)
          .lean();
        if (users.length) or.push({ submittedBy: { $in: users.map((u) => u._id) } });
      }
      filter.$or = or;
    }

    // "overdue" needs the last message of every open ticket, so it is
    // resolved before paging (open tickets are a small set)
    if (overdue) {
      const open = await Ticket.find({ ...filter, status: { $in: ["Open", "InProgress"] } })
        .select("_id status priority submittedAt")
        .lean();
      const last = await lastMessagesOf(open.map((t) => t._id as mongoose.Types.ObjectId));
      const ids = open
        .filter((t) => ticketTiming(t as never, last.get(String(t._id))).overdue)
        .map((t) => t._id);
      filter._id = { $in: ids };
    }

    const [tickets, total, statusCounts, mine, unassigned] = await Promise.all([
      Ticket.find(filter)
        .sort({ submittedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate({ path: "submittedBy", select: userSelect })
        .populate({ path: "assignee", select: userSelect })
        .lean(),
      Ticket.countDocuments(filter),
      Ticket.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Ticket.countDocuments({ assignee: req.user._id, status: { $in: ["Open", "InProgress"] } }),
      Ticket.countDocuments({
        assignee: { $in: [null] },
        status: { $in: ["Open", "InProgress"] },
      }),
    ]);
    const last = await lastMessagesOf(tickets.map((t) => t._id as mongoose.Types.ObjectId));

    res.status(200).json({
      message: "listTickets",
      data: {
        data: {
          items: tickets.map((t) => {
            const l = last.get(String(t._id));
            return {
              ...t,
              priority: t.priority || "normal",
              messageCount: l?.count || 0,
              lastMessageAt: l?.at,
              firstResponseAt: l?.firstAdminAt || null,
              ...ticketTiming(t as never, l),
            };
          }),
          total,
          page,
          limit,
          statusCounts: Object.fromEntries(statusCounts.map((r: any) => [r._id, r.count])),
          mineOpen: mine,
          unassignedOpen: unassigned,
          slaHours: ticketSlaHours,
        },
      },
    });
  },
);

// GET /admin/support/tickets/:nodeId - with internal notes and the user's
// context (their other tickets, reservation and order counts)
export const getTicket: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const ticket = await Ticket.findById(nodeId)
      .select("+internalNotes")
      .populate({ path: "submittedBy", select: userSelect })
      .populate({ path: "assignee", select: userSelect })
      .populate({ path: "openedBy", select: userSelect })
      .populate({ path: "internalNotes.author", select: userSelect })
      .populate({ path: "messages", options: { sort: { submittedAt: 1 } } })
      .lean<any>();
    if (!ticket) return next(new NotFoundError());
    const userId = ticket.submittedBy?._id;
    const [otherTickets, reservations, orders] = userId
      ? await Promise.all([
          Ticket.find({ submittedBy: userId, _id: { $ne: ticket._id } })
            .sort({ submittedAt: -1 })
            .limit(5)
            .select("title status priority submittedAt")
            .lean(),
          Reservation.countDocuments({ user: userId }),
          Order.countDocuments({ user: userId }),
        ])
      : [[], 0, 0];
    const messages = Array.isArray(ticket.messages) ? ticket.messages : [];
    const lastMsg = messages[messages.length - 1];
    const firstAdmin = messages.find((m: any) => m.isAdmin);
    res.status(200).json({
      message: "getTicket",
      data: {
        data: {
          ...ticket,
          priority: ticket.priority || "normal",
          internalNotes: Array.isArray(ticket.internalNotes) ? ticket.internalNotes : [],
          firstResponseAt: firstAdmin?.submittedAt || null,
          ...ticketTiming(
            ticket,
            lastMsg
              ? { _id: ticket._id, isAdmin: !!lastMsg.isAdmin, at: lastMsg.submittedAt, count: messages.length }
              : undefined,
          ),
          context: { otherTickets, reservations, orders },
        },
      },
    });
  },
);

const updateTicketSchema = z.strictObject({
  assignee: z.union([objectId, z.null(), z.literal("")]).optional(),
  priority: z.enum(ticketPriorities).optional(),
  status: z.enum(ticketStatuses).optional(),
});

// PATCH /admin/support/tickets/:nodeId - assign, reprioritise, change status
export const updateTicket: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = updateTicketSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const input = parsed.data;
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ""> = {};
    if (input.assignee) {
      const staff = await User.findById(input.assignee).select("role status").lean();
      if (!isStaff(staff))
        return next(new AppError("تیکت را فقط می‌توان به یکی از کارکنان سپرد", 400));
      $set.assignee = input.assignee;
    } else if (input.assignee === null || input.assignee === "") $unset.assignee = "";
    if (input.priority) $set.priority = input.priority;
    if (input.status) $set.status = input.status;
    if (!Object.keys($set).length && !Object.keys($unset).length)
      return next(new BadInputError());
    // findOneAndUpdate: the Ticket hooks tell the user when it is resolved
    const data = await Ticket.findOneAndUpdate(
      { _id: nodeId },
      { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) },
      { new: true },
    );
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "updateTicket", data });
  },
);

const noteSchema = z.strictObject({ content: z.string().trim().min(1).max(5000) });

// POST /admin/support/tickets/:nodeId/notes - staff-only note
export const addTicketNote: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = noteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const result = await Ticket.updateOne(
      { _id: nodeId },
      {
        $push: {
          internalNotes: { content: parsed.data.content, author: req.user._id, at: new Date() },
        },
      },
    );
    if (!result.matchedCount) return next(new NotFoundError());
    res.status(200).json({ message: "addTicketNote" });
  },
);

const openTicketSchema = z.strictObject({
  user: objectId,
  title: z.string().trim().min(1).max(200),
  subject: z.enum(ticketSubjects),
  content: z.string().trim().min(1).max(5000),
  priority: z.enum(ticketPriorities).optional(),
  assignToMe: z.boolean().optional(),
});

// Opens a ticket for an existing account, as support's first message.
const openTicketFor = async (args: {
  user: mongoose.Types.ObjectId | string;
  title: string;
  subject: TicketSubject;
  content: string;
  priority?: TicketPriority;
  openedBy: mongoose.Types.ObjectId;
  assignee?: mongoose.Types.ObjectId;
  // the first message is the user's own words (a converted contact form)
  fromUser?: boolean;
}) => {
  const ticket = await Ticket.create({
    title: args.title,
    subject: args.subject,
    submittedBy: args.user,
    priority: args.priority || "normal",
    openedBy: args.openedBy,
    ...(args.assignee ? { assignee: args.assignee } : {}),
  });
  // an admin first message notifies the user (TicketMessage post-save hook)
  await TicketMessage.create({
    ticket: ticket._id,
    content: args.content,
    isAdmin: !args.fromUser,
  });
  return ticket;
};

// POST /admin/support/tickets - "open a ticket for this user" (a patient who
// phoned in, or a follow-up support starts)
export const openTicket: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const parsed = openTicketSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const input = parsed.data;
    const user = await User.findById(input.user).select("status").lean<{ status?: string }>();
    if (!user) return next(new NotFoundError());
    if (user.status === "deleted")
      return next(new AppError("برای حساب حذف‌شده نمی‌توان تیکت باز کرد", 400));
    const data = await openTicketFor({
      user: input.user,
      title: input.title,
      subject: input.subject,
      content: input.content,
      priority: input.priority,
      openedBy: req.user._id,
      assignee: input.assignToMe ? req.user._id : undefined,
    });
    res.status(201).json({ message: "openTicket", data });
  },
);

// GET /admin/support/staff - the assignee picker
export const listStaff: RequestHandler = catchAsync(
  async (_req: Request, res: Response) => {
    const data = await User.find({
      role: { $in: ["admin", "notadmin"] },
      status: { $ne: "deleted" },
    })
      .select("phone username role")
      .populate({ path: "identity", select: "givenName lastName" })
      .limit(500)
      .lean<any[]>();
    res.status(200).json({
      message: "listStaff",
      data: {
        data: data.map((u) => ({
          _id: u._id,
          phone: u.phone,
          username: u.username,
          role: u.role,
          name: u.identity ? `${u.identity.givenName} ${u.identity.lastName}` : undefined,
        })),
      },
    });
  },
);

// ------------------------------------------------------- contact requests

const contactUpdateSchema = z
  .strictObject({
    internalNote: z.string().trim().max(5000).optional(),
    status: z.enum(contactRequestStatuses).optional(),
  })
  .refine((v) => v.internalNote !== undefined || v.status !== undefined);

// POST /admin/support/contact/:nodeId - note / status; records who handled it
export const updateContactRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = contactUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const data = await ContactRequest.findByIdAndUpdate(
      nodeId,
      { $set: { ...parsed.data, handledBy: req.user._id, handledAt: new Date() } },
      { new: true },
    );
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "updateContactRequest", data });
  },
);

const contactSubjectToTicket: Record<ContactRequestSubject, TicketSubject> = {
  support: "GeneralInquiry",
  profile: "AccountIssue",
  users: "AccountIssue",
  bug: "BugReport",
};

const convertSchema = z.strictObject({
  internalNote: z.string().trim().max(5000).optional(),
  priority: z.enum(ticketPriorities).optional(),
});

// POST /admin/support/contact/:nodeId/convert - turns a contact-form message
// into a ticket of the account with the same phone. With no such account the
// note is still saved and the request stays here (support calls back).
export const convertContactRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = convertSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const request = await ContactRequest.findById(nodeId);
    if (!request) return next(new NotFoundError());
    if (request.ticket)
      return next(new AppError("این پیام قبلاً به تیکت تبدیل شده است", 400));

    const note = parsed.data.internalNote;
    const phone = normalizePhone(request.phone);
    const user = phone
      ? await User.findOne({ phone, status: { $ne: "deleted" } }).select("_id").lean()
      : null;
    if (!user) {
      if (note !== undefined)
        await ContactRequest.updateOne(
          { _id: request._id },
          { $set: { internalNote: note, handledBy: req.user._id, handledAt: new Date() } },
        );
      return next(
        new AppError("حسابی با شماره‌ی این پیام وجود ندارد؛ یادداشت ذخیره شد", 400),
      );
    }

    // claim the request first so a double click cannot open two tickets
    const claimed = await ContactRequest.findOneAndUpdate(
      { _id: request._id, ticket: { $in: [null] } },
      { $set: { ticket: new mongoose.Types.ObjectId() } },
    );
    if (!claimed) return next(new AppError("این پیام قبلاً به تیکت تبدیل شده است", 400));
    try {
      const ticket = await openTicketFor({
        user: user._id as mongoose.Types.ObjectId,
        title: `${request.name || ""}`.trim().slice(0, 200) || request.phone,
        subject: contactSubjectToTicket[request.subject] || "GeneralInquiry",
        content: request.content,
        priority: parsed.data.priority,
        openedBy: req.user._id,
        assignee: req.user._id,
        fromUser: true,
      });
      await ContactRequest.updateOne(
        { _id: request._id },
        {
          $set: {
            ticket: ticket._id,
            status: "done",
            handledBy: req.user._id,
            handledAt: new Date(),
            ...(note !== undefined ? { internalNote: note } : {}),
          },
        },
      );
      res.status(201).json({ message: "convertContactRequest", data: ticket });
    } catch (err) {
      await ContactRequest.updateOne({ _id: request._id }, { $unset: { ticket: "" } });
      throw err;
    }
  },
);

// ------------------------------------------------------------ moderation

const moderateSchema = z
  .strictObject({
    ids: z.array(objectId).min(1).max(BULK_LIMIT),
    status: z.enum(["Pending", "Approved", "Rejected"]),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.status !== "Rejected" || !!v.reason, {
    message: "reason",
    path: ["reason"],
  });

// One update per record (not updateMany): the models' findOneAnd* hooks
// recompute the doctor's / resource's score after every decision.
const moderate =
  (model: Model<any>, name: string): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const parsed = moderateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const needsReason = parsed.error.issues.some((i) => i.path[0] === "reason");
      return next(
        needsReason
          ? new AppError("برای رد کردن، دلیل آن را بنویسید", 400)
          : new BadInputError(parsed.error.message),
      );
    }
    const { ids, status, reason } = parsed.data;
    const update =
      status === "Rejected"
        ? { $set: { status, rejectReason: reason, moderatedBy: req.user._id, moderatedAt: new Date() } }
        : {
            $set: { status, moderatedBy: req.user._id, moderatedAt: new Date() },
            $unset: { rejectReason: "" },
          };
    let updated = 0;
    for (const id of Array.from(new Set(ids))) {
      const doc = await model.findOneAndUpdate({ _id: id }, update);
      if (doc) updated += 1;
    }
    res.status(200).json({
      message: `moderate${name}`,
      data: { data: { updated, missing: ids.length - updated } },
    });
  });

// POST /admin/support/comments/moderate
export const moderateComments = moderate(Comment, "Comments");
// POST /admin/support/doctorfeedback/moderate
export const moderateDoctorFeedback = moderate(DoctorFeedBack, "DoctorFeedback");

// --------------------------------------------------------------- SMS log

const smsLogQuerySchema = z.object({
  status: z.enum(smsLogStatuses).optional(),
  pattern: z.string().trim().max(80).optional(),
  otp: z.enum(["1", "true"]).optional(),
  q: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
});

// GET /admin/support/sms-log - what was sent to whom, and why it failed
// (rows expire after 90 days, Models/SmsLog.ts)
export const listSmsLog: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = smsLogQuerySchema.safeParse(req.query);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const { status, pattern, otp, q, page, limit } = parsed.data;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (otp) filter.pattern = "OTP_PATTERN";
    else if (pattern) filter.pattern = pattern;
    if (q) {
      const digits = toAsciiDigits(q).replace(/\D/g, "").replace(/^(98|0)/, "");
      if (digits) filter.to = new RegExp(escapeRegex(digits));
    }
    const since = new Date(Date.now() - 24 * 3600_000);
    const [items, total, last24h, patterns] = await Promise.all([
      SmsLog.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SmsLog.countDocuments(filter),
      SmsLog.aggregate([
        { $match: { at: { $gte: since } } },
        {
          $group: {
            _id: { otp: { $eq: ["$pattern", "OTP_PATTERN"] }, status: "$status" },
            count: { $sum: 1 },
          },
        },
      ]),
      SmsLog.distinct("pattern"),
    ]);
    const summary = { sent: 0, failed: 0, skipped: 0, otpSent: 0, otpFailed: 0 };
    for (const row of last24h as { _id: { otp: boolean; status: string }; count: number }[]) {
      const s = row._id.status as "sent" | "failed" | "skipped";
      if (s in summary) summary[s] += row.count;
      if (row._id.otp && s === "sent") summary.otpSent += row.count;
      if (row._id.otp && s === "failed") summary.otpFailed += row.count;
    }
    res.status(200).json({
      message: "listSmsLog",
      data: { data: { items, total, page, limit, last24h: summary, patterns } },
    });
  },
);
