import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import * as z from "zod";
import { isValidObjectId, Types } from "mongoose";
import AppError, {
  AccessError,
  ActiveLicenseExistsError,
  BadInputError,
  MiddlewareError,
  MissingTaminTokenError,
  NotFoundError,
} from "../Lib/AppError";
import ParaClinic from "../Models/Paraclinic";
import BecomeParaClinicRequest from "../Models/BecomeParaClinicRequest";
import { notifyUserAlertSubscribers } from "../Services/userAlertService";
import DoctorTaminCred from "../Models/DoctorTaminCred";
import makeTaminRequest from "../Lib/MakeTamjinRequest";
import TaminIcid from "../Models/TaminIdid";
import ParaClinicTag from "../Models/ParaClinicTag";
import ParaClinicCategory from "../Models/ParaClinicCategory";
import Province from "../Models/Geo/Province";
import City from "../Models/Geo/City";
import District from "../Models/Geo/District";
import Insurance from "../Models/Insurance";
import { boolish, isPoint, numerish } from "../Lib/helpers";
import Test from "../Models/Test";
import ParaClinicTest from "../Models/ParaClinicTest";
import Order from "../Models/Order";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import BaseParaClinicLicense, {
  paraClinicDashboardModules,
  ParaClinicDashboardModule,
} from "../Models/BaseParaClinicLicense";
import ParaClinicProfileLicense from "../Models/ParaClinicProfileLicense";
import LicenseDuration from "../Models/LicenseDuration";

const becomeAParaClinicSchema = z.strictObject({
  name: z.string(),
  siamCode: z.string(),
  nationalId: z.string(),
  certificateDate: z.coerce.date(),
  certificateFile: z.string().optional(),
  description: z.string().optional(),
});
export const becomeAParaClinic: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success, error } =
      await becomeAParaClinicSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError(error.message));
    const cur = await ParaClinic.findOne({ user: req.user._id });
    if (!!cur) return next(new AppError("شما قبلا پاراکلینیک شده اید", 409));
    const pending = await BecomeParaClinicRequest.findOne({
      user: req.user._id,
      status: "Pending",
    });
    if (pending) return next(new AppError("درخواست شما قبلا ثبت شده است", 409));
    await BecomeParaClinicRequest.findOneAndUpdate(
      { user: req.user._id },
      {
        ...data,
        user: req.user._id,
        status: "Pending",
      },
      { upsert: true },
    );
    notifyUserAlertSubscribers("newBecomeParaClinicRequest", {
      title: "درخواست پاراکلینیک شدن",
      message: `کاربر ${req.user.phone} درخواست پاراکلینیک شدن ثبت کرد.`,
    }).catch((err) =>
      console.log(
        `[paraClinicController] failed to notify staff of becomeParaClinic request by ${req.user?._id}:`,
        err,
      ),
    );
    res.status(200).json({ message: "becomeAParaClinic" });
  },
);

export const getMyBecomeParaClinicRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await BecomeParaClinicRequest.findOne({ user: req.user._id });
    res.status(200).json({ message: "getMyBecomeParaClinicRequest", data });
  },
);

export const getMyParaClinicProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const data = await ParaClinic.findById(req.paraClinic._id);
    if (!data) return next(new AccessError());
    res.status(200).json({ message: "getMyParaClinicProfile", data });
  },
);

const objectIdField = z
  .string()
  .refine((val) => isValidObjectId(val), { message: "invalid id" });

