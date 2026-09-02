import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  AccessError,
  BadInputError,
  MiddlewareError,
  MissingTaminTokenError,
  NotFoundError,
  TaminRideError,
} from "../Lib/AppError";
import Clinic from "../Models/Clinic";
import * as z from "zod";
import { isValidObjectId } from "mongoose";
import BecomeClinicRequest from "../Models/BecomeClinicRequest";
import ClinicTaminToken from "../Models/ClinicTaminToken";
import { boolish, createCodeVerifier, isPoint, numerish, toCodeChallenge } from "../Lib/helpers";
import makeTaminRequest from "../Lib/MakeTamjinRequest";
import TaminSpec from "../Models/TaminSpec";
import Province from "../Models/Geo/Province";
import City from "../Models/Geo/City";
import District from "../Models/Geo/District";
import ClinicTag from "../Models/ClinicTag";
import ClinicCategory from "../Models/ClinicCategory";
import Insurance from "../Models/Insurance";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import BaseClinicLicense, {
  clinicDashboardModules,
  ClinicDashboardModule,
} from "../Models/BaseClinicLicense";
import ClinicProfileLicense from "../Models/ClinicProfileLicense";

const becomeClinicRequestSchema = z.strictObject({ name: z.string() });
export const becomeAClinic: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await becomeClinicRequestSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const cur = await Clinic.findOne({ user: req.user._id });
    if (!!cur) return next(new AppError("شما قبلا کلینیک شده اید", 409));
    const pending = await BecomeClinicRequest.findOne({
      user: req.user._id,
      status: "Pending",
    });
    if (pending) return next(new AppError("درخواست شما قبلا ثبت شده است", 409));
    await BecomeClinicRequest.findOneAndUpdate(
      { user: req.user._id },
      {
        ...data,
        user: req.user._id,
        status: "Pending",
      },
      { upsert: true },
    );
    res.status(200).json({ message: "becomeAClinic" });
  },
);

export const getMyBecomeClinicRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await BecomeClinicRequest.findOne({ user: req.user._id });
    res.status(200).json({ message: "getMyBecomeClinicRequest", data });
  },
);

export const getMyClinicProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.clinic) return next(new MiddlewareError());
    const data = await Clinic.findById(req.clinic._id);
    if (!data) return next(new AccessError());
    res.status(200).json({ message: "getMyClinicProfile", data });
  },
);

const objectIdField = z
  .string()
  .refine((val) => isValidObjectId(val), { message: "invalid id" });

const updateMyClinicProfileSchema = z.strictObject({
  name: z.string().optional(),
  image: z.string().optional(),
  description: z.string().optional(),
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
export const updateMyClinicProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.clinic) return next(new MiddlewareError());
    const { data, success, error } =
      await updateMyClinicProfileSchema.safeParseAsync(req.body);
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
      const exists = await ClinicCategory.exists({
        _id: data.category,
        isActive: true,
      });
      if (!exists) return next(new NotFoundError("دسته بندی"));
    }
    if (data.tags) {
      const uniqueIds = new Set(data.tags);
      if (uniqueIds.size !== data.tags.length)
        return next(new BadInputError());
      const count = await ClinicTag.countDocuments({
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
    await Clinic.findByIdAndUpdate(req.clinic._id, payload);
    res.status(200).json({ message: "updateMyClinicProfile" });
  },
);

export const getPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    res.status(200).json({ message: "getPrescription" });
  },
);

export const getTaminSpecs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await TaminSpec.find();
    res.status(200).json({ message: "getTaminSpecs", data });
  },
);

export const getClinicTaminToken: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.clinic) return next(new MiddlewareError());
    const data = await ClinicTaminToken.findOneAndUpdate(
      { clinic: req.clinic._id },
      { clinic: req.clinic._id },
      { upsert: true, new: true },
    );
    res
      .status(200)
      .json({ message: "getClinicTaminToken", data: data.tokenRefreshedAt });
  },
);

export const checkTaminClinicToken: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.clinic) return next(new MiddlewareError());
    const cred = await ClinicTaminToken.findOneAndUpdate(
      { clinic: req.clinic._id },
      {
        clinic: req.clinic._id,
      },
      { upsert: true, new: true },
    );
    const verifier = createCodeVerifier();
    const challenge = await toCodeChallenge(verifier);
    await ClinicTaminToken.findByIdAndUpdate(cred._id, { verifier, challenge });
    res
      .status(200)
      .json({ message: "getTaminClinicToken", data: { challenge } });
  },
);

