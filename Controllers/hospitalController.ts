import { normalizeOpeningHours } from "../Lib/openingHours";
import { licenceDatesProblem, requestLicenceDay } from "../Lib/centreLicenceDates";
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
import Hospital from "../Models/Hospital";
import * as z from "zod";
import { isValidObjectId } from "mongoose";
import BecomeHospitalRequest from "../Models/BecomeHospitalRequest";
import { notifyUserAlertSubscribers } from "../Services/userAlertService";
import { boolish, isPoint, numerish } from "../Lib/helpers";
import Province from "../Models/Geo/Province";
import City from "../Models/Geo/City";
import District from "../Models/Geo/District";
import HospitalTag from "../Models/HospitalTag";
import HospitalCategory from "../Models/HospitalCategory";
import Insurance from "../Models/Insurance";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import BaseHospitalLicense, {
  hospitalDashboardModules,
  HospitalDashboardModule,
} from "../Models/BaseHospitalLicense";
import HospitalProfileLicense from "../Models/HospitalProfileLicense";
import { findActivePricing, licenseDurationsOf } from "../Lib/licensePricing";
import { chargeLicensePurchaseFrom, quoteLicensePurchase, recordLicensePurchase } from "../Lib/licenseQuote";
import { centreScope, scopeTxFields } from "../Lib/walletScope";
import { minimalModules } from "../Lib/licenseTiers";

const becomeHospitalRequestSchema = z.strictObject({
  name: z.string().trim().min(1),
  siamCode: z.string(),
  nationalId: z.string(),
  certificateDate: z.coerce.date(),
  // the licence's expiry (2026-10): required, checked below with a
  // message of its own
  certificateExpiresAt: z.coerce.date().optional(),
  certificateFile: z.string().optional(),
  description: z.string().optional(),
});
export const becomeAHospital: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await becomeHospitalRequestSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    // the licence's dates: the expiry a later Tehran day than today, the
    // issue date not in the future and before it (Lib/centreLicenceDates.ts)
    const datesProblem = licenceDatesProblem(data.certificateDate, data.certificateExpiresAt);
    if (datesProblem) return next(new AppError(datesProblem, 400));
    data.certificateDate = requestLicenceDay(data.certificateDate) || data.certificateDate;
    data.certificateExpiresAt = requestLicenceDay(data.certificateExpiresAt) || undefined;
    // an owner may ask for another hospital (2026-10, one account can own
    // several; Lib/activeCentre.ts): each centre is its own request, and the
    // approval makes a new centre. Only an open request blocks a new one.
    const pending = await BecomeHospitalRequest.exists({
      user: req.user._id,
      status: "Pending",
    });
    if (pending) return next(new AppError("درخواست شما قبلا ثبت شده است", 409));
    // a declined request is sent again on its own row (an approved one
    // stays as it was: it is the record of a centre that exists)
    const rejected = await BecomeHospitalRequest.findOne({
      user: req.user._id,
      status: "Rejected",
    }).sort({ updatedAt: -1 });
    const becomeHospitalRequest = rejected
      ? await BecomeHospitalRequest.findByIdAndUpdate(
          rejected._id,
          {
            $set: { ...data, status: "Pending" },
            // a resubmitted request is a fresh one: the old decision goes
            $unset: { rejectReason: 1, decidedAt: 1 },
          },
          { new: true },
        )
      : await BecomeHospitalRequest.create({ ...data, user: req.user._id, status: "Pending" });
    if (!becomeHospitalRequest) return next(new NotFoundError());
    notifyUserAlertSubscribers(
      "newBecomeHospitalRequest",
      {
        title: "درخواست بیمارستان شدن",
        message: `کاربر ${req.user.phone} درخواست بیمارستان شدن ثبت کرد.`,
      },
      {
        requestId: becomeHospitalRequest._id.toString(),
        userPhone: req.user.phone,
      },
    ).catch((err) =>
      console.log(
        `[hospitalController] failed to notify staff of becomeHospital request by ${req.user?._id}:`,
        err,
      ),
    );
    res.status(200).json({ message: "becomeAHospital" });
  },
);

