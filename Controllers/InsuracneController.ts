import { notifyLicensePurchased } from "../Services/licenseExpiryService";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { isLicenseActive, isLicenseExpired } from "../Lib/licenseActive";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  AccessError,
  ActiveLicenseExistsError,
  BadInputError,
  MiddlewareError,
  NotFoundError,
} from "../Lib/AppError";
import * as z from "zod";
import { isValidObjectId } from "mongoose";
import Insurance from "../Models/Insurance";
import BecomeInsuranceRequest from "../Models/BecomeInsuranceRequest";
import { notifyUserAlertSubscribers } from "../Services/userAlertService";
import { isPoint } from "../Lib/helpers";
import InsuranceCategory from "../Models/InsuranceCategory";
import InsuranceTag from "../Models/InsuranceTag";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import BaseInsuranceLicense, {
  insuranceDashboardModules,
  InsuranceDashboardModule,
} from "../Models/BaseInsuranceLicense";
import InsuranceProfileLicense from "../Models/InsuranceProfileLicense";
import { findActivePricing, licenseDurationsOf } from "../Lib/licensePricing";

const becomeInsuramceRequestSchema = z.strictObject({
  name: z.string().trim().min(1),
  siamCode: z.string(),
  nationalId: z.string(),
  certificateDate: z.coerce.date(),
  certificateFile: z.string().optional(),
  description: z.string().optional(),
});
export const becomeAInsurance: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await becomeInsuramceRequestSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const cur = await Insurance.findOne({ user: req.user._id });
    if (!!cur) return next(new AppError("شما قبلا بیمه شده اید", 409));
    const pending = await BecomeInsuranceRequest.findOne({
      user: req.user._id,
      status: "Pending",
    });
    if (pending) return next(new AppError("درخواست شما قبلا ثبت شده است", 409));
    // an approved request is final: resubmitting used to flip it back to
    // Pending (only a declined one may be sent again)
    const approved = await BecomeInsuranceRequest.exists({
      user: req.user._id,
      status: "Approved",
    });
    if (approved)
      return next(new AppError("درخواست شما قبلا تأیید شده است", 409));
    const becomeInsuranceRequest =
      await BecomeInsuranceRequest.findOneAndUpdate(
        { user: req.user._id },
        {
          ...data,
          user: req.user._id,
          status: "Pending",
          // a resubmitted request is a fresh one: the old decision goes
          $unset: { rejectReason: 1, decidedAt: 1 },
        },
        { upsert: true, new: true },
      );
    notifyUserAlertSubscribers(
      "newBecomeInsuranceRequest",
      {
        title: "درخواست بیمه شدن",
        message: `کاربر ${req.user.phone} درخواست بیمه شدن ثبت کرد.`,
      },
      {
        requestId: becomeInsuranceRequest._id.toString(),
        userPhone: req.user.phone,
      },
    ).catch((err) =>
      console.log(
        `[InsuracneController] failed to notify staff of becomeInsurance request by ${req.user?._id}:`,
        err,
      ),
    );
    res.status(200).json({ message: "becomeAInsurance" });
  },
);

export const getMyBecomeInsuranceRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await BecomeInsuranceRequest.findOne({ user: req.user._id });
    res.status(200).json({ message: "getMyBecomeInsuranceRequest", data });
  },
);

export const getMyInsuranceProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const data = await Insurance.findById(req.insurance._id);
    if (!data) return next(new AccessError());
    res.status(200).json({ message: "getMyInsuranceProfile", data });
  },
);

const objectIdField = z
  .string()
  .refine((val) => isValidObjectId(val), { message: "invalid id" });

// Org-account profile editor (2026-09), mirroring
// hospitalController.updateMyHospitalProfile - only covers Models/Insurance.ts's
// own fields (no province/city/district refs there, unlike Hospital/Clinic -
// just a plain `address` string + `location` point).
const updateMyInsuranceProfileSchema = z.strictObject({
  name: z.string().trim().min(1).optional(),
  image: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  location: isPoint.optional(),
  category: objectIdField.optional(),
  tags: z.array(objectIdField).optional(),
  establishment: z.string().optional(),
  membersCount: z.string().optional(),
  website: z.string().optional(),
  summary: z.string().optional(),
  coverages: z.array(z.string()).optional(),
  advantages: z.array(z.string()).optional(),
});
export const updateMyInsuranceProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const { data, success, error } =
      await updateMyInsuranceProfileSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError(error.message));
    const payload: Record<string, unknown> = { ...data };
    if (data.location)
      payload.location = { type: "Point", coordinates: data.location };
    if (data.category) {
      const exists = await InsuranceCategory.exists({
        _id: data.category,
        isActive: true,
      });
      if (!exists) return next(new NotFoundError("دسته بندی"));
    }
    if (data.tags) {
      const uniqueIds = new Set(data.tags);
      if (uniqueIds.size !== data.tags.length)
        return next(new BadInputError());
      const count = await InsuranceTag.countDocuments({
        _id: { $in: data.tags },
        isActive: true,
      });
      if (count !== data.tags.length) return next(new NotFoundError("تگ"));
    }
    await Insurance.findByIdAndUpdate(req.insurance._id, payload);
    res.status(200).json({ message: "updateMyInsuranceProfile" });
  },
);

