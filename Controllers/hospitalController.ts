import { NextFunction, Request, RequestHandler, Response } from "express";
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
import LicenseDuration from "../Models/LicenseDuration";

const becomeHospitalRequestSchema = z.strictObject({
  name: z.string(),
  siamCode: z.string(),
  nationalId: z.string(),
  certificateDate: z.coerce.date(),
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
    const cur = await Hospital.findOne({ user: req.user._id });
    if (!!cur) return next(new AppError("شما قبلا بیمارستان شده اید", 409));
    const pending = await BecomeHospitalRequest.findOne({
      user: req.user._id,
      status: "Pending",
    });
    if (pending) return next(new AppError("درخواست شما قبلا ثبت شده است", 409));
    const becomeHospitalRequest = await BecomeHospitalRequest.findOneAndUpdate(
      { user: req.user._id },
      {
        ...data,
        user: req.user._id,
        status: "Pending",
      },
      { upsert: true, new: true },
    );
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
    const data = await BecomeHospitalRequest.findOne({ user: req.user._id });
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
  name: z.string().optional(),
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
  establishment: z.string().optional(),
  website: z.string().optional(),
  mail: z.string().optional(),
  businessTimes: z.string().optional(),
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
      const exists = await City.exists({ _id: data.city, isActive: true });
      if (!exists) return next(new NotFoundError("شهر"));
    }
    if (data.district) {
      const exists = await District.exists({
        _id: data.district,
        isActive: true,
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
    if (data.insurances) {
      const uniqueIds = new Set(data.insurances);
      if (uniqueIds.size !== data.insurances.length)
        return next(new BadInputError());
      const count = await Insurance.countDocuments({
        _id: { $in: data.insurances },
        active: true,
      });
      if (count !== data.insurances.length)
        return next(new NotFoundError("بیمه"));
    }
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
// Collects the distinct LicenseDuration docs referenced by at least one
// pricing entry across the given licenses, sorted by their own `order` -
// shared by getMyLicenseOverview and getActiveLicenses below so the
// frontend gets a ready-to-use duration filter alongside the plan list
// instead of populating the (possibly repeated) duration on every single
// pricing entry.
const findReferencedDurations = async (
  licenses: { pricing: { duration: unknown }[] }[],
) => {
  const durationIds = Array.from(
    new Set(licenses.flatMap((license) => license.pricing.map((p) => `${p.duration}`))),
  );
  return LicenseDuration.find({ _id: { $in: durationIds } }).sort({
    order: 1,
  });
};

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
    const license = await BaseHospitalLicense.findById(nodeId).populate(
      "pricing.duration",
    );
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
    const isExpired = !!current?.expiresAt && current.expiresAt < new Date();
    res.status(200).json({
      message: "getMyCurrentLicense",
      data: { current, isExpired },
    });
  },
);

const purchaseLicenseSchema = z.strictObject({
  duration: z.string(),
});

export const purchaseLicense: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.hospital || !req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data: input, success } = await purchaseLicenseSchema.safeParseAsync(
      req.body,
    );
    if (!success || !isValidObjectId(input.duration))
      return next(new BadInputError());
    const license = await BaseHospitalLicense.findById(nodeId);
    if (!license) return next(new NotFoundError());

    // A hospital with an active (non-expired) ProfileLicense can't buy
    // another plan until it expires (2026-09) - avoids double-charging and
    // silently clobbering time still left on the current plan. Same
    // expiry check getMyCurrentLicense/resolveMyLicenseModules use.
    const existingLicense = await HospitalProfileLicense.findOne({
      owner: req.hospital._id,
    });
    const hasActiveLicense =
      !!existingLicense?.expiresAt && existingLicense.expiresAt > new Date();
    if (hasActiveLicense) return next(new ActiveLicenseExistsError());

    // Pricing is keyed by LicenseDuration (2026-09, replacing the old
    // monthly/annual period toggle) - only an active pricing option for the
    // requested duration can be purchased.
    const pricingOption = license.pricing.find(
      (p) => p.duration.toString() === input.duration && p.isActive,
    );
    if (!pricingOption) return next(new BadInputError());

    const durationDoc = await LicenseDuration.findById(input.duration);
    if (!durationDoc) return next(new BadInputError());

    const price = Math.max(
      0,
      (pricingOption.price || 0) - (pricingOption.discount || 0),
    );

    if (price > 0) {
      const wallet = await Wallet.findOneAndUpdate(
        { user: req.user._id },
        { user: req.user._id },
        { upsert: true, new: true },
      );
      if (wallet.balance < price)
        return next(new AppError("موجودی کیف پول شما کافی نیست", 400));
      await Wallet.findByIdAndUpdate(wallet._id, {
        $inc: { balance: -price },
      });
    }

    // The active-license check above guarantees there's no unexpired
    // period left to clobber here, so this always starts a fresh
    // startedAt/expiresAt window from now (upsert also covers the
    // never-purchased-before case).
    const startedAt = new Date();
    const expiresAt = new Date(
      startedAt.getTime() + durationDoc.duration * 24 * 60 * 60 * 1000,
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

    if (price > 0) {
      await Transaction.create({
        user: req.user._id,
        amount: -price,
        hospital: req.hospital._id,
        hospitalLicense: license._id,
      });
    }

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
//  3. If no BaseHospitalLicense is marked default either, there is nothing to
//     gate against, so every module is considered allowed.
const resolveMyLicenseModules = async (
  hospitalId: unknown,
): Promise<HospitalDashboardModule[]> => {
  const current = await HospitalProfileLicense.findOne({ owner: hospitalId });
  const isExpired = !!current?.expiresAt && current.expiresAt < new Date();
  if (current && !isExpired) return current.modules;

  const defaultLicense = await BaseHospitalLicense.findOne({
    isDefault: true,
  });
  if (!defaultLicense) return [...hospitalDashboardModules];
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