export const getMyBecomeHospitalRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    // the latest one (an owner of several centres has one per centre)
    const data = await BecomeHospitalRequest.findOne({ user: req.user._id }).sort({ createdAt: -1 });
    res.status(200).json({ message: "getMyBecomeHospitalRequest", data });
  },
);

export const getMyHospitalProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.hospital) return next(new MiddlewareError());
    const data = await Hospital.findById(req.hospital._id);
    if (!data) return next(new AccessError());
    res.status(200).json({ message: "getMyHospitalProfile", data });
  },
);

const objectIdField = z
  .string()
  .refine((val) => isValidObjectId(val), { message: "invalid id" });

const updateMyHospitalProfileSchema = z.strictObject({
  name: z.string().trim().min(1).optional(),
  image: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  province: objectIdField.optional(),
  city: objectIdField.optional(),
  district: objectIdField.optional(),
  location: isPoint.optional(),
  category: objectIdField.optional(),
  tags: z.array(objectIdField).optional(),
  isRoundTheClock: boolish.optional(),
  insurances: z.array(objectIdField).optional(),
  personelCount: numerish(0, 1000000).optional(),
  // the hospital's beds (its card and page show them): the hospital's own
  // figure, not only the admin's
  bedCount: numerish(0, 100000).optional(),
  establishment: z.string().optional(),
  website: z.string().optional(),
  mail: z.string().optional(),
  businessTimes: z.string().optional(),
  // the structured week (2026-10, Lib/openingHours.ts): a JSON object;
  // null clears it. The free text above stays as a note.
  openingHours: z.unknown().optional(),
  services: z.array(z.string()).optional(),
  certificates: z.array(z.string()).optional(),
  summary: z.string().optional(),
});
export const updateMyHospitalProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.hospital) return next(new MiddlewareError());
    const { data, success, error } =
      await updateMyHospitalProfileSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError(error.message));
    const payload: Record<string, unknown> = { ...data };
    if (data.location)
      payload.location = { type: "Point", coordinates: data.location };
    if (data.province) {
      const exists = await Province.exists({
        _id: data.province,
        isActive: true,
      });
      if (!exists) return next(new NotFoundError("استان"));
    }
    if (data.city) {
      // the city must belong to the chosen province (and the district to
      // the city) - a Tehran district under Shiraz broke geo search
      const exists = await City.exists({
        _id: data.city,
        isActive: true,
        ...(data.province ? { province: data.province } : {}),
      });
      if (!exists) return next(new NotFoundError("شهر"));
    }
    if (data.district) {
      const exists = await District.exists({
        _id: data.district,
        isActive: true,
        ...(data.city ? { city: data.city } : {}),
      });
      if (!exists) return next(new NotFoundError("محله"));
    }
    if (data.category) {
      const exists = await HospitalCategory.exists({
        _id: data.category,
        isActive: true,
      });
      if (!exists) return next(new NotFoundError("دسته بندی"));
    }
    if (data.tags) {
      const uniqueIds = new Set(data.tags);
      if (uniqueIds.size !== data.tags.length)
        return next(new BadInputError());
      const count = await HospitalTag.countDocuments({
        _id: { $in: data.tags },
        isActive: true,
      });
      if (count !== data.tags.length) return next(new NotFoundError("تگ"));
    }
    // the accepted insurers are contracts the insurer confirms (2026-10,
    // /insurer-contract, Lib/insuranceContracts.ts): an old client's list
    // is ignored, not written one-sidedly
    delete payload.insurances;
    // a malformed week is a 400 (OpeningHoursError); the model keeps
    // isRoundTheClock in step with it
    if (data.openingHours !== undefined)
      payload.openingHours = normalizeOpeningHours(data.openingHours);
    await Hospital.findByIdAndUpdate(req.hospital._id, payload);
    res.status(200).json({ message: "updateMyHospitalProfile" });
  },
);