// Insurance-facing license catalog + purchase (2026-09) - lets an insurance
// buy one of the admin-managed BaseInsuranceLicense tiers, unlocking the
// dashboard modules that tier grants. Mirrors
// hospitalController.getMyLicenseOverview/purchaseLicense/
// resolveMyLicenseModules/requireLicenseModule/getMyLicenseModules. See
// Models/BaseInsuranceLicense.ts (the catalog) and
// Models/InsuranceProfileLicense.ts (the insurance's own current license
// record, one per insurance).
const findReferencedDurations = (licenses: Parameters<typeof licenseDurationsOf>[0]) =>
  licenseDurationsOf(licenses);

// Main license page (2026-09) - the "primary" plan lineup: isActive AND
// isPrimary, sorted by order. `details` (the rich-text plan writeup) is left
// off every list entry - see getLicenseById for the single-plan fetch that
// includes it.
export const getMyLicenseOverview: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const licenses = await BaseInsuranceLicense.find({
      isActive: true,
      isPrimary: true,
    })
      .sort({ order: 1 })
      .select("-details");
    const durations = await findReferencedDurations(licenses);
    res.status(200).json({
      message: "getMyLicenseOverview",
      data: { licenses, durations },
    });
  },
);

// "See all plans" page (2026-09) - every isActive plan regardless of
// isPrimary, sorted by order. Same details-omission and duration-list
// treatment as getMyLicenseOverview above.
export const getActiveLicenses: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const licenses = await BaseInsuranceLicense.find({ isActive: true })
      .sort({ order: 1 })
      .select("-details");
    const durations = await findReferencedDurations(licenses);
    res.status(200).json({
      message: "getActiveLicenses",
      // `modules` here is the full insuranceDashboardModules enum, not just
      // whatever the returned licenses' own `modules[]` happen to include -
      // lets the "see all plans" page render a full plan-vs-module
      // comparison.
      data: { licenses, durations, modules: insuranceDashboardModules },
    });
  },
);

// Single-plan fetch (2026-09) for a plan-detail page - returns the full
// BaseInsuranceLicense document (details included, unlike the list endpoints
// above) with each pricing entry's duration populated inline, since there's
// only one document here to enrich.
export const getLicenseById: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const license = await BaseInsuranceLicense.findById(nodeId);
    if (!license) return next(new NotFoundError());
    res.status(200).json({ message: "getLicenseById", data: license });
  },
);

// Dashboard-home widget fetch (2026-09) - the insurance's own currently
// assigned InsuranceProfileLicense (if any), plus whether it's expired.
// Unlike resolveMyLicenseModules below (which silently falls back to the
// isDefault tier's modules on expiry, for gating purposes), the widget needs
// the raw record and expiry state directly so it can show "no license" /
// "expired" rather than pretending the fallback tier was actually purchased.
export const getMyCurrentLicense: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const current = await InsuranceProfileLicense.findOne({
      owner: req.insurance._id,
    });
    const isExpired = isLicenseExpired(current);
    res.status(200).json({
      message: "getMyCurrentLicense",
      data: { current, isExpired },
    });
  },
);

const purchaseLicenseSchema = z.strictObject({
  // the period of the chosen price option, in days
  duration: z.coerce.number().int().min(1),
});

