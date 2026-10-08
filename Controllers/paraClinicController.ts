import { normalizeOpeningHours } from "../Lib/openingHours";
import { notifyLicensePurchased } from "../Services/licenseExpiryService";
import { notifyWithSms } from "../Services/notificationSmsService";
import path from "path";
import { isLicenseActive, isLicenseExpired } from "../Lib/licenseActive";
import fs from "fs/promises";
import Notification from "../Models/Notification";
import UserFile from "../Models/UserFile";
import { sniffExtension } from "./uploadController";
import { settleOrderLine } from "../Services/orderSettlementService";
import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { dailyOrderStats } from "../Lib/orderStats";
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
import ParaClinicTest, { paraClinicTestSamplings } from "../Models/ParaClinicTest";
import { confirmLineSampling } from "../Lib/labSampling";
import { samplingMovesFor } from "../Lib/labSamplingReschedule";
import Order from "../Models/Order";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import BaseParaClinicLicense, {
  paraClinicDashboardModules,
  ParaClinicDashboardModule,
} from "../Models/BaseParaClinicLicense";
import ParaClinicProfileLicense from "../Models/ParaClinicProfileLicense";
import { findActivePricing, licenseDurationsOf } from "../Lib/licensePricing";
import { chargeLicensePurchase, quoteLicensePurchase, recordLicensePurchase } from "../Lib/licenseQuote";
import { minimalModules } from "../Lib/licenseTiers";

const becomeAParaClinicSchema = z.strictObject({
  name: z.string().trim().min(1),
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
    // an approved request is final: resubmitting used to flip it back to
    // Pending (only a declined one may be sent again)
    const approved = await BecomeParaClinicRequest.exists({
      user: req.user._id,
      status: "Approved",
    });
    if (approved)
      return next(new AppError("درخواست شما قبلا تأیید شده است", 409));
    const becomeParaClinicRequest =
      await BecomeParaClinicRequest.findOneAndUpdate(
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
      "newBecomeParaClinicRequest",
      {
        title: "درخواست پاراکلینیک شدن",
        message: `کاربر ${req.user.phone} درخواست پاراکلینیک شدن ثبت کرد.`,
      },
      {
        requestId: becomeParaClinicRequest._id.toString(),
        userPhone: req.user.phone,
      },
    ).catch((err) =>
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
  name: z.string().trim().min(1).optional(),
  tags: z.array(objectIdField).optional(),
  province: objectIdField.optional(),
  city: objectIdField.optional(),
  district: objectIdField.optional(),
  category: objectIdField.optional(),
  location: isPoint.optional(),
  image: z.string().optional(),
  establishment: z.string().optional(),
  businessTime: z.string().optional(),
  // the structured week (2026-10, Lib/openingHours.ts): a JSON object;
  // null clears it. The free text above stays as a note.
  openingHours: z.unknown().optional(),
  isRoundTheClock: boolish.optional(),
  phone: z.string().optional(),
  onPremises: boolish.optional(),
  onlineResponse: boolish.optional(),
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
    // «نمونه‌گیری در محل» follows the home-sampling switch of the sampling
    // settings (2026-10, Controllers/labSamplingController.ts); an old form
    // still sending it changes nothing
    delete payload.onPremises;
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
    // the accepted insurers are contracts the insurer confirms (2026-10,
    // /insurer-contract, Lib/insuranceContracts.ts): an old client's list
    // is ignored, not written one-sidedly
    delete payload.insurances;
    // a malformed week is a 400 (OpeningHoursError); the model keeps
    // isRoundTheClock in step with it
    if (data.openingHours !== undefined)
      payload.openingHours = normalizeOpeningHours(data.openingHours);
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
    // this lab's lines still waiting on it (the order itself is always "paid")
    pendingLines: tests.filter((t) => t.status === "pending").length,
  };
};

const incomingOrderPopulate = [
  { path: "user", select: "username phone avatar" },
  {
    path: "tests",
    populate: { path: "item", populate: { path: "test" } },
  },
  // the sampling appointment of a line (2026-10, Lib/labSampling.ts) and,
  // for a home visit, where to go
  {
    path: "tests.sampling",
    populate: {
      path: "address",
      populate: [
        { path: "city", select: "name" },
        { path: "district", select: "name" },
      ],
    },
  },
];

// GET /paraClinic/order/stats - 30-day trend for the dashboard home.
export const getMyOrderStats: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const { testIds, testIdStrings } = await getMyIncomingOrderOwnedIds(
      req.paraClinic._id,
    );
    const data = await dailyOrderStats(
      { "tests.item": { $in: testIds } },
      (order) =>
        (order.tests || []).filter((line: any) =>
          testIdStrings.includes(String(line?.item)),
        ),
    );
    res.status(200).json({ message: "getMyOrderStats", data });
  },
);

