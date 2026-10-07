import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import { boolish, numerish } from "../Lib/helpers";
import { endOfTehranDayYmd, fromTehranWallClock, tehranYmd } from "../Lib/tehranTime";
import InsuranceTariff, { tariffLevels, tariffLimitPeriods, tariffMethods, tariffVisitKinds } from "../Models/InsuranceTariff";
import InsurancePlan from "../Models/InsurancePlan";
import Insurance from "../Models/Insurance";
import DoctorProfile from "../Models/DoctorProfile";
import Service from "../Models/Service";
import ServicePackage from "../Models/ServicePackage";
import { quoteBooking, sessionSettingsModels } from "../Lib/bookingFlow";

// the visit type the profile's estimate is for: the first the doctor offers
const visitTypeOrder = ["inPerson", "textChat", "voiceCall", "sipCall", "videoCall"];

// Insurance tariffs (2026-10, «تعرفه‌ها», Models/InsuranceTariff.ts): the
// super admin keeps every insurer's (a tab of the insurance hub), an insurer
// keeps its own in its panel. Both write through the same rules here.

const MAX = Number.MAX_SAFE_INTEGER;
const id = z.string().regex(/^[0-9a-fA-F]{24}$/);
// "" from an emptied picker is "none"
const optId = z.preprocess((v) => (v === "" ? null : v), id.nullable().optional());
const money = z.preprocess((v) => (v === "" || v === null ? 0 : v), numerish(0, MAX));
// a day in Tehran: a "YYYY-MM-DD" or a date; "" or null clears it
const day = z.preprocess((v) => {
  if (v === "" || v === null || v === undefined) return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? v : tehranYmd(d);
}, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional());

const baseSchema = z.strictObject({
  insurance: id.optional(),
  plan: optId,
  title: z.string().trim().max(120).optional(),
  visitKind: z.enum(tariffVisitKinds).optional(),
  level: z.enum(tariffLevels).optional(),
  speciality: optId,
  service: optId,
  servicePackage: optId,
  method: z.enum(tariffMethods),
  percent: z.preprocess((v) => (v === "" || v === null ? 0 : v), numerish(0, 100)).optional(),
  amount: money.optional(),
  govTariff: money.optional(),
  ceiling: money.optional(),
  copay: money.optional(),
  limitPeriod: z.enum(tariffLimitPeriods).optional(),
  limitCount: z.preprocess((v) => (v === "" || v === null ? 0 : v), numerish(0, 1000)).optional(),
  limitAmount: money.optional(),
  validFrom: day,
  validTo: day,
  active: boolish.optional(),
  note: z.string().trim().max(500).optional(),
});
type TariffBody = z.infer<typeof baseSchema>;

// the rule makes sense: what it pays is set, its dates run forward, a
// limit has a size, its plan is the insurer's own
const checkRule = async (b: TariffBody, insurance: string) => {
  const pct = Number(b.percent) || 0;
  if (b.method === "percent" && pct <= 0) throw new AppError("درصد پوشش را وارد کنید", 400);
  if (b.method === "fixed" && !(Number(b.amount) > 0)) throw new AppError("مبلغ ثابت پرداخت بیمه را وارد کنید", 400);
  if (b.method === "govTariff" && (!(Number(b.govTariff) > 0) || pct <= 0))
    throw new AppError("تعرفه‌ی مصوب و درصد سهم بیمه از آن را وارد کنید", 400);
  if (b.validFrom && b.validTo && b.validTo < b.validFrom) throw new AppError("پایان اعتبار تعرفه باید بعد از شروع آن باشد", 400);
  if (b.limitPeriod && b.limitPeriod !== "none" && !(Number(b.limitCount) > 0) && !(Number(b.limitAmount) > 0))
    throw new AppError("برای سقف ماهانه یا سالانه، تعداد ویزیت یا مبلغ آن را وارد کنید", 400);
  if (b.plan && !(await InsurancePlan.exists({ _id: b.plan, insurance })))
    throw new AppError("این طرح مال همین بیمه نیست", 400);
};