// Hospital-facing license catalog + purchase (2026-09) - lets a hospital buy one
// of the admin-managed BaseHospitalLicense tiers, unlocking the dashboard
// modules that tier grants. Mirrors
// doctorController.getMyLicenseOverview/purchaseLicense/
// resolveMyLicenseModules/requireLicenseModule/getMyLicenseModules (and the
// pharmacy version of the same). See Models/BaseHospitalLicense.ts (the
// catalog) and Models/HospitalProfileLicense.ts (the hospital's own current
// license record, one per hospital).
// The periods (days) the listed plans sell - the plan pages' period
// switcher (Lib/licensePricing.ts).
const findReferencedDurations = (licenses: Parameters<typeof licenseDurationsOf>[0]) =>
  licenseDurationsOf(licenses);

// Main license page (2026-09) - the "primary" plan lineup: isActive AND
// isPrimary, sorted by order. `details` (the rich-text plan writeup) is
// left off every list entry - see getLicenseById for the single-plan fetch
// that includes it.
export const getMyLicenseOverview: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.hospital) return next(new MiddlewareError());
    const licenses = await BaseHospitalLicense.find({
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
    if (!req.hospital) return next(new MiddlewareError());
    const licenses = await BaseHospitalLicense.find({ isActive: true })
      .sort({ order: 1 })
      .select("-details");
    const durations = await findReferencedDurations(licenses);
    res.status(200).json({
      message: "getActiveLicenses",
      // `modules` here is the full hospitalDashboardModules enum, not just
      // whatever the returned licenses' own `modules[]` happen to include -
      // lets the "see all plans" page render a full plan-vs-module
      // comparison.
      data: { licenses, durations, modules: hospitalDashboardModules },
    });
  },
);

// Single-plan fetch (2026-09) for a plan-detail page - returns the full
// BaseHospitalLicense document (details included, unlike the list endpoints
// above) with each pricing entry's duration populated inline, since
// there's only one document here to enrich.
export const getLicenseById: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.hospital) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const license = await BaseHospitalLicense.findById(nodeId);
    if (!license) return next(new NotFoundError());
    res.status(200).json({ message: "getLicenseById", data: license });
  },
);

// Dashboard-home widget fetch (2026-09) - the hospital's own currently
// assigned HospitalProfileLicense (if any), plus whether it's expired. Unlike
// resolveMyLicenseModules below (which silently falls back to the
// isDefault tier's modules on expiry, for gating purposes), the widget
// needs the raw record and expiry state directly so it can show "no
// license" / "expired" rather than pretending the fallback tier was
// actually purchased.
export const getMyCurrentLicense: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.hospital) return next(new MiddlewareError());
    const current = await HospitalProfileLicense.findOne({
      owner: req.hospital._id,
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
  // a promotion code (Models/LicensePromotion.ts), optional
  promoCode: z.string().max(40).optional(),
});