export const getMyIncomingOrders: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic) return next(new MiddlewareError());
    const { testIds, testIdStrings } = await getMyIncomingOrderOwnedIds(
      req.paraClinic._id,
    );
    // only paid orders - a "pending" SEP order isn't paid yet (2026-09)
    const orders = await Order.find({
      status: "paid",
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
      status: "paid",
      "tests.item": { $in: testIds },
    }).populate(incomingOrderPopulate);
    if (!order) return next(new NotFoundError());

    const data = scopeOrderToParaClinic(order, testIdStrings);
    // what the lab may do with each sampling appointment (2026-10,
    // Lib/labSamplingReschedule.ts): move it to another slot
    const samplingMoves = await samplingMovesFor(
      ((data as { tests?: { sampling?: unknown }[] }).tests || []).map((l) => l?.sampling),
      "lab",
    );
    res.status(200).json({ message: "getMyIncomingOrder", data: { ...(data as object), samplingMoves } });
  },
);

// Fulfill/cancel one of this paraClinic's own line items within an order
// (2026-08). Scoped the same way getMyIncomingOrder(s) are: the target item
// must belong to a ParaClinicTest owned by this paraClinic, so a paraClinic
// can never touch another seller's item in a shared order. paraClinic only
// ever has one item model ("tests"), unlike pharmacy/doctor which have two.
const mutateIncomingOrderItemSchema = z.strictObject({
  itemId: z.string(),
  // "accepted" (2026-10, Lib/orderResponse.ts): the lab takes the order
  // (it will take the sample / run the test), which stops the
  // response-deadline cancel; the line stays pending until its result
  status: z.enum(["accepted", "fulfilled", "cancelled"]),
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

    // accept: once, while the line is pending and unanswered
    if (data.status === "accepted") {
      const accepted = await Order.findOneAndUpdate(
        {
          _id: nodeId,
          status: "paid",
          tests: {
            $elemMatch: { item: data.itemId, status: "pending", acceptedAt: { $exists: false } },
          },
        },
        { $set: { "tests.$.acceptedAt": new Date() } },
        { new: true },
      );
      if (!accepted)
        return next(new AppError("این قلم دیگر در انتظار پاسخ شما نیست", 409));
      // accepting the line confirms its sampling appointment (Lib/labSampling.ts)
      await confirmLineSampling(accepted._id, data.itemId);
      await Notification.create({
        user: (accepted.user as any)?._id ?? accepted.user,
        source: "System",
        title: "فروشنده سفارش شما را پذیرفت",
        message: req.paraClinic.name || "",
        link: `/order/${accepted._id}`,
      }).catch(() => undefined);
      return res.status(200).json({ message: "mutateIncomingOrderItem" });
    }

    // a lab's work is the result (2026-10, like Halodoc / Vezeeta lab
    // partners): a test is "done" - and the lab paid - only once its result
    // was given to the patient (uploadTestResult); cancelling needs none
    const done = data.status === "fulfilled";
    if (done) {
      const current = await Order.findOne({ _id: nodeId, status: "paid" }).select("tests").lean();
      const line = ((current as any)?.tests || []).find(
        (l: any) => String(l.item) === data.itemId && l.status === "pending",
      );
      if (line && !line.result?.uploadedAt)
        return next(new AppError("ابتدا جواب آزمایش را برای بیمار بارگذاری کنید", 409));
    }

    // only a pending line can be fulfilled or cancelled (see pharmacy)
    const order = await Order.findOneAndUpdate(
      {
        _id: nodeId,
        status: "paid",
        tests: {
          $elemMatch: {
            item: data.itemId,
            status: "pending",
            ...(done ? { "result.uploadedAt": { $exists: true } } : {}),
          },
        },
      },
      { $set: { "tests.$.status": data.status } },
      { new: true },
    );
    if (!order) return next(new NotFoundError());
    await settleOrderLine({
      order,
      model: "tests",
      itemId: data.itemId,
      sellerUserId: req.paraClinic.user,
      org: { paraClinic: req.paraClinic._id },
    });

    res.status(200).json({ message: "mutateIncomingOrderItem" });
  },
);