const clinicTaminCbSchema = z.strictObject({ code: z.string() });
export const clinicTaminCallback: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.clinic) return next(new MiddlewareError());
    const { data, success } = await clinicTaminCbSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const cred = await ClinicTaminToken.findOneAndUpdate(
      { clinic: req.clinic._id },
      { clinic: req.clinic._id },
      { upsert: true, new: true },
    );
    if (!cred.verifier)
      return next(new AppError("مشکلی پیش آمده لطفا دوباره سعی کنید", 400));
    const { code } = data;
    const response = await fetch(
      "https://account-pilot.tamin.ir/auth/server/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          redirect_uri: "http://localhost/tamin",
          grant_type: "authorization_code",
          client_id: "portal-js",
          code,
          code_verifier: cred.verifier,
        }).toString(),
      },
    );
    if (!response.headers.get("content-type")?.includes("json")) {
      console.log("tamin Reposnse Not JSON");
      console.log(await response.text());
      return next(new AppError("جواب دریافتی از سامانه معتبر نیود", 400));
    }
    const resData = await response.json();
    if (!resData.access_token)
      return next(new AppError("جواب دریافتی از سامانه معتبر نبود", 400));
    await ClinicTaminToken.findByIdAndUpdate(cred._id, {
      token: resData.access_token,
      tokenRefreshedAt: new Date(),
    });
    res.status(200).json({ message: "clinicTaminCallback" });
  },
);

// ("https://ep-test.tamin.ir/api/v2/SendEpresc");
const getPrescriptionsSchema = z.strictObject({
  nationalCode: z.string(),
  trackingCode: z.string(),
});
export const getPrescriptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.clinic) return next(new MiddlewareError());
    const { data, success } = await getPrescriptionsSchema.safeParseAsync(
      req.body,
    );
    const cred = await ClinicTaminToken.findOneAndUpdate(
      { clinic: req.clinic._id },
      { clinic: req.clinic._id },
      { upsert: true, new: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());
    if (!success) return next(new BadInputError());
    // https://darmanapi.tamin.ir/api/ParaClinic/ParaEPresc/RequestList
    const response = await makeTaminRequest({
      path: `https://darmanapi.tamin.ir/api/ParaClinic/ParaEPresc/RequestList?patientNationalCode=1234567891&trackingCode=${data.trackingCode}&parID=0000007303`,
      method: "GET",
      token: cred.token,
    });
    if (!response.headers.get("Content-Type")?.includes("json")) {
      console.log(await response.text());
      return next(new TaminRideError());
    }
    const responseData = await response.json();
    console.log(responseData);
    res
      .status(200)
      .json({ message: "getPrescriptions", data: responseData.data.list });
  },
);

//  "userInformation": {
//  "parID": "0000007303",
//  "nationalCode": "1234567891",
//  "clientIp": "string"
//  },
//  "eprsC_ID": 140015650,
//  "partypecode": "07",
//  "nationalcode": "1234567891",
//  "doC_MDID": "2000200092",
//  "tecH_MDID": "",
//  "patienT_MOBILE": "",
//  "asnad": false,
//  "details": [
//  {
//  "paR_TAREF_CODE": "039693-700",
//  "requesT_QTY": 1,
//  "iS2K": false
//  }

const submitTaminClinicPrescriptionSchema = z.strictObject({
  taminPrescripptionId: z.number(),
  parTypeCode: z.string(),
  techMDID: z.string().optional(),
  patientMobile: z.string().optional(),
  asnad: z.boolean().optional(),
  details: z.array(
    z.strictObject({
      parTarefCode: z.string(),
      requestQty: z.number(),
      is2K: z.boolean(),
    }),
  ),
});

export const submitTaminClinicPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.clinic) return next(new MiddlewareError());
    console.log(req.body);
    const { data, success, error } =
      await submitTaminClinicPrescriptionSchema.safeParseAsync(req.body);
    if (!success) {
      console.log(error);
      return next(new BadInputError());
    }
    const cred = await ClinicTaminToken.findOneAndUpdate(
      { clinic: req.clinic._id },
      { clinic: req.clinic._id },
      { upsert: true, new: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: "https://darmanapi.tamin.ir/api/ParaClinic/ParaEPresc/RequestParPresc",
      method: "POST",
      token: cred.token,
      payload: {
        userInformation: {
          parID: "0000007303",
          nationalCode: "1234567891",
        },
        eprsC_ID: data.taminPrescripptionId,
        partypecode: data.parTypeCode,
        nationalcode: "1234567891",
        doC_MDID: "2000200092",
        tecH_MDID: data.techMDID || "",
        patienT_MOBILE: data.patientMobile || "",
        asnad: !!data.asnad,
        details: data.details,
      },
    });
    if (!response.headers.get("Content-Type")?.includes("json")) {
      console.log(await response.text());
      return next(new TaminRideError());
    }
    const responseData = await response.json();
    console.log(responseData);
    if (responseData.data.hasError) {
      console.log(responseData.data.problems);
      return next(
        new AppError(
          responseData.data.problems[0]?.complemantary_Msg ||
            "خطا در عملیات تامین",
          400,
        ),
      );
    }
    res
      .status(200)
      .json({ message: "submitTaminClinicPrescription", data: responseData });
  },
);

