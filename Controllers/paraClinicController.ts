import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import * as z from "zod";
import { isValidObjectId, Types } from "mongoose";
import AppError, {
  AccessError,
  BadInputError,
  MiddlewareError,
  MissingTaminTokenError,
  NotFoundError,
} from "../Lib/AppError";
import ParaClinic from "../Models/Paraclinic";
import BecomeParaClinicRequest from "../Models/BecomeParaClinicRequest";
import DoctorTaminCred from "../Models/DoctorTaminCred";
import makeTaminRequest from "../Lib/MakeTamjinRequest";
import TaminIcid from "../Models/TaminIdid";
import ParaClinicTag from "../Models/ParaClinicTag";
import Province from "../Models/Geo/Province";
import City from "../Models/Geo/City";
import District from "../Models/Geo/District";
import Insurance from "../Models/Insurance";
import { boolish, isPoint, numerish } from "../Lib/helpers";
import Test from "../Models/Test";
import ParaClinicTest from "../Models/ParaClinicTest";
import Order from "../Models/Order";

const becomeAParaClinicSchema = z.strictObject({ name: z.string() });
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