export const purchaseLicense: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance || !req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data: input, success } = await purchaseLicenseSchema.safeParseAsync(
      req.body,
    );
    if (!success)
      return next(new BadInputError());
    const license = await BaseInsuranceLicense.findById(nodeId);
    // an inactive plan is not for sale even by direct id
    if (!license || !license.isActive) return next(new NotFoundError());

    // An insurance with an active (non-expired) ProfileLicense can't buy
    // another plan until it expires (2026-09) - avoids double-charging and
    // silently clobbering time still left on the current plan. Same expiry
    // check getMyCurrentLicense/resolveMyLicenseModules use.
    const existingLicense = await InsuranceProfileLicense.findOne({
      owner: req.insurance._id,
    });
    const hasActiveLicense = isLicenseActive(existingLicense);
    if (hasActiveLicense) return next(new ActiveLicenseExistsError());

    // the period is part of the plan's own price option (days); only an
    // active option is for sale
    const pricingOption = findActivePricing(license.pricing, input.duration);
    if (!pricingOption) return next(new BadInputError());

    const price = Math.max(
      0,
      (pricingOption.price || 0) - (pricingOption.discount || 0),
    );

    if (price > 0) {
      // one atomic step: debit only if the balance covers it (a separate
      // read-check-then-decrement let two requests both pass the check)
      await Wallet.updateOne(
        { user: req.user._id },
        { $setOnInsert: { user: req.user._id } },
        { upsert: true },
      );
      const debited = await Wallet.findOneAndUpdate(
        { user: req.user._id, balance: { $gte: price } },
        { $inc: { balance: -price } },
        { new: true },
      );
      if (!debited)
        return next(new AppError("موجودی کیف پول شما کافی نیست", 400));
    }

    // The active-license check above guarantees there's no unexpired period
    // left to clobber here, so this always starts a fresh
    // startedAt/expiresAt window from now (upsert also covers the
    // never-purchased-before case).
    const startedAt = new Date();
    const expiresAt = new Date(
      startedAt.getTime() + pricingOption.days * 24 * 60 * 60 * 1000,
    );

    const data = await InsuranceProfileLicense.findOneAndUpdate(
      { owner: req.insurance._id },
      {
        owner: req.insurance._id,
        displayName: license.displayName,
        modules: license.modules,
        baseLicense: license._id,
        startedAt,
        expiresAt,
      },
      { upsert: true, new: true },
    );

    if (price > 0) {
      await Transaction.create({
        user: req.user._id,
        amount: -price,
        insurance: req.insurance._id,
        insuranceLicense: license._id,
      });
    }

    notifyLicensePurchased("insurance", req.user._id, license.displayName, expiresAt);
    res.status(200).json({ message: "purchaseLicense", data });
  },
);

// Resolves which dashboard modules an insurance currently has access to
// (2026-09), shared by requireLicenseModule (single-module gate on a route)
// and getMyLicenseModules (the full resolved set, for the frontend to gate
// whole pages with).
//
// Resolution order:
//  1. If this insurance already has an InsuranceProfileLicense AND it isn't
//     expired (expiresAt unset, or still in the future - see
//     insuranceController.purchaseLicense for how expiresAt gets set),
//     that record's `modules` is authoritative.
//  2. Otherwise (no record, or an expired one) fall back to whichever
//     BaseInsuranceLicense tier has `isDefault: true` (at most one is
//     expected, per that field's own comment) - an insurance who never
//     purchased anything, or whose purchase lapsed, is treated as being on
//     the default tier.
//  3. If no BaseInsuranceLicense is marked default either, there is nothing
//     to gate against, so every module is considered allowed.
const resolveMyLicenseModules = async (
  insuranceId: unknown,
): Promise<InsuranceDashboardModule[]> => {
  const current = await InsuranceProfileLicense.findOne({
    owner: insuranceId,
  });
  const isExpired = isLicenseExpired(current);
  if (current && !isExpired) return current.modules;

  const defaultLicense = await BaseInsuranceLicense.findOne({
    isDefault: true,
  });
  if (!defaultLicense) return [...insuranceDashboardModules];
  return defaultLicense.modules;
};

// Gates a route behind a dashboard module the insurance's license must
// grant. Meant to sit after aclController.useInsurance(...) in a route's
// middleware chain, same as any other req.insurance-dependent check here.
export const requireLicenseModule = (
  mod: InsuranceDashboardModule,
): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const modules = await resolveMyLicenseModules(req.insurance._id);
    if (!modules.includes(mod)) return next(new AccessError());
    next();
  });

// Insurance-facing resolved module list (2026-09) - lets the frontend gate
// an entire page with a friendly notice instead of letting the underlying
// API calls fail with AccessError. Deliberately not gated by any specific
// action - every insurance-context request, owner or delegated secretary,
// needs this to know what it can show.
export const getMyLicenseModules: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const data = await resolveMyLicenseModules(req.insurance._id);
    res.status(200).json({ message: "getMyLicenseModules", data });
  },
);