// Clinic-facing license catalog + purchase (2026-09) - lets a clinic buy one
// of the admin-managed BaseClinicLicense tiers, unlocking the dashboard
// modules that tier grants. Mirrors
// doctorController.getMyLicenseOverview/purchaseLicense/
// resolveMyLicenseModules/requireLicenseModule/getMyLicenseModules (and the
// pharmacy version of the same). See Models/BaseClinicLicense.ts (the
// catalog) and Models/ClinicProfileLicense.ts (the clinic's own current
// license record, one per clinic).
export const getMyLicenseOverview: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.clinic) return next(new MiddlewareError());
    const catalog = await BaseClinicLicense.find().sort({ order: 1 });
    const current = await ClinicProfileLicense.findOne({
      owner: req.clinic._id,
    });
    res.status(200).json({
      message: "getMyLicenseOverview",
      data: { catalog, current },
    });
  },
);

const purchaseLicenseSchema = z.strictObject({
  period: z.enum(["monthly", "annual"]),
});

export const purchaseLicense: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.clinic || !req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data: input, success } = await purchaseLicenseSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const license = await BaseClinicLicense.findById(nodeId);
    if (!license) return next(new NotFoundError());

    const price =
      input.period === "monthly"
        ? Math.max(0, (license.monthlyPrice || 0) - (license.monthlyDiscount || 0))
        : Math.max(0, (license.annualPrice || 0) - (license.annualDiscount || 0));

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

    const data = await ClinicProfileLicense.findOneAndUpdate(
      { owner: req.clinic._id },
      {
        owner: req.clinic._id,
        displayName: license.displayName,
        modules: license.modules,
      },
      { upsert: true, new: true },
    );

    if (price > 0) {
      await Transaction.create({
        user: req.user._id,
        amount: -price,
        clinic: req.clinic._id,
        clinicLicense: license._id,
      });
    }

    res.status(200).json({ message: "purchaseLicense", data });
  },
);

// Resolves which dashboard modules a clinic currently has access to
// (2026-09), shared by requireLicenseModule (single-module gate on a route)
// and getMyLicenseModules (the full resolved set, for the frontend to gate
// whole pages with).
//
// Resolution order:
//  1. If this clinic already has a ClinicProfileLicense, that record's
//     `modules` is authoritative.
//  2. Otherwise, fall back to whichever BaseClinicLicense tier has
//     `isDefault: true` (at most one is expected, per that field's own
//     comment) - a clinic who never purchased anything is treated as being
//     on the default tier.
//  3. If no BaseClinicLicense is marked default either, there is nothing to
//     gate against, so every module is considered allowed.
const resolveMyLicenseModules = async (
  clinicId: unknown,
): Promise<ClinicDashboardModule[]> => {
  const current = await ClinicProfileLicense.findOne({ owner: clinicId });
  if (current) return current.modules;

  const defaultLicense = await BaseClinicLicense.findOne({
    isDefault: true,
  });
  if (!defaultLicense) return [...clinicDashboardModules];
  return defaultLicense.modules;
};

// Gates a route behind a dashboard module the clinic's license must grant.
// Meant to sit after aclController.useClinic(...) in a route's middleware
// chain, same as any other req.clinic-dependent check here.
export const requireLicenseModule = (
  mod: ClinicDashboardModule,
): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.clinic) return next(new MiddlewareError());
    const modules = await resolveMyLicenseModules(req.clinic._id);
    if (!modules.includes(mod)) return next(new AccessError());
    next();
  });

// Clinic-facing resolved module list (2026-09) - lets the frontend gate an
// entire page with a friendly notice instead of letting the underlying API
// calls fail with AccessError. Deliberately not gated by any specific
// action - every clinic-context request, owner or delegated secretary,
// needs this to know what it can show.
export const getMyLicenseModules: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.clinic) return next(new MiddlewareError());
    const data = await resolveMyLicenseModules(req.clinic._id);
    res.status(200).json({ message: "getMyLicenseModules", data });
  },
);
