import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import { boolish, numerish } from "../Lib/helpers";
import InsurancePlan from "../Models/InsurancePlan";
import DoctorInsurance from "../Models/DoctorInsurance";
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
    const node = await InsurancePlan.findOneAndDelete({ _id: nodeId, insurance: req.insurance._id });
    if (!node) return next(new NotFoundError());
    res.status(200).json({ message: "removeMyPlan" });
  },
);

// ------------------------------------------------------------- network

// GET /insurance/network - who accepts this insurer: doctors (approved
// through the insurance-addition flow) and the centres, labs and
// pharmacies that list it on their profile.
export const getMyNetwork: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const id = req.insurance._id;
    const place = [
      { path: "province", select: "name" },
      { path: "city", select: "name" },
    ];
    const [doctors, clinics, hospitals, labs, pharmacies] = await Promise.all([
      DoctorInsurance.find({ insurance: id })
        .populate({
          path: "doctor",
          select: "firstName lastName slug mainSpeciality active",
          populate: { path: "mainSpeciality", select: "name" },
        })
        .limit(500)
        .lean(),
      Clinic.find({ insurances: id }).select("name slug province city").populate(place).limit(500).lean(),
      Hospital.find({ insurances: id }).select("name slug province city").populate(place).limit(500).lean(),
      ParaClinic.find({ insurances: id }).select("name slug province city").populate(place).limit(500).lean(),
      Pharmacy.find({ insurances: id }).select("name slug province city").populate(place).limit(500).lean(),
    ]);
    res.status(200).json({
      message: "getMyNetwork",
      data: {
        doctors: (doctors as { doctor?: unknown }[]).map((d) => d.doctor).filter(Boolean),
        clinics,
        hospitals,
        labs,
        pharmacies,
      },
    });
  },
);