export const purchaseLicense: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.hospital || !req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data: input, success } = await purchaseLicenseSchema.safeParseAsync(
      req.body,
    );
    if (!success)
      return next(new BadInputError());
    const license = await BaseHospitalLicense.findById(nodeId);
    // an inactive plan is not for sale even by direct id
    if (!license || !license.isActive) return next(new NotFoundError());

    // A provider on a running plan may only upgrade to a higher plan,
    // credited for the unused days of the current one (2026-10, Lib/
    // licenseQuote.ts); a lower or equal plan waits until it ends.
    const existingLicense = await HospitalProfileLicense.findOne({
      owner: req.hospital._id,
    });

    // the period is part of the plan's own price option (days); only an
    // active option is for sale
    const pricingOption = findActivePricing(license.pricing, input.duration);
    if (!pricingOption) return next(new BadInputError());

    // one price rule for the panel, the pricing pages and the purchase:
    // the option's own discount, then the best running promotion; the
    // transaction below (hence the ledger and Moadian) carries this amount
    const quoted = await quoteLicensePurchase({
      kind: "hospital",
      plan: license,
      option: pricingOption,
      ownerId: req.hospital._id,
      code: input.promoCode,
      current: existingLicense,
    });
    if (quoted instanceof AppError) return next(quoted);
    const price = quoted.final;
    // claims the promotion use, then debits the wallet in one atomic step:
    // this hospital's own wallet (one wallet per centre, Lib/walletScope.ts),
    // or the owner's personal one when the centre's does not cover it
    const paidBy = await chargeLicensePurchaseFrom(centreScope("hospital", { _id: req.hospital._id, user: req.user._id }), quoted);
    if (paidBy instanceof AppError) return next(paidBy);

    // The new period starts now (an upgrade replaces the running one,
    // already credited above); upsert also covers a first purchase.
    const startedAt = new Date();
    const expiresAt = new Date(
      startedAt.getTime() + pricingOption.days * 24 * 60 * 60 * 1000,
    );

    const data = await HospitalProfileLicense.findOneAndUpdate(
      { owner: req.hospital._id },
      {
        owner: req.hospital._id,
        displayName: license.displayName,
        modules: license.modules,
        baseLicense: license._id,
        startedAt,
        expiresAt,
      },
      { upsert: true, new: true },
    );
    // the period's history (an upgrade ends the one it replaces)
    await recordLicensePurchase(quoted, req.user._id, { startedAt, expiresAt });

    if (price > 0) {
      await Transaction.create({
        user: req.user._id,
        amount: -price,
        hospital: req.hospital._id,
        hospitalLicense: license._id,
        ...(await scopeTxFields(paidBy)),
      });
    }

    notifyLicensePurchased("hospital", req.user._id, license.displayName, expiresAt);
    res.status(200).json({ message: "purchaseLicense", data });
  },
);

// Resolves which dashboard modules a hospital currently has access to
// (2026-09), shared by requireLicenseModule (single-module gate on a route)
// and getMyLicenseModules (the full resolved set, for the frontend to gate
// whole pages with).
//
// Resolution order:
//  1. If this hospital already has a HospitalProfileLicense AND it isn't
//     expired (expiresAt unset, or still in the future - see
//     hospitalController.purchaseLicense for how expiresAt gets set), that
//     record's `modules` is authoritative.
//  2. Otherwise (no record, or an expired one) fall back to whichever
//     BaseHospitalLicense tier has `isDefault: true` (at most one is
//     expected, per that field's own comment) - a hospital who never
//     purchased anything, or whose purchase lapsed, is treated as being on
//     the default tier.
//  3. If no BaseHospitalLicense is marked default either, only the free tier's bare
//     minimum (Lib/licenseTiers.ts minimalModules) is allowed (2026-10;
//     it used to open every module).
const resolveMyLicenseModules = async (
  hospitalId: unknown,
): Promise<HospitalDashboardModule[]> => {
  const current = await HospitalProfileLicense.findOne({ owner: hospitalId });
  const isExpired = isLicenseExpired(current);
  if (current && !isExpired) return current.modules;

  const defaultLicense = await BaseHospitalLicense.findOne({
    isDefault: true,
  });
  // no default plan: only the free tier's bare minimum, never every
  // module (Lib/licenseTiers.ts)
  if (!defaultLicense) return [...minimalModules.hospital] as HospitalDashboardModule[];
  return defaultLicense.modules;
};

// Gates a route behind a dashboard module the hospital's license must grant.
// Meant to sit after aclController.useHospital(...) in a route's middleware
// chain, same as any other req.hospital-dependent check here.
export const requireLicenseModule = (
  mod: HospitalDashboardModule,
): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.hospital) return next(new MiddlewareError());
    const modules = await resolveMyLicenseModules(req.hospital._id);
    if (!modules.includes(mod)) return next(new AccessError());
    next();
  });

// Hospital-facing resolved module list (2026-09) - lets the frontend gate an
// entire page with a friendly notice instead of letting the underlying API
// calls fail with AccessError. Deliberately not gated by any specific
// action - every hospital-context request, owner or delegated secretary,
// needs this to know what it can show.
export const getMyLicenseModules: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.hospital) return next(new MiddlewareError());
    const data = await resolveMyLicenseModules(req.hospital._id);
    res.status(200).json({ message: "getMyLicenseModules", data });
  },
);
