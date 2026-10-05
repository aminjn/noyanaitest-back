// «سیاست هوش مصنوعی» (2026-10): the super admin's control over every AI
// feature (Lib/ai/aiFeatures.ts registry, Lib/ai/aiPolicy.ts rules,
// Lib/ai/aiGate.ts enforcement) and the AI usage report, under system
// settings -> AI. Routes: Routers/adminRouter.ts (/admin/ai/...).
import { NextFunction, Request, RequestHandler, Response } from "express";
import mongoose from "mongoose";
import catchAsync from "../Lib/catchAsync";
import { BadInputError } from "../Lib/AppError";
import AiUsage from "../Models/AiUsage";
import User from "../Models/User";
import PatientProPlan from "../Models/PatientProPlan";
import { AI_FEATURES, AiAudience, aiAudiences, aiFeature, featuresFor, isInternal } from "../Lib/ai/aiFeatures";
import { aiPolicySchema, getAiPolicy, planModules, saveAiPolicy } from "../Lib/ai/aiPolicy";
import { tehranDay } from "../Lib/ai/aiGate";
import { planModelOf, licenseKindList, LicenseKind } from "../Lib/licenseQuote";
import DoctorProfile from "../Models/DoctorProfile";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import Pharmacy from "../Models/Pharmacy";
import ParaClinic from "../Models/Paraclinic";
import Insurance from "../Models/Insurance";

const registryView = (list = AI_FEATURES) =>
  list.map((f) => ({
    key: f.key,
    group: f.group,
    audiences: f.audiences,
    unit: f.unit,
    title: f.title,
    description: f.description,
    internal: isInternal(f),
  }));

type PlanRow = { kind: LicenseKind | "patient"; _id: string; displayName: string; aiFeatures: string[]; aiQuotas: Record<string, unknown> };

// every plan with the AI it sells, for "which plans include it"
const plansWithAi = async (): Promise<PlanRow[]> => {
  const lists = await Promise.all([
    ...licenseKindList.map((kind) =>
      planModelOf(kind)
        .find({})
        .select("displayName aiFeatures aiQuotas order")
        .sort({ order: 1 })
        .lean<{ _id: unknown; displayName?: string; aiFeatures?: string[]; aiQuotas?: Record<string, unknown> }[]>()
        .then((rows) => rows.map((r) => ({ kind, r }))),
    ),
    PatientProPlan.find({})
      .select("displayName aiFeatures aiQuotas")
      .lean<{ _id: unknown; displayName?: string; aiFeatures?: string[]; aiQuotas?: Record<string, unknown> }[]>()
      .then((rows) => rows.map((r) => ({ kind: "patient" as const, r }))),
  ]);
  return lists.flat().map(({ kind, r }) => ({
    kind,
    _id: String(r._id),
    displayName: r.displayName || "",
    aiFeatures: Array.isArray(r.aiFeatures) ? r.aiFeatures : [],
    aiQuotas: r.aiQuotas && typeof r.aiQuotas === "object" ? r.aiQuotas : {},
  }));
};

// GET /admin/ai/policy - the policy, the registry, the plan modules a
// feature can be unlocked by, and the plans that sell AI
export const getPolicy: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  const [policy, plans] = await Promise.all([getAiPolicy(true), plansWithAi()]);
  res.status(200).json({
    message: "getAiPolicy",
    data: { policy, features: registryView(), modules: planModules, plans },
  });
});

// POST /admin/ai/policy {enabled?, mode?, features?: {key: {...}}}
export const savePolicy: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const parsed = aiPolicySchema.safeParse(req.body || {});
  if (!parsed.success) return next(new BadInputError(parsed.error.issues.map((i) => i.path.join(".")).join(", ")));
  const policy = await saveAiPolicy(parsed.data, req.user?._id);
  res.status(200).json({ message: "saveAiPolicy", data: { policy } });
});

// GET /admin/ai/features?audience=doctor - what a plan of this kind may
// include (the plan editors), with the policy's access and paid limits
export const getFeaturesFor: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const audience = String(req.query.audience || "");
  if (!aiAudiences.includes(audience as AiAudience)) return next(new BadInputError());
  const policy = await getAiPolicy();
  const list = featuresFor(audience as AiAudience).filter((f) => !isInternal(f));
  res.status(200).json({
    message: "getAiFeaturesFor",
    data: registryView(list).map((f) => ({ ...f, policy: policy.features[f.key] })),
  });
});

// ---------------------------------------------------------------- report

const ORG_MODELS: Record<string, mongoose.Model<any>> = {
  doctor: DoctorProfile,
  clinic: Clinic,
  hospital: Hospital,
  pharmacy: Pharmacy,
  paraClinic: ParaClinic,
  insurance: Insurance,
};

