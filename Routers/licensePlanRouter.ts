import express, { NextFunction, Request, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { NotFoundError } from "../Lib/AppError";
import * as authController from "../Controllers/authController";
import { localizeResponse } from "../Lib/i18n/localizeResponse";
import { stripPrivateFields } from "../Lib/stripPrivateFields";
import { isLicenseKind, pricingOfKind } from "../Lib/licenseQuote";
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