const updateMyParaClinicProfileSchema = z.strictObject({
  name: z.string().optional(),
  tags: z.array(objectIdField).optional(),
  province: objectIdField.optional(),
  city: objectIdField.optional(),
  district: objectIdField.optional(),
  category: objectIdField.optional(),
  location: isPoint.optional(),
  image: z.string().optional(),
  establishment: z.string().optional(),
  businessTime: z.string().optional(),
  phone: z.string().optional(),
  onPremises: boolish.optional(),
  onlineResponse: boolish.optional(),
  basicInsurance: boolish.optional(),
  personelCount: numerish(0, 1000000).optional(),
  summary: z.string().optional(),
  insurances: z.array(objectIdField).optional(),
  address: z.string().optional(),
});
export const updateMyParaClinicProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const { data, success, error } =
      await updateMyParaClinicProfileSchema.safeParseAsync(req.body);
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
      const exists = await ParaClinicCategory.exists({
        _id: data.category,
        isActive: true,
      });
      if (!exists) return next(new NotFoundError("دسته بندی"));
    }
    if (data.tags) {
      const uniqueIds = new Set(data.tags);
      if (uniqueIds.size !== data.tags.length)
        return next(new BadInputError());
      const count = await ParaClinicTag.countDocuments({
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
    await ParaClinic.findByIdAndUpdate(req.paraClinic._id, payload);
    res.status(200).json({ message: "updateMyParaClinicProfile" });
  },
);

const getTaminPrescriptionSchema = z.strictObject({
  patientNationalCode: z.string(),
  trackingCode: z.string(),
});
export const getPrescs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const {
      data: input,
      success,
      error,
    } = await getTaminPrescriptionSchema.spa(req.body);
    if (!success) return next(new BadInputError(error.message));
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ap-test.tamin.ir/api/ParaClinic/ParaEPresc/RequestList?patientNationalCode=${input.patientNationalCode}&trackingCode=${input.trackingCode}&parID=0000007303`,
      method: "GET",
      token: cred.token,
    });
    const data = await response.json();
    res.status(200).json({ message: "getPrescs", data });
  },
);

export const precheckPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ap-test.tamin.ir/api/ParaClinic/ParaEPresc/PreCheckEPresc`,
      method: "POST",
      token: cred.token,
      payload: {
        userInformation: {
          parID: "0000007303",
        },
        ...req.body,
      },
    });
    const data = await response.json();
    res.status(200).json({ message: "precheckPrescription", data });
  },
);

export const submitPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ap-test.tamin.ir/api/ParaClinic/ParaEPresc/RequestParPresc${req.query.physio ? "_Physio" : ""}`,
      method: "POST",
      token: cred.token,
      payload: {
        userInformation: {
          parID: "0000007303",
          nationalCode: "1234567891",
          clientIp: "",
        },
        nationalcode: "1234567891",
        doC_MDID: "2000200092",
        tecH_MDID: "",
        patienT_MOBILE: "",
        asnad: false,
        ...req.body,
        // eprsC_ID: 140033944,
        // partypecode: "02",
        // details: [
        //   {
        //     paR_TAREF_CODE: "018262-600",
        //     tareF_PRICE: 316100,
        //     requesT_QTY: 1,
        //     iS2K: false,
        //   },
        // ],
      },
    });
    const data = await response.json();
    res.status(200).json({ message: "submitPrescription", data });
  },
);

const getPrescriptionSchema = z.strictObject({ requestID: z.string() });
export const getPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const {
      data: input,
      success,
      error,
    } = await getPrescriptionSchema.spa(req.body);
    if (!success) return next(new BadInputError(error.message));
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ap-test.tamin.ir/api/ParaClinic/ParaEPresc/RequestByRegisterID?parID=0000007303&requestID=${input.requestID}`,
      method: "GET",
      token: cred.token,
    });
    const data = await response.json();
    res.status(200).json({ message: "getPrescription", data });
  },
);

export const deletePrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ap-test.tamin.ir/api/ParaClinic/ParaEPresc/DeleteParPresc`,
      method: "POST",
      token: cred.token,
      payload: {
        userInformation: {
          parID: "0000007303",
        },
        ...req.body,
      },
    });
    const data = await response.json();
    res.status(200).json({ message: "deletePrescription", data });
  },
);

export const getIcids: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await TaminIcid.find();
    res.status(200).json({ message: "getIcids", data: { data } });
  },
);

export const registerDiagnosis: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ap-test.tamin.ir/api/ParaClinic/ParaEPresc/RegisterTheDiagnosis`,
      method: "POST",
      token: cred.token,
      payload: {
        userInformation: {
          parID: "0000007303",
        },
        ISNORMAL: false,
        ST_DOCID: "0000101575",
        ...req.body,
        // REGISTER_ID: "232018918",
        // COMMENT: "سیروز کبذ",
        // DIAGNOSISCODE: ["X46.48"],
      },
    });
    if (!response.ok) {
      console.log(await response.text());
    }
    const data = await response.json();
    res.status(200).json({ message: "registerDiagnosis", data });
  },
);