const toDoc = (b: TariffBody) => ({
  ...b,
  validFrom: b.validFrom ? fromTehranWallClock(b.validFrom, 0) : b.validFrom === null ? null : undefined,
  validTo: b.validTo ? endOfTehranDayYmd(b.validTo) : b.validTo === null ? null : undefined,
});

const populate = [
  { path: "insurance", select: "name isBasic" },
  { path: "plan", select: "name" },
  { path: "speciality", select: "name" },
  { path: "service", select: "name" },
  { path: "servicePackage", select: "name" },
];

// scope: the insurer's own (its panel) or every insurer (the admin)
const scopeOf = (req: Request) => (req.insurance ? { insurance: req.insurance._id } : {});

export const listTariffs: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const q: Record<string, unknown> = { ...scopeOf(req) };
  if (!req.insurance && typeof req.query.insurance === "string" && isValidObjectId(req.query.insurance)) q.insurance = req.query.insurance;
  const data = await InsuranceTariff.find(q).sort({ insurance: 1, plan: 1, createdAt: -1 }).populate(populate).limit(2000).lean();
  res.status(200).json({ message: "listTariffs", data });
});

export const createTariff: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const parsed = baseSchema.safeParse(req.body ?? {});
  if (!parsed.success) return next(new BadInputError());
  const b = parsed.data;
  const insurance = req.insurance ? String(req.insurance._id) : b.insurance;
  if (!insurance) return next(new AppError("بیمه را انتخاب کنید", 400));
  if (!req.insurance && !(await Insurance.exists({ _id: insurance }))) return next(new NotFoundError("بیمه"));
  await checkRule(b, insurance);
  const data = await InsuranceTariff.create({ ...toDoc(b), insurance });
  res.status(200).json({ message: "createTariff", data: { _id: data._id } });
});

export const editTariff: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { nodeId } = req.params;
  if (!isValidObjectId(nodeId)) return next(new BadInputError());
  const node = await InsuranceTariff.findOne({ _id: nodeId, ...scopeOf(req) });
  if (!node) return next(new NotFoundError());
  const parsed = baseSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) return next(new BadInputError());
  const b = parsed.data;
  // an insurer never moves a rule to another insurer
  const insurance = req.insurance ? String(req.insurance._id) : b.insurance || String(node.insurance);
  const current = node.toObject() as unknown as Record<string, unknown>;
  const merged = { ...current, ...b, method: b.method || node.method } as TariffBody;
  for (const k of ["plan", "speciality", "service", "servicePackage"] as const)
    if ((merged as Record<string, unknown>)[k] && typeof (merged as Record<string, unknown>)[k] !== "string")
      (merged as Record<string, unknown>)[k] = String((merged as Record<string, unknown>)[k]);
  for (const k of ["validFrom", "validTo"] as const) {
    const v = (merged as Record<string, unknown>)[k];
    if (v instanceof Date) (merged as Record<string, unknown>)[k] = tehranYmd(v);
  }
  await checkRule(merged, insurance);
  await InsuranceTariff.updateOne({ _id: node._id }, { $set: { ...toDoc({ ...b, method: merged.method }), insurance } });
  res.status(200).json({ message: "editTariff" });
});

export const removeTariff: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { nodeId } = req.params;
  if (!isValidObjectId(nodeId)) return next(new BadInputError());
  const node = await InsuranceTariff.findOneAndDelete({ _id: nodeId, ...scopeOf(req) });
  if (!node) return next(new NotFoundError());
  res.status(200).json({ message: "removeTariff" });
});

// the insurer's own plans for its tariff form (the admin reads them per
// insurer: GET /admin/insurance-tariffs/plans?insurance=)
export const tariffPlans: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const insurance = req.insurance ? req.insurance._id : req.query.insurance;
  if (!insurance || !isValidObjectId(String(insurance))) return res.status(200).json({ message: "tariffPlans", data: [] });
  if (!req.user) return next(new MiddlewareError());
  const data = await InsurancePlan.find({ insurance }).select("name").sort({ order: 1, _id: 1 }).lean();
  res.status(200).json({ message: "tariffPlans", data });
});

