import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { BadInputError, ServerError } from "../Lib/AppError";
import * as env from "../Lib/Env";
import { getAppConfig } from "../Lib/appConfig";
import VisitorIdentity from "../Models/VisitorIdentity";
import PageVisit from "../Models/PageVisit";

const VISITOR_COOKIE_NAME = "vid";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// a page path, not a document: longer values are refused
const MAX_PAGE_LENGTH = 500;

// POST /analytics/visit is public: a per-IP budget per minute keeps a
// script from filling VisitorIdentity / PageVisit (each cookieless hit
// creates an identity). Over the budget the hit is simply not recorded.
const VISITS_PER_MINUTE = 60;
const visitBuckets = new Map<string, { at: number; n: number }>();
const overVisitBudget = (req: Request) => {
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "?";
  const now = Date.now();
  const bucket = visitBuckets.get(ip);
  if (!bucket || now - bucket.at > 60_000) {
    if (visitBuckets.size > 50_000) visitBuckets.clear();
    visitBuckets.set(ip, { at: now, n: 1 });
    return false;
  }
  bucket.n += 1;
  return bucket.n > VISITS_PER_MINUTE;
};

// Reads the anonymous visitor-id cookie, or mints and sets a new one if
// it's missing. This is what lets us recognize the same browser across
// requests before (or without) a login.
export const getOrCreateVisitorId = async (
  req: Request,
  res: Response,
): Promise<string> => {
  const existing = req.cookies?.[VISITOR_COOKIE_NAME];
  // only an id this server minted (a UUID): a hand-made cookie can't store
  // an arbitrary-length key or take over another browser's identity
  if (typeof existing === "string" && UUID.test(existing)) return existing;
  const { analyticsVisitorCookieDays } = await getAppConfig();
  const visitorId = crypto.randomUUID();
  res.cookie(VISITOR_COOKIE_NAME, visitorId, {
    maxAge: analyticsVisitorCookieDays * 24 * 60 * 60 * 1000,
    httpOnly: true,
    path: "/api",
    secure: env.NODE_ENV === "production",
  });
  return visitorId;
};

// POST /analytics/visit
// Called by the client whenever a page is visited. Resolves (or creates)
// the VisitorIdentity for this browser, links it to the logged in user
// when one is available (via optionalAuth), and records the page visit -
// collapsing repeated hits to the same page within
// analyticsVisitWindowSeconds into a single PageVisit document.
export const trackVisit: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const page = req.body?.page;
    if (typeof page !== "string" || !page.trim() || page.length > MAX_PAGE_LENGTH)
      return next(new BadInputError());
    if (overVisitBudget(req))
      return res.status(200).json({ message: "trackVisit", data: null });

    const visitorId = await getOrCreateVisitorId(req, res);
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

    const { analyticsVisitWindowSeconds } = await getAppConfig();
    const windowStart = new Date(
      now.getTime() - analyticsVisitWindowSeconds * 1000,
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
