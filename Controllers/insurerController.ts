import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId, Model } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import { blockIfReferenced } from "../Lib/refIntegrity";
import { acceptingCentres, doctorsAcceptingInsurances } from "../Lib/insuranceNetwork";
import { effectiveContracts } from "../Lib/insuranceContracts";
import DoctorProfile from "../Models/DoctorProfile";
import Office from "../Models/Office";
import { boolish, numerish } from "../Lib/helpers";
import InsurancePlan from "../Models/InsurancePlan";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import ParaClinic from "../Models/Paraclinic";
import Pharmacy from "../Models/Pharmacy";

// What an insurer does in its own panel (2026-10), after Okadoc / Bupa
// partner portals and Sehhaty: keep its plans (price and what they cover)
// and see its provider network. Until now plans were admin-only and the
// panel had nothing an insurer would use.

// ------------------------------------------------------------- plans

export const getMyPlans: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const data = await InsurancePlan.find({ insurance: req.insurance._id }).sort({ order: 1, _id: 1 });
    res.status(200).json({ message: "getMyPlans", data });
  },
);

const planSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  price: numerish(0, Number.MAX_SAFE_INTEGER).optional(),
  features: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  isActive: boolish.optional(),
  isPopular: boolish.optional(),
  order: numerish(-100000, 100000).optional(),
});

export const createMyPlan: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const parsed = planSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError());
    const data = await InsurancePlan.create({ ...parsed.data, insurance: req.insurance._id });
    res.status(200).json({ message: "createMyPlan", data: { _id: data._id } });
  },
);

export const editMyPlan: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = planSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError());
    const node = await InsurancePlan.findOneAndUpdate(
      { _id: nodeId, insurance: req.insurance._id },
      { $set: parsed.data },
    );
    if (!node) return next(new NotFoundError());
    res.status(200).json({ message: "editMyPlan" });
  },
);

export const removeMyPlan: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const plan = await InsurancePlan.findOne({ _id: nodeId, insurance: req.insurance._id }).select("_id");
    if (!plan) return next(new NotFoundError());
    // a plan its tariffs, its members' cards («بیمه‌های من») or past
    // bookings point at is switched off, not deleted: a delete left those
    // tariffs dead and the members' plan unnamed (the admin's
    // /auto/insurancePlan delete already had this guard)
    const inUse = await blockIfReferenced("InsurancePlan")(String(plan._id));
    if (inUse) return next(new AppError(inUse, 409));
    await InsurancePlan.deleteOne({ _id: plan._id });
    res.status(200).json({ message: "removeMyPlan" });
  },
);

// ------------------------------------------------------------- network

// GET /insurance/network - who accepts this insurer, by the rule the
// booking quote applies and the public page counts (Lib/insuranceNetwork.ts):
// active doctors with an effective contract of their own or working at an
// office of a clinic or hospital that has one (`via`), and the active
// centres, labs and pharmacies with an effective contract. The contracts
// themselves (requests, invitations, ending one) are
// Controllers/insuranceContractController.ts.
export const getMyNetwork: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const id = req.insurance._id;
    const place = [
      { path: "province", select: "name" },
      { path: "city", select: "name" },
    ];
    const [accepting, own, centres] = await Promise.all([
      doctorsAcceptingInsurances([id]),
      effectiveContracts({ insurance: id, providerKind: "doctor" }),
      acceptingCentres([id]),
    ]);
    const idsOf = (kind: string) => centres.filter((c) => c.kind === kind).map((c) => c.provider);
    const find = (Model: Model<any>, kind: string) =>
      idsOf(kind).length
        ? Model.find({ _id: { $in: idsOf(kind) } }).select("name slug province city").populate(place).limit(500).lean()
        : Promise.resolve([]);
    const [clinics, hospitals, labs, pharmacies] = await Promise.all([
      find(Clinic, "clinic"),
      find(Hospital, "hospital"),
      find(ParaClinic, "paraClinic"),
      find(Pharmacy, "pharmacy"),
    ]);
    const ids = [...(accepting.get(String(id)) || [])];
    const direct = new Set(own.map((d) => d.provider));
    const [doctors, offices] = await Promise.all([
      DoctorProfile.find({ _id: { $in: ids } })
        .select("firstName lastName slug mainSpeciality")
        .populate({ path: "mainSpeciality", select: "name" })
        .limit(500)
        .lean<{ _id: unknown }[]>(),
      // the centre a doctor reaches it through (no contract of their own)
      Office.find({
        doctor: { $in: ids.filter((d) => !direct.has(d)) },
        active: true,
        $or: [{ clinic: { $in: clinics.map((c: any) => c._id) } }, { hospital: { $in: hospitals.map((h: any) => h._id) } }],
      })
        .select("doctor clinic hospital")
        .lean<{ doctor?: unknown; clinic?: unknown; hospital?: unknown }[]>(),
    ]);
    const centreName = new Map<string, string>(
      [...clinics, ...hospitals].map((c: any) => [String(c._id), String((c as { name?: string }).name || "")]),
    );
    res.status(200).json({
      message: "getMyNetwork",
      data: {
        doctors: doctors.map((d) => {
          const key = String(d._id);
          if (direct.has(key)) return { ...d, via: "doctor" };
          const o = offices.find((x) => String(x.doctor) === key);
          return { ...d, via: "centre", centre: centreName.get(String(o?.clinic || o?.hospital || "")) || "" };
        }),
        clinics,
        hospitals,
        labs,
        pharmacies,
      },
    });
  },
);