const addMyTestSchema = z.strictObject({
  test: z.string(),
  // a lab test is never free or negative, and has a price from the start
  price: z.coerce.number().positive(),
  readyTime: z.string().optional(),
  // how its sample is taken (2026-10, Models/ParaClinicTest.ts)
  sampling: z.enum(paraClinicTestSamplings).optional(),
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
  // a lab test is never free or negative, and has a price from the start
  price: z.coerce.number().positive().optional(),
  readyTime: z.string().optional(),
  // pause / resume the offer without deleting it (2026-10)
  isActive: boolish.optional(),
  sampling: z.enum(paraClinicTestSamplings).optional(),
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
    // an offer is switched on only with a real price (old offers saved at 0
    // were switched off by Lib/migrateLabPharmacyIntegrity.ts)
    const price = data.price ?? node.price;
    if (data.isActive === true && !(Number(price) >= 1))
      return next(new AppError("برای فعال کردن این آزمایش، قیمت آن را وارد کنید", 400));
    await ParaClinicTest.findByIdAndUpdate(node._id, data, { runValidators: true });
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
    // a paid order still waiting on this item would vanish from the
    // seller's queue (2026-10): finish or cancel those lines first
    if (
      await Order.exists({
        status: "paid",
        tests: { $elemMatch: { item: node._id, status: "pending" } },
      })
    )
      return next(new AppError("این قلم سفارش پرداخت‌شده‌ی در انتظار دارد؛ اول سفارش‌ها را انجام یا لغو کنید", 400));
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
    const license = await BaseParaClinicLicense.findById(nodeId);
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
    if (!req.paraClinic || !req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data: input, success } =
      await purchaseLicenseSchema.safeParseAsync(req.body);
    if (!success)
      return next(new BadInputError());
    const license = await BaseParaClinicLicense.findById(nodeId);
    // an inactive plan is not for sale even by direct id
    if (!license || !license.isActive) return next(new NotFoundError());

    // A provider on a running plan may only upgrade to a higher plan,
    // credited for the unused days of the current one (2026-10, Lib/
    // licenseQuote.ts); a lower or equal plan waits until it ends.
    const existingLicense = await ParaClinicProfileLicense.findOne({
      owner: req.paraClinic._id,
    });

    // the period is part of the plan's own price option (days); only an
    // active option is for sale
    const pricingOption = findActivePricing(license.pricing, input.duration);
    if (!pricingOption) return next(new BadInputError());

    // one price rule for the panel, the pricing pages and the purchase:
    // the option's own discount, then the best running promotion; the
    // transaction below (hence the ledger and Moadian) carries this amount
    const quoted = await quoteLicensePurchase({
      kind: "paraClinic",
      plan: license,
      option: pricingOption,
      ownerId: req.paraClinic._id,
      code: input.promoCode,
      current: existingLicense,
    });
    if (quoted instanceof AppError) return next(quoted);
    const price = quoted.final;
    // claims the promotion use, then debits the wallet in one atomic step
    const chargeError = await chargeLicensePurchase(req.user._id, quoted);
    if (chargeError) return next(chargeError);

    // The new period starts now (an upgrade replaces the running one,
    // already credited above); upsert also covers a first purchase.
    const startedAt = new Date();
    const expiresAt = new Date(
      startedAt.getTime() + pricingOption.days * 24 * 60 * 60 * 1000,
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
    // the period's history (an upgrade ends the one it replaces)
    await recordLicensePurchase(quoted, req.user._id, { startedAt, expiresAt });

    if (price > 0) {
      await Transaction.create({
        user: req.user._id,
        amount: -price,
        paraClinic: req.paraClinic._id,
        paraClinicLicense: license._id,
      });
    }

    notifyLicensePurchased("paraClinic", req.user._id, license.displayName, expiresAt);
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
//  3. If no BaseParaClinicLicense is marked default either, only the free tier's bare
//     minimum (Lib/licenseTiers.ts minimalModules) is allowed (2026-10;
//     it used to open every module).
export const resolveMyLicenseModules = async (
  paraClinicId: unknown,
): Promise<ParaClinicDashboardModule[]> => {
  const current = await ParaClinicProfileLicense.findOne({
    owner: paraClinicId,
  });
  const isExpired = isLicenseExpired(current);
  if (current && !isExpired) return current.modules;

  const defaultLicense = await BaseParaClinicLicense.findOne({
    isDefault: true,
  });
  // no default plan: only the free tier's bare minimum, never every
  // module (Lib/licenseTiers.ts)
  if (!defaultLicense) return [...minimalModules.paraClinic] as ParaClinicDashboardModule[];
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

// POST /paraClinic/order/:nodeId/result/:lineId (multipart: files[], note)
// The lab delivers a test's result (2026-10), after the Halodoc / Vezeeta
// lab partner apps: PDF or image files kept private (NotPublic, UserFile
// "Order"), readable by the buyer, the lab's owner and the uploader; the
// buyer is notified. Uploading again adds files; the note is replaced.
export const uploadTestResult: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.paraClinic || !req.user) return next(new MiddlewareError());
    const { nodeId, lineId } = req.params;
    if (!isValidObjectId(nodeId) || !isValidObjectId(lineId)) return next(new BadInputError());
    const { testIds } = await getMyIncomingOrderOwnedIds(req.paraClinic._id);
    const order = await Order.findOne({ _id: nodeId, status: "paid", "tests.item": { $in: testIds } });
    if (!order) return next(new NotFoundError());
    const line = order.tests.find(
      (t) => String((t as unknown as { _id: unknown })._id) === lineId &&
        testIds.some((id) => String(id) === String((t.item as any)?._id ?? t.item)),
    );
    if (!line) return next(new NotFoundError());
    if (line.status === "cancelled") return next(new BadInputError());
    const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 2000) : "";
    if (!files.length && !note) return next(new BadInputError());
    const buyer = (order.user as any)?._id ?? order.user;
    const owner = (req.paraClinic.user as any)?._id ?? req.paraClinic.user;
    const readers = [buyer, owner, req.user._id].filter(Boolean);
    const created: unknown[] = [];
    for (const f of files) {
      const declared = (f.originalname.split(".").pop() || "").toLowerCase();
      const ext = sniffExtension(f.buffer, declared);
      if (!ext || !["pdf", "png", "jpg", "jpeg", "webp"].includes(ext))
        return next(new AppError("فقط فایل PDF یا تصویر پذیرفته می‌شود", 400));
      const name = `LabResult-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      await fs.writeFile(path.join(process.cwd(), "NotPublic", name), f.buffer);
      const doc = await UserFile.create({ chat: order._id, chatPath: "Order", readers, file: name });
      created.push(doc._id);
    }
    // never on a line cancelled meanwhile (the response-deadline sweep, the
    // buyer): conditional in the same atomic update. A result answers the
    // line (acceptedAt: kept if earlier, filled if missing).
    const saved = await Order.updateOne(
      { _id: order._id, status: "paid", tests: { $elemMatch: { _id: lineId, status: { $ne: "cancelled" } } } },
      {
        ...(created.length ? { $push: { "tests.$.result.files": { $each: created } } } : {}),
        $set: {
          "tests.$.result.uploadedAt": new Date(),
          ...(note ? { "tests.$.result.note": note } : {}),
        },
        $min: { "tests.$.acceptedAt": new Date() },
      },
    );
    if (!saved.modifiedCount)
      return next(new AppError("این قلم سفارش لغو شده است", 409));
    res.status(200).json({ message: "uploadTestResult" });
    await Notification.create({
      user: buyer,
      source: "System",
      title: "جواب آزمایش شما آماده است",
      message: req.paraClinic.name || "",
      link: `/order/${order._id}`,
    }).catch(() => undefined);
    notifyWithSms("labResultReadyUser", buyer, {
      orderId: String(order._id),
      labName: req.paraClinic.name || "",
    });
  },
);
