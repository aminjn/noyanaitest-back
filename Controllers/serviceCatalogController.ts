import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import ServiceCategory from "../Models/ServiceCategory";
import DoctorProfile from "../Models/DoctorProfile";
import {
  cleanServiceTitle,
  ensureServiceCategory,
  findServiceCategoryByName,
  PUBLIC_SERVICE_CATEGORY,
  serviceIdList,
} from "../Lib/serviceCatalog";
import { repointReferences } from "../Lib/refIntegrity";

// The service catalogue a doctor's profile picks from (owner decision
// 2026-10, doctor audit 3.2e). See Lib/serviceCatalog.ts for the rule.

const TITLE_MAX = 80;

const titleError = "نام خدمت را بین ۲ تا ۸۰ نویسه بنویسید";

const validTitle = (value: unknown) => {
  const title = cleanServiceTitle(value);
  return title.length >= 2 && title.length <= TITLE_MAX ? title : "";
};

// ---- doctor panel ----------------------------------------------------------

// what the profile's picker lists: the reviewed catalogue, the entries this
// doctor suggested (live for them while under review) and whatever the
// profile already holds
export const getDoctorServiceOptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const profile = await DoctorProfile.findById(req.doctor._id)
      .select("serviceCategories")
      .lean<{ serviceCategories?: unknown }>();
    const held = serviceIdList(profile?.serviceCategories);
    const data = await ServiceCategory.find({
      $or: [
        PUBLIC_SERVICE_CATEGORY,
        { suggestedBy: req.doctor._id, isActive: true },
        { _id: { $in: held } },
      ],
    })
      .select("title slug order isActive pendingReview")
      .sort({ order: 1, _id: 1 });
    res.status(200).json({ message: "getDoctorServiceOptions", data: { data } });
  },
);

const createSchema = z.object({ title: z.unknown() });

// adds a missing service from the profile's picker: an existing entry with
// the same normalised name is returned instead of a duplicate
export const createDoctorService: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = createSchema.safeParse(req.body);
    if (!success) return next(new BadInputError());
    const title = validTitle(data.title);
    if (!title) return next(new AppError(titleError, 400));
    const result = await ensureServiceCategory(title, req.doctor._id);
    if (!result) return next(new AppError(titleError, 400));
    const node = await ServiceCategory.findById(result.node._id).select(
      "title slug order isActive pendingReview",
    );
    res.status(200).json({
      message: "createDoctorService",
      data: { data: node, created: result.created },
    });
  },
);

// the profile save's check: every id a catalogue entry the doctor may hold
// (reviewed and active, suggested by them, or already on the profile)
export const allowedDoctorServices = async (
  doctorId: unknown,
  value: unknown,
): Promise<{ ids: ReturnType<typeof serviceIdList>; ok: boolean }> => {
  const ids = serviceIdList(value);
  // a repeated id is dropped; a string that is no id is refused
  const list: unknown[] = Array.isArray(value) ? value : [];
  if (list.some((el) => !serviceIdList([el]).length)) return { ids, ok: false };
  if (!ids.length) return { ids, ok: true };
  const profile = await DoctorProfile.findById(doctorId)
    .select("serviceCategories")
    .lean<{ serviceCategories?: unknown }>();
  const held = serviceIdList(profile?.serviceCategories);
  const count = await ServiceCategory.countDocuments({
    _id: { $in: ids },
    $or: [
      PUBLIC_SERVICE_CATEGORY,
      { suggestedBy: doctorId, isActive: true },
      { _id: { $in: held } },
    ],
  });
  return { ids, ok: count === ids.length };
};

// ---- super admin -----------------------------------------------------------