export const registerPhysioSession: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ap-test.tamin.ir/api/ParaClinic/ParaEPresc/RegisterSession_Physio`,
      method: "POST",
      token: cred.token,
      payload: req.body,
    });
    if (!response.ok) console.log(await response.text());
    const data = await response.json();
    res.status(200).json({ message: "registerPhysioSession", data });
  },
);

// ---- ParaClinic test management (ParaClinicTest) ----

// Tests the admin has made available, that this paraClinic hasn't added yet
export const getAvailableTests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const mine = await ParaClinicTest.find({
      paraClinic: req.paraClinic._id,
    }).distinct("test");
    const data = await Test.find({
      isActive: true,
      _id: { $nin: mine },
    }).populate({ path: "category" });
    res.status(200).json({ message: "getAvailableTests", data });
  },
);

// This paraClinic's own tests (its ParaClinicTest documents)
export const getMyTests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const data = await ParaClinicTest.find({
      paraClinic: req.paraClinic._id,
    }).populate({ path: "test", populate: { path: "category" } });
    res.status(200).json({ message: "getMyTests", data });
  },
);

// Incoming orders (2026-08) - orders placed by patients that include at
// least one of this paraClinic's tests. Mirrors
// pharmacyController.getMyIncomingOrders - see its comment for why each
// order is filtered down to just this paraClinic's own line items rather
// than exposing the whole order.

// Ids of the ParaClinicTest docs this paraClinic owns - used to both query
// for orders containing them and to filter/scope a matched order's tests
// array down to this paraClinic's own items.
const getMyIncomingOrderOwnedIds = async (paraClinicId: Types.ObjectId) => {
  const testIds = await ParaClinicTest.find({
    paraClinic: paraClinicId,
  }).distinct("_id");
  return { testIds, testIdStrings: testIds.map((id) => id.toString()) };
};

// Filters an order's tests down to just this paraClinic's own line items
// and computes a subtotal over them.
const scopeOrderToParaClinic = (
  order: InstanceType<typeof Order>,
  testIdStrings: string[],
) => {
  const tests = order.tests.filter((t) =>
    testIdStrings.includes((t.item as any)?._id?.toString()),
  );
  const subtotal = tests.reduce((sum, i) => sum + i.price * i.qty, 0);
  return {
    _id: order._id,
    user: order.user,
    submittedAt: order.submittedAt,
    status: order.status,
    tests,
    subtotal,
  };
};

const incomingOrderPopulate = [
  { path: "user", select: "username phone avatar" },
  {
    path: "tests",
    populate: { path: "item", populate: { path: "test" } },
  },
];

export const getMyIncomingOrders: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const { testIds, testIdStrings } = await getMyIncomingOrderOwnedIds(
      req.paraClinic._id,
    );
    const orders = await Order.find({
      "tests.item": { $in: testIds },
    })
      .sort({ submittedAt: -1 })
      .populate(incomingOrderPopulate);
    const data = orders.map((order) =>
      scopeOrderToParaClinic(order, testIdStrings),
    );
    res.status(200).json({ message: "getMyIncomingOrders", data });
  },
);

export const getMyIncomingOrder: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());

    const { testIds, testIdStrings } = await getMyIncomingOrderOwnedIds(
      req.paraClinic._id,
    );
    const order = await Order.findOne({
      _id: nodeId,
      "tests.item": { $in: testIds },
    }).populate(incomingOrderPopulate);
    if (!order) return next(new NotFoundError());

    const data = scopeOrderToParaClinic(order, testIdStrings);
    res.status(200).json({ message: "getMyIncomingOrder", data });
  },
);

// Fulfill/cancel one of this paraClinic's own line items within an order
// (2026-08). Scoped the same way getMyIncomingOrder(s) are: the target item
// must belong to a ParaClinicTest owned by this paraClinic, so a paraClinic
// can never touch another seller's item in a shared order. paraClinic only
// ever has one item model ("tests"), unlike pharmacy/doctor which have two.
const mutateIncomingOrderItemSchema = z.strictObject({
  itemId: z.string(),
  status: z.enum(["fulfilled", "cancelled"]),
});

export const mutateIncomingOrderItem: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } =
      await mutateIncomingOrderItemSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(data.itemId)) return next(new BadInputError());

    const { testIdStrings } = await getMyIncomingOrderOwnedIds(
      req.paraClinic._id,
    );
    if (!testIdStrings.includes(data.itemId)) return next(new AccessError());

    const order = await Order.findOneAndUpdate(
      { _id: nodeId, "tests.item": data.itemId },
      { $set: { "tests.$.status": data.status } },
      { new: true },
    );
    if (!order) return next(new NotFoundError());

    res.status(200).json({ message: "mutateIncomingOrderItem" });
  },
);

const addMyTestSchema = z.strictObject({
  test: z.string(),
  price: z.coerce.number().optional(),
  readyTime: z.string().optional(),
});

// Add one of the admin's tests to this paraClinic's own offering (creates a ParaClinicTest)
export const addMyTest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const { data, success } = await addMyTestSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(data.test)) return next(new BadInputError());
    const test = await Test.findOne({ _id: data.test, isActive: true });
    if (!test) return next(new NotFoundError("آزمایش"));
    const dup = await ParaClinicTest.exists({
      test: data.test,
      paraClinic: req.paraClinic._id,
    });
    if (dup)
      return next(
        new AppError("این آزمایش قبلا به فهرست شما اضافه شده", 409),
      );
    await ParaClinicTest.create({ ...data, paraClinic: req.paraClinic._id });
    res.status(200).json({ message: "addMyTest" });
  },
);

const editMyTestSchema = z.strictObject({
  price: z.coerce.number().optional(),
  readyTime: z.string().optional(),
});

// ParaClinics may only edit their own commercial fields; ownership (test/paraClinic)
// stays admin-only via the /auto/paraClinicTest route.
export const editMyTest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await editMyTestSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const node = await ParaClinicTest.findOne({
      _id: nodeId,
      paraClinic: req.paraClinic._id,
    });
    if (!node) return next(new NotFoundError());
    await ParaClinicTest.findByIdAndUpdate(node._id, data);
    res.status(200).json({ message: "editMyTest" });
  },
);

export const removeMyTest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await ParaClinicTest.findOne({
      _id: nodeId,
      paraClinic: req.paraClinic._id,
    });
    if (!node) return next(new NotFoundError());
    await ParaClinicTest.findByIdAndDelete(node._id);
    res.status(200).json({ message: "removeMyTest" });
  },
);

// ParaClinic-facing license catalog + purchase (2026-09) - lets a paraClinic
// buy one of the admin-managed BaseParaClinicLicense tiers, unlocking the
// dashboard modules that tier grants. Mirrors
// pharmacyController.getMyLicenseOverview/purchaseLicense/
// resolveMyLicenseModules/requireLicenseModule/getMyLicenseModules. See
// Models/BaseParaClinicLicense.ts (the catalog) and
// Models/ParaClinicProfileLicense.ts (the paraClinic's own current license
// record, one per paraClinic).
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
    if (!req.paraClinic) return next(new MiddlewareError());
    const licenses = await BaseParaClinicLicense.find({
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
    if (!req.paraClinic) return next(new MiddlewareError());
    const licenses = await BaseParaClinicLicense.find({ isActive: true })
      .sort({ order: 1 })
      .select("-details");
    const durations = await findReferencedDurations(licenses);
    res.status(200).json({
      message: "getActiveLicenses",
      // `modules` here is the full paraClinicDashboardModules enum, not
      // just whatever the returned licenses' own `modules[]` happen to
      // include - lets the "see all plans" page render a full
      // plan-vs-module comparison.
      data: { licenses, durations, modules: paraClinicDashboardModules },
    });
  },
);

// Single-plan fetch (2026-09) for a plan-detail page - returns the full
// BaseParaClinicLicense document (details included, unlike the list
// endpoints above) with each pricing entry's duration populated inline,
// since there's only one document here to enrich.
export const getLicenseById: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const license = await BaseParaClinicLicense.findById(nodeId).populate(
      "pricing.duration",
    );
    if (!license) return next(new NotFoundError());
    res.status(200).json({ message: "getLicenseById", data: license });
  },
);

// Dashboard-home widget fetch (2026-09) - the paraClinic's own currently
// assigned ParaClinicProfileLicense (if any), plus whether it's expired.
// Unlike resolveMyLicenseModules below (which silently falls back to the
// isDefault tier's modules on expiry, for gating purposes), the widget
// needs the raw record and expiry state directly so it can show "no
// license" / "expired" rather than pretending the fallback tier was
// actually purchased.
export const getMyCurrentLicense: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const current = await ParaClinicProfileLicense.findOne({
      owner: req.paraClinic._id,
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
    if (!req.paraClinic || !req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data: input, success } =
      await purchaseLicenseSchema.safeParseAsync(req.body);
    if (!success || !isValidObjectId(input.duration))
      return next(new BadInputError());
    const license = await BaseParaClinicLicense.findById(nodeId);
    if (!license) return next(new NotFoundError());

    // A paraClinic with an active (non-expired) ProfileLicense can't buy
    // another plan until it expires (2026-09) - avoids double-charging and
    // silently clobbering time still left on the current plan. Same
    // expiry check getMyCurrentLicense/resolveMyLicenseModules use.
    const existingLicense = await ParaClinicProfileLicense.findOne({
      owner: req.paraClinic._id,
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

    const data = await ParaClinicProfileLicense.findOneAndUpdate(
      { owner: req.paraClinic._id },
      {
        owner: req.paraClinic._id,
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
        paraClinic: req.paraClinic._id,
        paraClinicLicense: license._id,
      });
    }

    res.status(200).json({ message: "purchaseLicense", data });
  },
);

// Resolves which dashboard modules a paraClinic currently has access to
// (2026-09), shared by requireLicenseModule (single-module gate on a route)
// and getMyLicenseModules (the full resolved set, for the frontend to gate
// whole pages with).
//
// Resolution order:
//  1. If this paraClinic already has a ParaClinicProfileLicense AND it
//     isn't expired (expiresAt unset, or still in the future - see
//     paraClinicController.purchaseLicense for how expiresAt gets set),
//     that record's `modules` is authoritative.
//  2. Otherwise (no record, or an expired one) fall back to whichever
//     BaseParaClinicLicense tier has `isDefault: true` (at most one is
//     expected, per that field's own comment) - a paraClinic who never
//     purchased anything, or whose purchase lapsed, is treated as being on
//     the default tier.
//  3. If no BaseParaClinicLicense is marked default either, there is
//     nothing to gate against, so every module is considered allowed.
const resolveMyLicenseModules = async (
  paraClinicId: unknown,
): Promise<ParaClinicDashboardModule[]> => {
  const current = await ParaClinicProfileLicense.findOne({
    owner: paraClinicId,
  });
  const isExpired = !!current?.expiresAt && current.expiresAt < new Date();
  if (current && !isExpired) return current.modules;

  const defaultLicense = await BaseParaClinicLicense.findOne({
    isDefault: true,
  });
  if (!defaultLicense) return [...paraClinicDashboardModules];
  return defaultLicense.modules;
};

// Gates a route behind a dashboard module the paraClinic's license must
// grant. Meant to sit after aclController.useParaClinic(...) in a route's
// middleware chain, same as any other req.paraClinic-dependent check here.
export const requireLicenseModule = (
  mod: ParaClinicDashboardModule,
): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const modules = await resolveMyLicenseModules(req.paraClinic._id);
    if (!modules.includes(mod)) return next(new AccessError());
    next();
  });

// ParaClinic-facing resolved module list (2026-09) - lets the frontend gate
// an entire page with a friendly notice instead of letting the underlying
// API calls fail with AccessError. Deliberately not gated by any specific
// action - every paraClinic-context request, owner or delegated secretary,
// needs this to know what it can show.
export const getMyLicenseModules: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const data = await resolveMyLicenseModules(req.paraClinic._id);
    res.status(200).json({ message: "getMyLicenseModules", data });
  },
);
