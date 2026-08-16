import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { BadInputError, ServerError } from "../Lib/AppError";
import * as env from "../Lib/Env";
import VisitorIdentity from "../Models/VisitorIdentity";
import PageVisit from "../Models/PageVisit";

const VISITOR_COOKIE_NAME = "vid";

const visitorCookieOptions = {
  maxAge: env.ANALYTICS_VISITOR_COOKIE_DAYS * 24 * 60 * 60 * 1000,
  httpOnly: true,
  path: "/api",
  secure: false,
};
if (env.NODE_ENV === "production") visitorCookieOptions.secure = true;

// Reads the anonymous visitor-id cookie, or mints and sets a new one if
// it's missing. This is what lets us recognize the same browser across
// requests before (or without) a login.
const getOrCreateVisitorId = (req: Request, res: Response): string => {
  const existing = req.cookies?.[VISITOR_COOKIE_NAME];
  if (typeof existing === "string" && existing.length > 0) return existing;
  const visitorId = crypto.randomUUID();
  res.cookie(VISITOR_COOKIE_NAME, visitorId, visitorCookieOptions);
  return visitorId;
};

// POST /analytics/visit
// Called by the client whenever a page is visited. Resolves (or creates)
// the VisitorIdentity for this browser, links it to the logged in user
// when one is available (via optionalAuth), and records the page visit -
// collapsing repeated hits to the same page within
// env.ANALYTICS_VISIT_WINDOW_SECONDS into a single PageVisit document.
export const trackVisit: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const page = req.body?.page;
    if (typeof page !== "string" || !page.trim())
      return next(new BadInputError());

    const visitorId = getOrCreateVisitorId(req, res);
    const now = new Date();

    const identity = await VisitorIdentity.findOneAndUpdate(
      { visitorId },
      {
        $set: {
          lastSeenAt: now,
          ...(req.user ? { user: req.user._id } : {}),
        },
        $setOnInsert: { firstSeenAt: now },
      },
      { upsert: true, new: true },
    );
    if (!identity) return next(new ServerError());

    const windowStart = new Date(
      now.getTime() - env.ANALYTICS_VISIT_WINDOW_SECONDS * 1000,
    );

    // Upsert with the window baked into the filter: if the last hit on
    // this page by this identity was within the window we just bump it,
    // otherwise mongo creates a fresh record. This keeps it to a single
    // atomic call with no separate find-then-create step.
    const visit = await PageVisit.findOneAndUpdate(
      {
        identity: identity._id,
        page: page.trim(),
        lastVisitedAt: { $gte: windowStart },
      },
      {
        $set: { lastVisitedAt: now },
        $inc: { count: 1 },
        $setOnInsert: { visitedAt: now },
      },
      { upsert: true, new: true },
    );

    res.status(200).json({ message: "trackVisit", data: visit });
  },
);

const MAX_PAGES_IN_SUMMARY = 200;
const MAX_RECENT_VISITS = 50;

// GET /analytics/summary (admin only)
// Aggregates the raw PageVisit/VisitorIdentity data into something a
// dashboard can render: overall totals, a per-page leaderboard, and a
// feed of the most recently visited pages (with the visitor's linked
// user, when known).
export const getAnalyticsSummary: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const [totalsAgg, pages, recent] = await Promise.all([
      PageVisit.aggregate([
        {
          $group: {
          _id: null,
            totalVisits: { $sum: "$count" },
            totalRecords: { $sum: 1 },
            uniqueVisitors: { $addToSet: "$identity" },
            uniquePages: { $addToSet: "$page" },
          },
        },
        {
          $project: {
            _id: 0,
            totalVisits: 1,
            totalRecords: 1,
            uniqueVisitors: { $size: "$uniqueVisitors" },
            uniquePages: { $size: "$uniquePages" },
          },
        },
      ]),
      PageVisit.aggregate([
        {
          $group: {
            _id: "$page",
            totalVisits: { $sum: "$count" },
            uniqueVisitors: { $addToSet: "$identity" },
            lastVisitedAt: { $max: "$lastVisitedAt" },
          },
        },
        {
          $project: {
            _id: 0,
            page: "$_id",
            totalVisits: 1,
            uniqueVisitors: { $size: "$uniqueVisitors" },
            lastVisitedAt: 1,
          },
        },
        { $sort: { totalVisits: -1 } },
        { $limit: MAX_PAGES_IN_SUMMARY },
      ]),
      PageVisit.find()
        .sort({ lastVisitedAt: -1 })
        .limit(MAX_RECENT_VISITS)
        .populate({
          path: "identity",
          select: "visitorId user",
          populate: { path: "user", select: "phone username" },
        }),
    ]);

    res.status(200).json({
      message: "getAnalyticsSummary",
      data: {
        totals: totalsAgg[0] || {
          totalVisits: 0,
          totalRecords: 0,
          uniqueVisitors: 0,
          uniquePages: 0,
        },
        pages,
        recent,
      },
    });
  },
);
