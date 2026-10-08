import WithdrawalRequest from "../Models/WithdrawalRequest";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { Model, Types } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import User from "../Models/User";
import DoctorProfile from "../Models/DoctorProfile";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import Pharmacy from "../Models/Pharmacy";
import ParaClinic from "../Models/Paraclinic";
import Insurance from "../Models/Insurance";
import Ticket from "../Models/Ticket";
import Comment from "../Models/Comment";
import Blog, { blogAwaitingReviewFilter } from "../Models/Blog";
import DoctorFeedBack from "../Models/DoctorFeedback";
import ContactRequest from "../Models/ContactRequest";
import GatewayPayment from "../Models/GatewayPayment";
import Order from "../Models/Order";
import Reservation from "../Models/Reservation";
import Transaction from "../Models/Transaction";
import UserAccessLevel from "../Models/UserAccessLevel";
import { AccessLevelModel } from "../Models/AccessLevel";
import {
  providerRequestKinds,
  requestGroups,
} from "./adminRequestsController";

const TIMEZONE = "Asia/Tehran";
const SERIES_DAYS = 30;
const RECENT_USERS = 8;

// "YYYY-MM-DD" in Tehran time for each of the last `days` days, oldest first.
const lastDays = (days: number) => {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const result: string[] = [];
  for (let i = days - 1; i >= 0; i--)
    result.push(fmt.format(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
  return result;
};

const dailyCounts = async (
  model: Model<any>,
  dateExpr: unknown,
  sinceMatch: Record<string, unknown>,
  days: string[],
) => {
  const rows: { _id: string; count: number }[] = await model.aggregate([
    { $match: sinceMatch },
    {
      $group: {
        _id: {
          $dateToString: { format: "%Y-%m-%d", date: dateExpr, timezone: TIMEZONE },
        },
        count: { $sum: 1 },
      },
    },
  ]);
  const byDay = new Map(rows.map((row) => [row._id, row.count]));
  return days.map((date) => ({ date, count: byDay.get(date) || 0 }));
};

export const getDashboard: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const days = lastDays(SERIES_DAYS);
    const since = new Date(Date.now() - SERIES_DAYS * 24 * 60 * 60 * 1000);
    // User has no createdAt - its ObjectId carries the creation time.
    const sinceId = Types.ObjectId.createFromTime(
      Math.floor(since.getTime() / 1000),
    );

    const [
      users,
      newUsers,
      doctors,
      clinics,
      hospitals,
      pharmacies,
      paraClinics,
      insurances,
      pending,
      paidOrders,
      reservationsByStatus,
      signups,
      reservations,
      recentUsers,
      orderRefunds,
      commission,
    ] = await Promise.all([
      User.estimatedDocumentCount(),
      User.countDocuments({ _id: { $gte: sinceId } }),
      DoctorProfile.estimatedDocumentCount(),
      Clinic.estimatedDocumentCount(),
      Hospital.estimatedDocumentCount(),
      Pharmacy.estimatedDocumentCount(),
      ParaClinic.estimatedDocumentCount(),
      Insurance.estimatedDocumentCount(),
      // the inbox's own counts, each linking into the inbox on that kind
      inboxCounts(),
      Order.aggregate([
        { $match: { status: "paid", submittedAt: { $gte: since } } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$total" } } },
      ]),
      Reservation.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            total: { $sum: { $ifNull: ["$total", 0] } },
          },
        },
      ]),
      dailyCounts(User, { $toDate: "$_id" }, { _id: { $gte: sinceId } }, days),
      dailyCounts(Reservation, "$createdAt", { createdAt: { $gte: since } }, days),
      User.find().sort({ _id: -1 }).limit(RECENT_USERS).select("phone username role"),
      // what came back to buyers of those orders (cancelled lines): the
      // tile shows net sales, not what was charged once
      Transaction.aggregate([
        { $match: { order: { $exists: true }, orderItem: { $exists: true }, amount: { $gt: 0 } } },
        { $lookup: { from: "orders", localField: "order", foreignField: "_id", as: "o" } },
        { $unwind: "$o" },
        {
          $match: {
            "o.status": "paid",
            "o.submittedAt": { $gte: since },
            $expr: { $eq: ["$user", "$o.user"] },
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // the platform's own income in the period: commission taken from
      // provider payouts (visits and order lines)
      Transaction.aggregate([
        { $match: { commission: { $gt: 0 }, createdAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: "$commission" } } },
      ]),
    ]);

    const reservationStatus = Object.fromEntries(
      reservationsByStatus.map((row: any) => [row._id, row.count]),
    );
    const reservationRevenue = reservationsByStatus
      .filter((row: any) => row._id === "completed")
      .reduce((sum: number, row: any) => sum + row.total, 0);

    res.status(200).json({
      message: "getDashboard",
      data: {
        data: {
          generatedAt: new Date(),
          periodDays: SERIES_DAYS,
          totals: {
            users,
            newUsers,
            doctors,
            clinics,
            hospitals,
            pharmacies,
            paraClinics,
            insurances,
          },
          pending: pending.filter((item) => item.count > 0),
          orders: {
            paidCount: paidOrders[0]?.count || 0,
            paidTotal: paidOrders[0]?.total || 0,
            refunded: orderRefunds[0]?.total || 0,
          },
          commissionTotal: commission[0]?.total || 0,
          reservations: {
            total: Object.values(reservationStatus).reduce(
              (sum: number, n) => sum + (n as number),
              0,
            ),
            byStatus: reservationStatus,
            completedTotal: reservationRevenue,
          },
          series: { signups, reservations },
          recentUsers: recentUsers.map((user) => ({
            _id: user._id,
            phone: user.phone,
            username: user.username,
            role: user.role,
            createdAt: user._id.getTimestamp(),
          })),
        },
      },
    });
  },
);