// GET /public/dr/:nodeId/coverage - «پوشش بیمه» on the doctor's public
// profile: every insurance the doctor accepts, and for the doctor's first
// visit type the estimated patient share where a tariff covers it (no
// club code, no «پرو»: the list price).
export const getDoctorCoverage: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { nodeId } = req.params;
  if (!isValidObjectId(nodeId)) return next(new BadInputError());
  const doctor = await DoctorProfile.findOne({ _id: nodeId, active: true, status: { $ne: "suspended" } }).select("_id");
  if (!doctor) return next(new NotFoundError("پزشک"));
  const want = typeof req.query.sessionType === "string" ? req.query.sessionType : null;
  let sessionType: string | null = null;
  for (const t of want ? [want, ...visitTypeOrder] : visitTypeOrder) {
    const model = sessionSettingsModels[t as keyof typeof sessionSettingsModels];
    if (!model) continue;
    const s = await model.findOne({ doctor: doctor._id }).select("active price hidePrice").lean<{ active?: boolean; price?: number; hidePrice?: boolean }>();
    if (s?.active && s.price) {
      sessionType = t;
      break;
    }
  }
  if (!sessionType) return res.status(200).json({ message: "getDoctorCoverage", data: { sessionType: null, items: [] } });
  const base = await quoteBooking({ doctorId: doctor._id, sessionType: sessionType as never });
  if (!base) return res.status(200).json({ message: "getDoctorCoverage", data: { sessionType, items: [] } });
  const items = [];
  for (const opt of base.insurances) {
    // the insurer's general rule first, else its first plan that covers it
    let q: Awaited<ReturnType<typeof quoteBooking>> = null;
    if (opt.covered)
      for (const plan of [null, ...opt.plans.map((p) => p._id)]) {
        q = await quoteBooking({ doctorId: doctor._id, sessionType: sessionType as never, insurances: [{ insurance: opt._id, plan }] });
        if ((q?.insurance.lines[0]?.share || 0) > 0) break;
      }
    const line = q?.insurance.lines[0];
    items.push({
      _id: opt._id,
      name: opt.name,
      image: opt.image,
      isBasic: opt.isBasic,
      covered: !!line && line.share > 0,
      plan: line?.planName || null,
      // a doctor who hides the price: covered or not, no amounts
      insurerShare: base.hidePrice ? 0 : line?.share || 0,
      patientShare: !base.hidePrice && q && line && line.share > 0 ? q.deskTotal : null,
    });
  }
  res.status(200).json({
    message: "getDoctorCoverage",
    data: { sessionType, price: base.hidePrice ? null : base.price, hidePrice: base.hidePrice, items },
  });
});

// GET .../tariff/catalog?kind=service|package&q=&selected= - the doctors'
// services or service packages a tariff rule may be limited to, found by
// name (the tariff form's searchable pickers). `selected` is always in the
// list, so an edited rule shows its choice.
export const tariffCatalog: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const kind = req.query.kind === "package" ? "package" : "service";
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 50) : "";
  const selected = typeof req.query.selected === "string" && isValidObjectId(req.query.selected) ? req.query.selected : null;
  const model = kind === "package" ? ServicePackage : Service;
  const filter: Record<string, unknown> = q ? { name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } : {};
  const select = "name owner price isActive";
  const populateOwner = { path: "owner", select: "firstName lastName" };
  type Row = { _id: unknown; name?: string; price?: number; isActive?: boolean; owner?: { firstName?: string; lastName?: string } | null };
  const [rows, picked] = await Promise.all([
    (model as typeof Service).find(filter).select(select).populate(populateOwner).sort({ isActive: -1, name: 1 }).limit(30).lean<Row[]>(),
    selected ? (model as typeof Service).findById(selected).select(select).populate(populateOwner).lean<Row>() : Promise.resolve(null),
  ]);
  const list = picked && !rows.some((r) => String(r._id) === String(picked._id)) ? [picked, ...rows] : rows;
  const data = list.map((r) => ({
    _id: String(r._id),
    name: r.name || "—",
    price: r.price || 0,
    active: r.isActive !== false,
    owner: r.owner ? `${r.owner.firstName || ""} ${r.owner.lastName || ""}`.trim() : "",
  }));
  res.status(200).json({ message: "tariffCatalog", data });
});
