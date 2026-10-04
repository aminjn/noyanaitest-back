import express, { NextFunction, Request, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { NotFoundError } from "../Lib/AppError";
import * as authController from "../Controllers/authController";
import { localizeResponse } from "../Lib/i18n/localizeResponse";
import { stripPrivateFields } from "../Lib/stripPrivateFields";
import { isLicenseKind, LicenseKind, pricingOfKind, upgradeContextOf } from "../Lib/licenseQuote";
import * as aclController from "../Controllers/aclController";
import DoctorProfileLicense from "../Models/DoctorProfileLicense";
import ClinicProfileLicense from "../Models/ClinicProfileLicense";
import HospitalProfileLicense from "../Models/HospitalProfileLicense";
import PharmacyProfileLicense from "../Models/PharmacyProfileLicense";
import ParaClinicProfileLicense from "../Models/ParaClinicProfileLicense";
import InsuranceProfileLicense from "../Models/InsuranceProfileLicense";
import { Model } from "mongoose";
import { recommendedTiers, seedRecommendedPlans } from "../Lib/licenseTiers";

// Provider plans (2026-10): the priced lineup of a kind - every active plan
// with each option's quote (the option's own discount and the best running
// promotion, Lib/licenseQuote.ts) - read by the panels' licence pages and
// the public /pricing page; and the super admin's «ساخت پلن‌های پیشنهادی».
const router = express.Router();

// GET /licensePlans/pricing/:kind?code=
router.get(
  "/pricing/:kind",
  stripPrivateFields,
  localizeResponse,
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { kind } = req.params;
    if (!isLicenseKind(kind)) return next(new NotFoundError());
    const data = await pricingOfKind(kind, typeof req.query.code === "string" ? req.query.code : undefined);
    res.status(200).json({ message: "getLicensePricing", data });
  }),
);

const profileLicenses: Record<LicenseKind, Model<any>> = {
  doctor: DoctorProfileLicense as Model<any>,
  clinic: ClinicProfileLicense as Model<any>,
  hospital: HospitalProfileLicense as Model<any>,
  pharmacy: PharmacyProfileLicense as Model<any>,
  paraClinic: ParaClinicProfileLicense as Model<any>,
  insurance: InsuranceProfileLicense as Model<any>,
};

// GET /licensePlans/panel/:name?code= - the same lineup for the signed-in
// provider (owner or a secretary with "readLicenses"): with a running plan
// each higher plan is priced as an upgrade (minus the unused days' credit)
// and a lower one is marked not upgradable (2026-10)
router.get(
  "/panel/:name",
  authController.protect,
  aclController.useAcl("readLicenses" as never),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const kind = req.params.name;
    if (!isLicenseKind(kind)) return next(new NotFoundError());
    const owner = (req as unknown as Record<string, { _id: unknown } | undefined>)[kind];
    if (!owner) return next(new NotFoundError());
    const current = await profileLicenses[kind].findOne({ owner: owner._id }).lean();
    const ctx = await upgradeContextOf(kind, owner._id, current as never);
    const data = await pricingOfKind(kind, typeof req.query.code === "string" ? req.query.code : undefined, ctx);
    res.status(200).json({ message: "getLicensePanelPricing", data });
  }),
);

// GET /licensePlans/recommended/:kind - what the seed would create
router.get(
  "/recommended/:kind",
  authController.protect,
  authController.restrictTo("admin"),
  (req: Request, res: Response, next: NextFunction) => {
    const { kind } = req.params;
    if (!isLicenseKind(kind)) return next(new NotFoundError());
    res.status(200).json({ message: "getRecommendedPlans", data: recommendedTiers(kind) });
  },
);

// POST /licensePlans/seed/:kind - creates the recommended plans this kind
// is missing; existing plans are never changed
router.post(
  "/seed/:kind",
  authController.protect,
  authController.restrictTo("admin"),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { kind } = req.params;
    if (!isLicenseKind(kind)) return next(new NotFoundError());
    const created = await seedRecommendedPlans(kind);
    res.status(200).json({ message: "seedRecommendedPlans", data: { created } });
  }),
);

export default router;