// ---------------------------------------------------------------------------
// Unified request inbox (2026-09 admin UX restructure). One queue for every
// kind of pending work that used to live on 14 separate admin pages, so an
// admin no longer opens each page to find out whether there's anything to
// do. Items link to the page where they're handled (the detail page when
// there is one).

const INBOX_LIMIT = 50;

type InboxItem = {
  _id: string;
  kind: string;
  title: string;
  subtitle?: string;
  // a money row: the amount (toman), formatted by the panel in its language
  amount?: number;
  // a review row: its score out of 5
  score?: number;
  date?: Date;
  href: string;
};

const personName = (node?: { firstName?: string; lastName?: string }) =>
  [node?.firstName, node?.lastName].filter(Boolean).join(" ");

type InboxSource = {
  key: string;
  title: string;
  model: Model<any>;
  filter: Record<string, unknown>;
  // newest first; also the item's date (ObjectId time when missing)
  dateField: string;
  populate?: { path: string; select: string }[];
  // where every item of this kind is listed (the inbox's "see all")
  listHref: string;
  // staff (notadmin) see this kind when their access level can read this
  // model - the same right the kind's own page needs (2026-10: the inbox
  // was full-admin only, so support had no work queue)
  access: AccessLevelModel;
  map: (node: any) => Omit<InboxItem, "_id" | "kind" | "date">;
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// Provider verification requests come from the requests queue's own kinds
// (adminRequestsController): same pending statuses, same detail pages, and
// "see all" opens /requests on that kind.
const providerRequestSources: InboxSource[] = requestGroups.flatMap((group) =>
  Object.entries(providerRequestKinds[group]).map(([kind, cfg]) => ({
    key:
      group === "become"
        ? `become${capitalize(kind)}`
        : group === "addition"
          ? `${kind}Addition`
          : group === "campaign"
            ? `smsCampaign${capitalize(kind)}`
            : group === "smsTemplate"
              ? `smsTemplate${capitalize(kind)}`
              : group === "contract"
                ? `insuranceContract${capitalize(kind)}`
                : `doctorJoin${capitalize(kind)}`,
    title:
      group === "become"
        ? `درخواست ${cfg.label} شدن`
        : group === "addition"
          ? `اضافه شدن ${cfg.label}`
          : group === "campaign"
            ? `کمپین پیامکی ${cfg.label}`
            : group === "smsTemplate"
              ? `قالب پیامک ${cfg.label}`
              : group === "contract"
                ? `قرارداد بیمه‌ی ${cfg.label}`
                : `عضویت پزشک در ${cfg.label}`,
    model: cfg.model,
    // the kind's own extra filter too (a centre's invite is not the admin's)
    filter: { status: { $in: cfg.pending }, ...cfg.match },
    dateField: "_id",
    populate: (cfg.populate || []).map((path) => ({
      path,
      select: "phone name firstName lastName",
    })),
    listHref: `requests?group=${group}&kind=${kind}`,
    access: cfg.access,
    map: (node: any) => {
      const applicant = cfg.applicant(node);
      const user = applicant.user as any;
      const doctor = applicant.doctor as any;
      return {
        title: cfg.title(node) || "—",
        subtitle:
          user && typeof user === "object"
            ? user.phone
            : doctor && typeof doctor === "object"
              ? personName(doctor)
              : undefined,
        href: cfg.detail(String(node._id)).replace(/^\//, ""),
      };
    },
  })),
);

// The reservations a person must decide (same rule as the reservations
// list's ?needsAction=1, adminReservationController.listReservations).
export const reservationNeedsActionFilter = {
  $or: [{ status: "error" }, { status: "noShow", dispute: { $exists: true } }],
  "adminActions.action": { $nin: ["resolveRefund", "resolveComplete", "resolveAccept"] },
};

const inboxSources: InboxSource[] = [
  ...providerRequestSources,
  {
    key: "withdrawals",
    title: "درخواست برداشت",
    model: WithdrawalRequest,
    filter: { status: "pending" },
    dateField: "createdAt",
    populate: [{ path: "user", select: "phone" }],
    map: (node) => ({
      title: "",
      amount: Number(node.amount) || 0,
      subtitle: node.user?.phone,
      href: "finance/withdrawals?status=pending",
    }),
    listHref: "finance/withdrawals?status=pending",
    access: "Finance",
  },
  {
    // money taken from a card that reached neither the wallet nor the card
    key: "paymentsNeedReview",
    title: "پرداخت‌های نیازمند بررسی",
    model: GatewayPayment,
    filter: { status: "needsReview" },
    dateField: "createdAt",
    populate: [{ path: "user", select: "phone" }],
    map: (node) => ({
      title: "",
      amount: Number(node.amount) || 0,
      subtitle: node.user?.phone,
      href: "finance/payments?status=needsReview",
    }),
    listHref: "finance/payments?status=needsReview",
    access: "Finance",
  },
  {
    key: "tickets",
    title: "تیکت‌های باز",
    model: Ticket,
    filter: { status: { $in: ["Open", "InProgress"] } },
    dateField: "submittedAt",
    populate: [{ path: "submittedBy", select: "phone" }],
    map: (node) => ({
      title: node.title || "—",
      subtitle: node.submittedBy?.phone,
      href: `ticket/${node._id}`,
    }),
    listHref: "ticket",
    access: "Ticket",
  },
  {
    key: "contactRequests",
    title: "درخواست‌های تماس",
    model: ContactRequest,
    filter: { status: "pending" },
    dateField: "submittedAt",
    map: (node) => ({
      title: node.name || "—",
      subtitle: node.phone,
      href: `contactRequest/${node._id}`,
    }),
    listHref: "contactRequest",
    access: "ContactRequest",
  },
  {
    key: "comments",
    title: "نظرات در انتظار تایید",
    model: Comment,
    filter: { status: "Pending" },
    dateField: "createdAt",
    populate: [{ path: "author", select: "phone" }],
    map: (node) => ({
      title:
        typeof node.content === "string"
          ? node.content.slice(0, 80)
          : node.author?.phone || "—",
      subtitle: node.author?.phone,
      href: `comment/${node._id}`,
    }),
    listHref: "reviews?tab=pages",
    access: "Comment",
  },
  {
    // an article a provider sent from their panel (Blog.reviewStatus)
    key: "blogReviews",
    title: "مقاله‌های در انتظار بررسی",
    model: Blog,
    filter: blogAwaitingReviewFilter,
    dateField: "publishedAt",
    map: (node) => ({
      title: node.title || "—",
      subtitle: node.author,
      href: `blog/${node._id}`,
    }),
    listHref: "blog?review=pending",
    access: "Blog",
  },
  {
    key: "doctorFeedbacks",
    title: "نظرات بیماران در انتظار تایید",
    model: DoctorFeedBack,
    filter: { status: "Pending" },
    dateField: "submittedAt",
    populate: [{ path: "doctor", select: "firstName lastName" }],
    map: (node) => ({
      title:
        (typeof node.publicMessage === "string" && node.publicMessage.slice(0, 80)) || "",
      ...(typeof node.overalScore === "number" ? { score: node.overalScore } : {}),
      subtitle: `${node.doctor?.firstName || ""} ${node.doctor?.lastName || ""}`.trim(),
      href: "reviews?tab=visits",
    }),
    listHref: "reviews?tab=visits",
    access: "DoctorFeedback",
  },
  {
    // a visit whose channel never opened or whose outcome couldn't be
    // pinned on either party, and a patient's objection to a visit counted
    // as done: someone has to decide it. Once an admin resolves it
    // (adminReservationController resolve*) it leaves the queue - before,
    // a resolved "error" stayed here forever and disputes never showed.
    key: "reservationErrors",
    title: "نوبت‌های نیازمند بررسی",
    model: Reservation,
    filter: reservationNeedsActionFilter,
    dateField: "createdAt",
    populate: [
      { path: "doctor", select: "firstName lastName" },
      { path: "user", select: "phone" },
    ],
    map: (node) => ({
      title: personName(node.doctor) || "—",
      subtitle: node.user?.phone,
      href: `reservation/${node._id}`,
    }),
    listHref: "reservation?needsAction=1",
    access: "Reservation",
  },
];

const countOf = (source: InboxSource) => source.model.countDocuments(source.filter);

// The kinds the caller may see: all for a full admin, for staff the ones
// whose model their access level can read.
const sourcesFor = async (req: Request): Promise<InboxSource[]> => {
  if (req.user?.role === "admin") return inboxSources;
  if (req.user?.role !== "notadmin") return [];
  const access = await UserAccessLevel.findOne({ user: req.user._id }).populate("accessLevel");
  const level = access?.accessLevel as unknown as
    | Record<string, Record<string, boolean> | undefined>
    | undefined;
  return inboxSources.filter((source) => !!level?.[source.access]?.readAll);
};

// Per-kind pending counts (dashboard card and sidebar badge). Each links
// into the inbox filtered on that kind.
const inboxCounts = (sources: InboxSource[] = inboxSources) =>
  Promise.all(
    sources.map(async (source) => ({
      key: source.key,
      title: source.title,
      href: `inbox?kind=${source.key}`,
      listHref: source.listHref,
      count: await countOf(source),
    })),
  );

export const getInbox: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    // ?countOnly=1: just the per-kind counts (the sidebar badge).
    const sources = await sourcesFor(req);
    if (req.query.countOnly) {
      const kinds = await inboxCounts(sources);
      return res.status(200).json({
        message: "getInbox",
        data: { data: { kinds, items: [] } },
      });
    }
    const groups = await Promise.all(
      sources.map(async (source) => {
        let query = source.model
          .find(source.filter)
          .sort({ [source.dateField]: -1 })
          .limit(INBOX_LIMIT);
        for (const pop of source.populate || [])
          query = query.populate(pop.path, pop.select);
        const [count, nodes] = await Promise.all([countOf(source), query.lean()]);
        const items: InboxItem[] = (nodes as any[]).map((node) => ({
          ...source.map(node),
          _id: String(node._id),
          kind: source.key,
          date:
            source.dateField === "_id"
              ? node.createdAt || node.submittedAt || node._id?.getTimestamp?.()
              : node[source.dateField],
        }));
        return {
          key: source.key,
          title: source.title,
          href: `inbox?kind=${source.key}`,
          listHref: source.listHref,
          count,
          items,
        };
      }),
    );

    res.status(200).json({
      message: "getInbox",
      data: {
        data: {
          kinds: groups.map(({ items, ...kind }) => kind),
          items: groups
            .flatMap((group) => group.items)
            .sort(
              (a, b) =>
                new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime(),
            ),
        },
      },
    });
  },
);