const orgName = (o: { name?: string; firstName?: string; lastName?: string } | null | undefined) =>
  o ? o.name || [o.firstName, o.lastName].filter(Boolean).join(" ") : "";

// GET /admin/ai/usage?days=30&feature=&audience= - per feature, per day,
// per audience, the top users and organisations, and the failures
export const getUsage: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const days = Math.min(365, Math.max(1, Math.round(Number(req.query.days) || 30)));
  const from = tehranDay(new Date(Date.now() - (days - 1) * 864e5));
  const feature = typeof req.query.feature === "string" && aiFeature(req.query.feature) ? req.query.feature : undefined;
  const audience =
    typeof req.query.audience === "string" && aiAudiences.includes(req.query.audience as AiAudience) ? req.query.audience : undefined;
  // users' rows (and the platform's for the content tools); organisations'
  // rows are the same uses again, read only for the organisation ranking
  const match: Record<string, unknown> = { scope: { $in: ["user", "platform"] }, day: { $gte: from } };
  if (feature) match.feature = feature;
  if (audience) match.audience = audience;
  const orgMatch: Record<string, unknown> = { ...match, scope: "org" };

  const [byFeature, byDay, byAudience, topUsers, topOrgs, byTier] = await Promise.all([
    AiUsage.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$feature",
          units: { $sum: "$count" },
          requests: { $sum: "$requests" },
          failed: { $sum: "$failed" },
          users: { $addToSet: "$subject" },
        },
      },
      { $project: { units: 1, requests: 1, failed: 1, users: { $size: "$users" } } },
      { $sort: { requests: -1 } },
    ]),
    AiUsage.aggregate([
      { $match: match },
      { $group: { _id: { day: "$day", feature: "$feature" }, units: { $sum: "$count" }, requests: { $sum: "$requests" } } },
      { $sort: { "_id.day": 1 } },
    ]),
    AiUsage.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$audience",
          units: { $sum: "$count" },
          requests: { $sum: "$requests" },
          users: { $addToSet: "$subject" },
        },
      },
      { $project: { units: 1, requests: 1, users: { $size: "$users" } } },
      { $sort: { requests: -1 } },
    ]),
    AiUsage.aggregate([
      { $match: { ...match, scope: "user" } },
      { $group: { _id: "$subject", requests: { $sum: "$requests" }, units: { $sum: "$count" }, audience: { $last: "$audience" }, features: { $addToSet: "$feature" } } },
      { $sort: { requests: -1 } },
      { $limit: 15 },
    ]),
    AiUsage.aggregate([
      { $match: orgMatch },
      { $group: { _id: { org: "$subject", kind: "$orgKind" }, requests: { $sum: "$requests" }, units: { $sum: "$count" }, features: { $addToSet: "$feature" } } },
      { $sort: { requests: -1 } },
      { $limit: 15 },
    ]),
    AiUsage.aggregate([
      { $match: match },
      { $group: { _id: "$tier", requests: { $sum: "$requests" } } },
    ]),
  ]);

  const users = await User.find({ _id: { $in: topUsers.map((u) => u._id) } })
    .select("firstName lastName phone role")
    .lean<{ _id: unknown; firstName?: string; lastName?: string; phone?: string; role?: string }[]>();
  const orgs = await Promise.all(
    topOrgs.map(async (o) => {
      const model = ORG_MODELS[o._id.kind];
      const doc = model
        ? await model.findById(o._id.org).select("name firstName lastName").lean<{ name?: string; firstName?: string; lastName?: string }>()
        : null;
      return {
        id: String(o._id.org),
        kind: o._id.kind || "",
        name: orgName(doc),
        requests: o.requests,
        units: o.units,
        features: o.features,
      };
    }),
  );
  const sum = (k: "requests" | "units" | "failed") => byFeature.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  res.status(200).json({
    message: "getAiUsage",
    data: {
      days,
      from,
      totals: { requests: sum("requests"), units: sum("units"), failed: sum("failed") },
      byFeature: byFeature.map((r) => ({ feature: r._id, units: r.units, requests: r.requests, failed: r.failed, users: r.users })),
      byDay: byDay.map((r) => ({ day: r._id.day, feature: r._id.feature, units: r.units, requests: r.requests })),
      byAudience: byAudience.map((r) => ({ audience: r._id, units: r.units, requests: r.requests, users: r.users })),
      byTier: Object.fromEntries(byTier.map((r) => [r._id || "free", r.requests])),
      topUsers: topUsers.map((u) => {
        const doc = users.find((x) => String(x._id) === String(u._id));
        return {
          id: String(u._id),
          name: [doc?.firstName, doc?.lastName].filter(Boolean).join(" "),
          phone: doc?.phone || "",
          audience: u.audience,
          requests: u.requests,
          units: u.units,
          features: u.features,
        };
      }),
      topOrgs: orgs,
    },
  });
});