// the doctor-suggested entries waiting for review, with who suggested them
// and how many profiles hold them
export const getPendingServices: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const rows = await ServiceCategory.find({ pendingReview: true })
      .sort({ _id: -1 })
      .populate({ path: "suggestedBy", select: "firstName lastName slug" })
      .lean();
    const counts = await DoctorProfile.aggregate<{ _id: unknown; count: number }>([
      { $match: { serviceCategories: { $in: rows.map((r) => r._id) } } },
      { $unwind: "$serviceCategories" },
      { $match: { serviceCategories: { $in: rows.map((r) => r._id) } } },
      { $group: { _id: "$serviceCategories", count: { $sum: 1 } } },
    ]);
    const countOf = new Map(counts.map((c) => [String(c._id), c.count]));
    const data = rows.map((row) => ({
      ...row,
      doctorCount: countOf.get(String(row._id)) || 0,
    }));
    res.status(200).json({ message: "getPendingServices", data: { data } });
  },
);

// approve: the entry joins the global lists (one way: an approved entry is
// never pending again)
export const approvePendingService: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await ServiceCategory.findOneAndUpdate(
      { _id: nodeId, pendingReview: true },
      { $set: { pendingReview: false, isActive: true } },
      { new: true },
    );
    if (!node) {
      const exists = await ServiceCategory.exists({ _id: nodeId });
      if (!exists) return next(new NotFoundError("خدمت"));
      return next(new AppError("این خدمت در انتظار بررسی نیست", 400));
    }
    res.status(200).json({ message: "approvePendingService", data: { data: node } });
  },
);

const mergeSchema = z.strictObject({
  into: z.string().refine((v) => isValidObjectId(v)),
});

// merge into an existing entry: every doctor, service and package that held
// the suggestion points at the target, then the suggestion is removed
export const mergePendingService: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = mergeSchema.safeParse(req.body);
    if (!success) return next(new BadInputError());
    if (String(data.into) === String(nodeId))
      return next(new AppError("یک خدمت را نمی‌توان در خودش ادغام کرد", 400));
    const [source, target] = await Promise.all([
      ServiceCategory.findById(nodeId).select("pendingReview"),
      ServiceCategory.findById(data.into).select("pendingReview isActive"),
    ]);
    if (!source || !target) return next(new NotFoundError("خدمت"));
    if (!source.pendingReview)
      return next(new AppError("این خدمت در انتظار بررسی نیست", 400));
    if (target.pendingReview)
      return next(new AppError("فقط در خدمتی تأییدشده می‌توان ادغام کرد", 400));
    const moved = await repointReferences("ServiceCategory", String(source._id), String(target._id));
    await ServiceCategory.deleteOne({ _id: source._id, pendingReview: true });
    res.status(200).json({
      message: "mergePendingService",
      data: { into: target._id, moved, doctors: moved.DoctorProfile || 0 },
    });
  },
);

// the admin's own catalogue form (autoRouter serviceCategory): creating a
// name that already exists returns that entry (the inline "create" of the
// doctor form and the service form never makes a twin); renaming onto
// another entry's name is refused - merge them instead
export const dedupeServiceCategory: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const set = (body.$set || {}) as Record<string, unknown>;
    const rawTitle = "title" in body ? body.title : set.title;
    if (rawTitle === undefined) return next();
    const title = cleanServiceTitle(rawTitle);
    if ("title" in body) body.title = title;
    else set.title = title;
    if (!title) return next();
    const { nodeId } = req.params;
    const twin = await findServiceCategoryByName(title, nodeId);
    if (!twin) return next();
    if (nodeId)
      return next(
        new AppError("خدمتی با همین نام در فهرست هست؛ به‌جای آن، این دو را ادغام کنید", 400),
      );
    // the admin typing a doctor's suggestion is reviewing it
    const node = twin.pendingReview
      ? await ServiceCategory.findByIdAndUpdate(
          twin._id,
          { $set: { pendingReview: false, isActive: true } },
          { new: true },
        )
      : await ServiceCategory.findById(twin._id);
    res.status(200).json({ message: "create", data: { data: node, existing: true } });
  },
);
