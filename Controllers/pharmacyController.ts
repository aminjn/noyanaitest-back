import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  AccessError,
  ActiveLicenseExistsError,
  BadInputError,
  DeliveryNotAvailableError,
  MiddlewareError,
  MissingTaminTokenError,
  NotFoundError,
  TaminRideError,
} from "../Lib/AppError";
import * as z from "zod";
import Pharmacy, { IPharmacy } from "../Models/Pharmacy";
import BecomePharmacyRequest from "../Models/BecomePharmacyRequest";
import { notifyUserAlertSubscribers } from "../Services/userAlertService";
import DoctorTaminCred from "../Models/DoctorTaminCred";
import makeTaminRequest from "../Lib/MakeTamjinRequest";
import PharmacyTaminPrescription from "../Models/PharmacyTaminPrescription";
import PharmacyTaminPrescriptionItem from "../Models/PharmacyTaminPrescriptionItem";
import PharmacyFilledPrescription from "../Models/PharmacyFilledPrescription";
import PharmacyFilledPrescriptionItem from "../Models/PharmacyFilledPrescriptionItem";
import { isValidObjectId, Types } from "mongoose";
import Product from "../Models/Product";
import ProductSeller from "../Models/ProductSeller";
import ProductPackage from "../Models/ProductPackage";
import ProductCategory from "../Models/ProductCategory";
import Order from "../Models/Order";
import { boolish, isPoint, numerish } from "../Lib/helpers";
import Province from "../Models/Geo/Province";
import City from "../Models/Geo/City";
import District from "../Models/Geo/District";
import User from "../Models/User";
import DeliveryRide from "../Models/DeliveryRide";
import * as snappClient from "../Lib/snappClient";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import BasePharmacyLicense, {
  pharmacyDashboardModules,
  PharmacyDashboardModule,
} from "../Models/BasePharmacyLicense";
import PharmacyProfileLicense from "../Models/PharmacyProfileLicense";
import LicenseDuration from "../Models/LicenseDuration";

const becomePharmacyRequestSchema = z.strictObject({
  name: z.string(),
  siamCode: z.string(),
  nationalId: z.string(),
  certificateDate: z.coerce.date(),
  certificateFile: z.string().optional(),
  description: z.string().optional(),
});
export const becomeAPharmacy: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, success } = await becomePharmacyRequestSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const cur = await Pharmacy.findOne({ user: req.user._id });
    if (!!cur) return next(new AppError("شما قبلا داروخانه شده اید", 409));
    const pending = await BecomePharmacyRequest.findOne({
      user: req.user._id,
      status: "Pending",
    });
    if (pending) return next(new AppError("درخواست شما قبلا ثبت شده است", 409));
    const becomePharmacyRequest = await BecomePharmacyRequest.findOneAndUpdate(
      { user: req.user._id },
      {
        ...data,
        user: req.user._id,
        status: "Pending",
      },
      { upsert: true, new: true },
    );
    notifyUserAlertSubscribers(
      "newBecomePharmacyRequest",
      {
        title: "درخواست داروخانه شدن",
        message: `کاربر ${req.user.phone} درخواست داروخانه شدن ثبت کرد.`,
      },
      {
        requestId: becomePharmacyRequest._id.toString(),
        userPhone: req.user.phone,
      },
    ).catch((err) =>
      console.log(
        `[pharmacyController] failed to notify staff of becomePharmacy request by ${req.user?._id}:`,
        err,
      ),
    );
    res.status(200).json({ message: "becomeAPharmacy" });
  },
);

export const getMyBecomePharmacyRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await BecomePharmacyRequest.findOne({ user: req.user._id });
    res.status(200).json({ message: "getMyBecomePharmacyRequest", data });
  },
);

export const getMyPharmacyProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const data = await Pharmacy.findById(req.pharmacy._id);
    if (!data) return next(new AccessError());
    res.status(200).json({ message: "getMyPharmacyProfile", data });
  },
);

// Self-service pharmacy profile editing (2026-08) — mirrors
// clinicController.updateMyClinicProfile / doctorController.updateMyProfile.
// Scoped to the fields Models/Pharmacy.ts already has (no gallery/social/faq
// models exist for pharmacies, unlike doctors).
const objectIdField = z
  .string()
  .refine((val) => isValidObjectId(val), { message: "invalid id" });

const updateMyPharmacyProfileSchema = z.strictObject({
  name: z.string().optional(),
  avatar: z.string().optional(),
  banner: z.string().optional(),
  summary: z.string().optional(),
  address: z.string().optional(),
  province: objectIdField.optional(),
  city: objectIdField.optional(),
  district: objectIdField.optional(),
  location: isPoint.optional(),
});

export const updateMyPharmacyProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { data, success, error } =
      await updateMyPharmacyProfileSchema.safeParseAsync(req.body);
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
    await Pharmacy.findByIdAndUpdate(req.pharmacy._id, payload);
    res.status(200).json({ message: "updateMyPharmacyProfile" });
  },
);

export const getCachedPrescriptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const data = await PharmacyTaminPrescription.find({
      pharmacy: req.pharmacy._id,
    }).populate({ path: "items" });
    res.status(200).json({ message: "getCachedPrescriptions", data });
  },
);

const getPatientPrescriptionSchema = z.strictObject({
  tracking: z.string(),
  // nationalCode: z.string(),
});

type TaminPrescriptionListResponse = {
  list: {
    headeprscid: number;
    prescdate: string;
    docid: string;
    docspec: string;
    doctorFullName: string;
    patientfirstname: string;
    patientlastname: string;
    custname: null;
    comments: string;
    refeR_REASON: null;
    electronicflag: string;
    clinicdoc: string;
    presctime: string;
    speccode: string;
    finalDetailsPresc: {
      detailId: number;
      drugCode: string;
      drugName: string;
      drugForm: string;
      insuranceStatus: string;
      requiresBarcodeInquiry: string;
      hospitalDrug: string;
      maxAge: string;
      prescribedCount: string;
      remainingCount: string;
      drugInstruction: string;
    }[];
  }[];
  problems: {
    error_Code: number;
    error_Msg: string;
    complemantary_Msg: string;
    complemantary_Data: string;
    complemantary_Code: string;
  }[];
  warnings: never[];
  hasError: boolean;
  status: number;
  family: string;
  reason: string;
  total: number;
};

export const getPatientPrescriptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { data, success } = await getPatientPrescriptionSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://darmanapi.tamin.ir/api/Pharmacy/DrugEpresc/GetActivePresc`,
      method: "GET",
      token: cred.token,
      parser: "PARAMS",
      payload: {
        PhaId: "0000000920",
        patientNationalCode: "1234567891",
        trackingCode: data.tracking,
      },
    });
    if (!response.headers.get("Content-Type")?.includes("json")) {
      console.log(await response.text());
      return next(new TaminRideError());
    }
    const data1: { data: TaminPrescriptionListResponse } =
      await response.json();
    console.log(data1.data);
    if (data1.data.status !== 200 || !data1.data)
      return next(
        new AppError(
          data1.data?.problems
            ?.map((el) => [el.error_Msg, el.complemantary_Msg].join(":"))
            .join(" / ")
            .trim() || "خطای ناشناخته در دریافت اطلاعات",
          400,
        ),
      );
    for (const presc of data1.data.list) {
      const { finalDetailsPresc, ...prescRest } = presc;
      const savedPresc = await PharmacyTaminPrescription.findOneAndUpdate(
        {
          headeprscid: presc.headeprscid,
          pharmacy: req.pharmacy._id,
        },
        { ...prescRest, pharmacy: req.pharmacy._id },
        { upsert: true, new: true },
      );
      for (const item of finalDetailsPresc) {
        await PharmacyTaminPrescriptionItem.findOneAndUpdate(
          {
            detailId: item.detailId,
            prescription: savedPresc._id,
          },
          { prescription: savedPresc._id, ...item },
          { upsert: true, new: true },
        );
      }
    }
    res
      .status(200)
      .json({ message: "getPatientPrescriptions", data: data1.data });
  },
);

export const getDrugEquiv: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://darmanapi.tamin.ir/api/Provider/GetDrugEquivalnet`,
      method: "POST",
      token: cred.token,
      payload: { drugCode: "00077", count: "10", PhaId: "0000000920" },
    });
    const data = await response.json();
    console.log(data);
    res.status(200).json({ message: "getDrugEquiv" });
  },
);

type FillPrescriptionTaminResponse = {
  status: number;
  family: string;
  reason: string;
  data: {
    data: {
      requestId: number;
      requestPrice: number;
      regdate: string;
      phaRequestPrice: number;
      isNotePatient: number;
      docId: string;
      docFName: string;
      docLName: string;
      userId: string;
      phaId: string;
      month: string;
      year: string;
      prescDate: string;
      patientAmount: number;
      custServiceType: string;
      docspec: string;
      custServiceTypeDesc: null;
      finalDetailRegisterPrescs: {
        drugCode: string;
        drugName: string;
        drugCount: number;
        itemPrice: number;
        franshiz: number;
        phaItemPrice: number;
        timesaday: string;
        dose: string;
        is_Note_Patient: number;
        subsidyprice: number;
        patient_Price: number;
        support_Specialpatient: number;
        sumPrice: number;
        sumIsNotePatient: number;
      }[];
    } | null;
    // [
    // {
    //     "error_Code": 9900002,
    //     "error_Msg": "خطا در دریافت نسخه",
    //     "complemantary_Msg": "کد يکبارمصرف داروي01311 وارد نشده  يا منقضي شده است",
    //     "complemantary_Data": "",
    //     "complemantary_Code": "01311"
    // }
    // ]
    problems: {
      error_Code: number;
      error_Msg: string;
      complemantary_Msg: string;
      complemantary_Data: string;
      complemantary_Code: string;
    }[];
    warnings: {
      warningCode: string;
      warningMessage: string;
      complemantary_Msg: string;
      complemantary_Data: string;
      complemantary_Code: string;
      partialCount: string;
      freeReason: string;
    }[];
    hasError: boolean;
    status: number;
    family: string;
    reason: string;
  };
};

const fillPrescriptionSchema = z.strictObject({
  userInformation: z.strictObject({ phaId: z.string() }),
  electronicPrescHead: z.coerce.string(),
  patientNatCode: z.string(),
  patientMobileNo: z.string(),
  drugsList: z.array(
    z.strictObject({
      electronicPrescDetail: z.number(),
      drugCode: z.string(),
      phaDrugPrice: z.number(),
      requestedCount: z.number(),
      barcodesList: z.null(),
      drugIrc: z.null(),
    }),
  ),
});

export const fillPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const {
      data: input,
      success,
      error,
    } = await fillPrescriptionSchema.safeParseAsync(req.body);
    if (!success) return next(new AppError(error.message, 400));
    const prescription = await PharmacyTaminPrescription.findOne({
      headeprscid: input.electronicPrescHead,
      pharmacy: req.pharmacy._id,
    });
    if (!prescription) return next(new NotFoundError());
    const response = await makeTaminRequest({
      path: `https://darmanapi.tamin.ir/api/Pharmacy/DrugStore/PostPresc`,
      method: "POST",
      token: cred.token,
      payload: input,
    });
    const data = (await response.json()) as FillPrescriptionTaminResponse;
    console.log(data);
    if (!data?.data?.data) {
      return next(
        new AppError(
          data.data.problems
            .map((problem) =>
              [problem.error_Msg, problem.complemantary_Msg].join("،"),
            )
            .join(" / ") || "خطای ناشناخته رخ داده",
          400,
        ),
      );
    }
    const { finalDetailRegisterPrescs: items, ...incomingData } =
      data.data.data;
    const filled = await PharmacyFilledPrescription.create({
      ...incomingData,
      pharmacy: req.pharmacy._id,
      prescription: prescription._id,
    });
    for (const item of items) {
      await PharmacyFilledPrescriptionItem.create({
        filledPrescription: prescription,
        ...item,
      });
    }
    res.status(200).json({ message: "fillPrescription", data });
  },
);

export const getFilledPrescriptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const data = await PharmacyFilledPrescription.find({
      pharmacy: req.pharmacy._id,
    }).populate([{ path: "prescription" }, { path: "items" }]);
    res.status(200).json({ message: "getFilledPrescriptions", data });
  },
);

export const getFilledPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await PharmacyFilledPrescription.findOne({
      pharmacy: req.pharmacy._id,
      _id: nodeId,
    }).populate([{ path: "items" }, { path: "prescription" }]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getFilledPrescription", data });
  },
);

const getTaminPrescriptionSchema = z.strictObject({
  patientNationalCode: z.string(),
  trackingCode: z.string(),
});
export const getTaminPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const {
      data: input,
      success,
      error,
    } = await getTaminPrescriptionSchema.spa(req.body);
    if (!success) return next(new BadInputError(error.message));
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ap-test.tamin.ir/api/Pharmacy/DrugEpresc/GetActivePresc?patientNationalCode=${input.patientNationalCode}&trackingCode=${input.trackingCode}&PhaId=0000000920`,
      method: "GET",
      token: cred.token,
    });
    const data = await response.json();
    res.status(200).json({ message: "getTaminPrescription", data });
  },
);

export const preCheckPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ap-test.tamin.ir/api/Pharmacy/DrugStore/PreCheckElectronicPresc`,
      method: "POST",
      token: cred.token,
      payload: {
        userInformation: {
          phaid: "0000000920",
          nationalCode: "1234567891",
          clientIp: "string",
        },
        patientNatCode: "1234567891",
        patientMobileNo: "09125475461",
        ...req.body,
      },
    });
    const data = await response.json();
    res.status(200).json({ message: "preCheckPrescription", data });
  },
);

export const submitPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ap-test.tamin.ir/api/Pharmacy/DrugStore/PostPresc`,
      method: "POST",
      token: cred.token,
      payload: {
        userInformation: {
          phaid: "0000000920",
          nationalCode: "1234567891",
          clientIp: "string",
        },
        patientNatCode: "1234567891",
        patientMobileNo: "09125475461",
        ...req.body,
      },
    });
    const data = await response.json();
    res.status(200).json({ message: "submitPrescription", data });
  },
);

export const getSubmittedPrescInfo: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return;
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ap-test.tamin.ir/api/Pharmacy/DrugStore/RequestByRegisterID?PhaId=0000000920&reqId=${req.body.reqid}`,
      method: "GET",
      token: cred.token,
    });
    const data = await response.json();
    res.status(200).json({ message: "getSubmittedPrescInfo", data });
  },
);

export const removePrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return;
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ap-test.tamin.ir/api/Pharmacy/DrugStore/RemovePresc`,
      method: "POST",
      token: cred.token,
      payload: {
        userInformation: {
          phaId: "0000000920",
        },
        ...req.body,
      },
    });
    const data = await response.json();
    res.status(200).json({ message: "removePrescription", data });
  },
);

export const getAdditiveDrugs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return;
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ap-test.tamin.ir/api/Pharmacy/Provider/GetAdditiveDrugs?PhaId=0000000920`,
      method: "GET",
      token: cred.token,
    });
    const data = await response.json();
    res.status(200).json({ message: "getAdditiveDrugs", data });
  },
);

export const referrPresc: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return;
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ap-test.tamin.ir/api/Pharmacy/DrugStore/RefferrRequest`,
      method: "POST",
      token: cred.token,
      payload: {
        userInformation: {
          phaId: "0000000920",
        },
        ...req.body,
      },
    });
    const data = await response.json();
    res.status(200).json({ message: "referrPresc", data });
  },
);

// ---- Pharmacy product management (ProductSeller) ----

// Products the admin has made available, that this pharmacy hasn't added yet
export const getAvailableProducts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const mine = await ProductSeller.find({
      seller: req.pharmacy._id,
    }).distinct("product");
    const data = await Product.find({
      isActive: true,
      _id: { $nin: mine },
    }).populate({ path: "category" });
    res.status(200).json({ message: "getAvailableProducts", data });
  },
);

// This pharmacy's own products (its ProductSeller documents)
export const getMyProducts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const data = await ProductSeller.find({
      seller: req.pharmacy._id,
    }).populate({ path: "product", populate: { path: "category" } });
    res.status(200).json({ message: "getMyProducts", data });
  },
);

const addMyProductSchema = z.strictObject({
  product: z.string(),
  price: z.coerce.number().optional(),
  discount: z.coerce.number().optional(),
  isActive: boolish.optional(),
  freeDelivery: boolish.optional(),
  fastDelivery: boolish.optional(),
});

// Add one of the admin's products to this pharmacy's own store (creates a ProductSeller)
export const addMyProduct: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { data, success } = await addMyProductSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(data.product)) return next(new BadInputError());
    const product = await Product.findOne({
      _id: data.product,
      isActive: true,
    });
    if (!product) return next(new NotFoundError("محصول"));
    const dup = await ProductSeller.exists({
      product: data.product,
      seller: req.pharmacy._id,
    });
    if (dup)
      return next(new AppError("این محصول قبلا به فروشگاه شما اضافه شده", 409));
    await ProductSeller.create({ ...data, seller: req.pharmacy._id });
    res.status(200).json({ message: "addMyProduct" });
  },
);

const editMyProductSchema = z.strictObject({
  price: z.coerce.number().optional(),
  discount: z.coerce.number().optional(),
  isActive: boolish.optional(),
  freeDelivery: boolish.optional(),
  fastDelivery: boolish.optional(),
});

// Pharmacies may only edit their own commercial fields; "special" (and ownership/product)
// stay admin-only via the /auto/productSeller route.
export const editMyProduct: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await editMyProductSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const node = await ProductSeller.findOne({
      _id: nodeId,
      seller: req.pharmacy._id,
    });
    if (!node) return next(new NotFoundError());
    await ProductSeller.findByIdAndUpdate(node._id, data);
    res.status(200).json({ message: "editMyProduct" });
  },
);

export const removeMyProduct: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await ProductSeller.findOne({
      _id: nodeId,
      seller: req.pharmacy._id,
    });
    if (!node) return next(new NotFoundError());
    await ProductSeller.findByIdAndDelete(node._id);
    res.status(200).json({ message: "removeMyProduct" });
  },
);

// ---- Pharmacy product package management (ProductPackage, owned directly by the pharmacy) ----

// Active categories a pharmacy can file its own product packages under.
export const getProductPackageCategories: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const data = await ProductCategory.find({ isActive: true }).sort({
      order: 1,
    });
    res.status(200).json({ message: "getProductPackageCategories", data });
  },
);

export const getMyProductPackages: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const data = await ProductPackage.find({ owner: req.pharmacy._id })
      .populate({ path: "category" })
      .populate({ path: "products" });
    res.status(200).json({ message: "getMyProductPackages", data });
  },
);

// Incoming orders (2026-08) - orders placed by buyers that include at least
// one of this pharmacy's products/productPackages. An Order's products/
// productPackages arrays can mix items from several different sellers (a
// buyer's cart isn't scoped to one pharmacy), so each matching order is
// filtered down to just this pharmacy's own line items + a subtotal over
// them, rather than exposing the whole order (which may contain another
// seller's pricing).

// Ids of the ProductSeller/ProductPackage docs this pharmacy owns - used to
// both query for orders containing them and to filter/scope a matched
// order's item arrays down to this pharmacy's own items.
const getMyIncomingOrderOwnedIds = async (pharmacyId: Types.ObjectId) => {
  const [sellerIds, packageIds] = await Promise.all([
    ProductSeller.find({ seller: pharmacyId }).distinct("_id"),
    ProductPackage.find({ owner: pharmacyId }).distinct("_id"),
  ]);
  return {
    sellerIds,
    packageIds,
    sellerIdStrings: sellerIds.map((id) => id.toString()),
    packageIdStrings: packageIds.map((id) => id.toString()),
  };
};

// Filters an order's products/productPackages down to just this pharmacy's
// own line items and computes a subtotal over them.
const scopeOrderToPharmacy = (
  order: InstanceType<typeof Order>,
  sellerIdStrings: string[],
  packageIdStrings: string[],
) => {
  const products = order.products.filter((p) =>
    sellerIdStrings.includes((p.item as any)?._id?.toString()),
  );
  const productPackages = order.productPackages.filter((p) =>
    packageIdStrings.includes((p.item as any)?._id?.toString()),
  );
  const subtotal = [...products, ...productPackages].reduce(
    (sum, i) => sum + i.price * i.qty,
    0,
  );
  return {
    _id: order._id,
    user: order.user,
    submittedAt: order.submittedAt,
    status: order.status,
    products,
    productPackages,
    subtotal,
  };
};

const incomingOrderPopulate = [
  { path: "user", select: "username phone avatar" },
  {
    path: "products",
    populate: { path: "item", populate: { path: "product" } },
  },
  { path: "productPackages", populate: { path: "item" } },
];

export const getMyIncomingOrders: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { sellerIds, packageIds, sellerIdStrings, packageIdStrings } =
      await getMyIncomingOrderOwnedIds(req.pharmacy._id);
    // only paid orders - a "pending" SEP order isn't paid yet (2026-09)
    const orders = await Order.find({
      status: "paid",
      $or: [
        { "products.item": { $in: sellerIds } },
        { "productPackages.item": { $in: packageIds } },
      ],
    })
      .sort({ submittedAt: -1 })
      .populate(incomingOrderPopulate);
    const data = orders.map((order) =>
      scopeOrderToPharmacy(order, sellerIdStrings, packageIdStrings),
    );
    res.status(200).json({ message: "getMyIncomingOrders", data });
  },
);

export const getMyIncomingOrder: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());

    const { sellerIds, packageIds, sellerIdStrings, packageIdStrings } =
      await getMyIncomingOrderOwnedIds(req.pharmacy._id);
    const order = await Order.findOne({
      _id: nodeId,
      status: "paid",
      $or: [
        { "products.item": { $in: sellerIds } },
        { "productPackages.item": { $in: packageIds } },
      ],
    }).populate(incomingOrderPopulate);
    if (!order) return next(new NotFoundError());

    const data = scopeOrderToPharmacy(order, sellerIdStrings, packageIdStrings);
    res.status(200).json({ message: "getMyIncomingOrder", data });
  },
);

// Fulfill/cancel one of this pharmacy's own line items within an order
// (2026-08). Scoped the same way getMyIncomingOrder(s) are: the target item
// must belong to a ProductSeller/ProductPackage owned by this pharmacy, so a
// pharmacy can never touch another seller's item in a shared order.
const mutateIncomingOrderItemSchema = z.strictObject({
  model: z.enum(["products", "productPackages"]),
  itemId: z.string(),
  status: z.enum(["fulfilled", "cancelled"]),
});

export const mutateIncomingOrderItem: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } =
      await mutateIncomingOrderItemSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(data.itemId)) return next(new BadInputError());

    const { sellerIdStrings, packageIdStrings } =
      await getMyIncomingOrderOwnedIds(req.pharmacy._id);
    const ownedIdStrings =
      data.model === "products" ? sellerIdStrings : packageIdStrings;
    if (!ownedIdStrings.includes(data.itemId)) return next(new AccessError());

    const order = await Order.findOneAndUpdate(
      { _id: nodeId, status: "paid", [`${data.model}.item`]: data.itemId },
      { $set: { [`${data.model}.$.status`]: data.status } },
      { new: true },
    );
    if (!order) return next(new NotFoundError());

    res.status(200).json({ message: "mutateIncomingOrderItem" });
  },
);

// Core of dispatchOrderDelivery, factored out so adminController's Snapp
// test page (2026-09) can exercise the exact same logic against any
// pharmacy/order pair without needing a real ACL-scoped `req.pharmacy` -
// see adminController.adminDispatchDelivery. Throws an AppError subclass on
// failure; callers pass that to next().
export const dispatchDeliveryForPharmacy = async (
  pharmacy: IPharmacy,
  orderId: string,
) => {
  if (!isValidObjectId(orderId)) throw new BadInputError();

  const { sellerIds, packageIds, sellerIdStrings, packageIdStrings } =
    await getMyIncomingOrderOwnedIds(pharmacy._id);
  const order = await Order.findOne({
    _id: orderId,
    status: "paid",
    $or: [
      { "products.item": { $in: sellerIds } },
      { "productPackages.item": { $in: packageIds } },
    ],
  })
    .populate({ path: "user", select: "username phone" })
    .populate({ path: "address" })
    .populate({ path: "products.item", populate: { path: "product" } })
    .populate({ path: "productPackages.item" });
  if (!order) throw new NotFoundError();

  const existing = await DeliveryRide.findOne({
    order: order._id,
    pharmacy: pharmacy._id,
  });
  if (existing) return existing;

  const pharmacyCoordinates = pharmacy.location?.coordinates;
  const addressCoordinates = order.address?.location?.coordinates;
  if (!pharmacyCoordinates || pharmacyCoordinates.length !== 2)
    throw new DeliveryNotAvailableError();
  if (!addressCoordinates || addressCoordinates.length !== 2)
    throw new DeliveryNotAvailableError();
  if (!order.user) throw new DeliveryNotAvailableError();

  const pharmacyUser = pharmacy.user
    ? await User.findById(pharmacy.user).select("phone")
    : null;
  if (!pharmacyUser) throw new DeliveryNotAvailableError();

  const { products, productPackages } = scopeOrderToPharmacy(
    order,
    sellerIdStrings,
    packageIdStrings,
  );
  const itemNames = [...products, ...productPackages]
    .map((i: any) => i.item?.product?.name || i.item?.name)
    .filter(Boolean);
  const packageInfo = (
    itemNames.length ? itemNames.join("، ") : "سفارش داروخانه"
  ).slice(0, 250);

  const [originLng, originLat] = pharmacyCoordinates;
  const [destLng, destLat] = addressCoordinates;

  const snappRide = await snappClient.requestRide({
    origin_lat: originLat,
    origin_lng: originLng,
    destination_lat: destLat,
    destination_lng: destLng,
    service_type: snappClient.snappServiceTypes.box,
    by_credit: true,
    is_paid_by_recipient: false,
    extra_info: packageInfo,
    package_info: packageInfo,
    recipient_name: order.user.username || order.user.phone,
    recipient_cellphone: order.user.phone,
    sender_cellphone: pharmacyUser.phone,
  });

  return DeliveryRide.create({
    order: order._id,
    pharmacy: pharmacy._id,
    hri: snappRide.ride_id,
  });
};

// Dispatch a Snapp Box courier to deliver this pharmacy's own line items
// within an order (2026-09). Scoped the same way getMyIncomingOrder /
// mutateIncomingOrderItem are - the order must contain at least one item
// owned by this pharmacy. Idempotent: if a DeliveryRide already exists for
// this (order, pharmacy) pair, that existing ride is returned instead of
// requesting a second courier.
export const dispatchOrderDelivery: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { nodeId } = req.params;
    const data = await dispatchDeliveryForPharmacy(req.pharmacy, nodeId);
    res.status(200).json({ message: "dispatchOrderDelivery", data });
  },
);

// Core of getOrderDeliveryStatus, factored out for the same reason as
// dispatchDeliveryForPharmacy above.
export const refreshDeliveryForPharmacy = async (
  pharmacy: IPharmacy,
  orderId: string,
) => {
  if (!isValidObjectId(orderId)) throw new BadInputError();

  const delivery = await DeliveryRide.findOne({
    order: orderId,
    pharmacy: pharmacy._id,
  });
  if (!delivery) throw new NotFoundError();

  const { ride_info } = await snappClient.refreshRide(delivery.hri);
  delivery.currentState = ride_info.current_state;
  delivery.finalPrice = ride_info.final_price;
  delivery.driverName = ride_info.name;
  delivery.driverCellphone = ride_info.cellphone;
  delivery.shareUrl = ride_info.shareurl;
  delivery.lastRefreshedAt = new Date();
  await delivery.save();
  return delivery;
};

// Refreshes a dispatched delivery's latest status from Snapp
// (Lib/snappClient.refreshRide) and persists it on the DeliveryRide doc.
export const getOrderDeliveryStatus: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { nodeId } = req.params;
    const data = await refreshDeliveryForPharmacy(req.pharmacy, nodeId);
    res.status(200).json({ message: "getOrderDeliveryStatus", data });
  },
);

const mutateProductPackageSchema = z.strictObject({
  name: z.string().optional(),
  category: z.string().optional(),
  image: z.string().optional(),
  products: z.array(z.string()).optional(),
  price: numerish(0, Number.MAX_SAFE_INTEGER).optional(),
  discount: numerish(0, Number.MAX_SAFE_INTEGER).optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  whyChoose: z.string().optional(),
  isActive: boolish.optional(),
  order: numerish(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).optional(),
});

// Products a pharmacy may include in one of its own packages must be products it
// actually sells (i.e. it already has a ProductSeller for them).
const assertOwnableProductPackageRefs = async (
  pharmacyId: Types.ObjectId,
  data: z.infer<typeof mutateProductPackageSchema>,
): Promise<boolean> => {
  if (data.category !== undefined && !isValidObjectId(data.category))
    return false;
  if (data.products?.some((id) => !isValidObjectId(id))) return false;
  if (data.products?.length) {
    const ownedCount = await ProductSeller.countDocuments({
      seller: pharmacyId,
      product: { $in: data.products },
    });
    if (ownedCount !== new Set(data.products).size) return false;
  }
  return true;
};

export const createMyProductPackage: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { data, success } = await mutateProductPackageSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    if (!(await assertOwnableProductPackageRefs(req.pharmacy._id, data)))
      return next(new BadInputError());
    await ProductPackage.create({ ...data, owner: req.pharmacy._id });
    res.status(200).json({ message: "createMyProductPackage" });
  },
);

export const editMyProductPackage: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await mutateProductPackageSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    if (!(await assertOwnableProductPackageRefs(req.pharmacy._id, data)))
      return next(new BadInputError());
    const node = await ProductPackage.findOne({
      _id: nodeId,
      owner: req.pharmacy._id,
    });
    if (!node) return next(new NotFoundError());
    await ProductPackage.findByIdAndUpdate(node._id, data);
    res.status(200).json({ message: "editMyProductPackage" });
  },
);

export const removeMyProductPackage: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await ProductPackage.findOne({
      _id: nodeId,
      owner: req.pharmacy._id,
    });
    if (!node) return next(new NotFoundError());
    await ProductPackage.findByIdAndDelete(node._id);
    res.status(200).json({ message: "removeMyProductPackage" });
  },
);

// Pharmacy-facing license catalog + purchase (2026-09) - lets a pharmacy buy
// one of the admin-managed BasePharmacyLicense tiers, unlocking the
// dashboard modules that tier grants. Mirrors
// doctorController.getMyLicenseOverview/purchaseLicense/
// resolveMyLicenseModules/requireLicenseModule/getMyLicenseModules. See
// Models/BasePharmacyLicense.ts (the catalog) and
// Models/PharmacyProfileLicense.ts (the pharmacy's own current license
// record, one per pharmacy).
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
    if (!req.pharmacy) return next(new MiddlewareError());
    const licenses = await BasePharmacyLicense.find({
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
    if (!req.pharmacy) return next(new MiddlewareError());
    const licenses = await BasePharmacyLicense.find({ isActive: true })
      .sort({ order: 1 })
      .select("-details");
    const durations = await findReferencedDurations(licenses);
    res.status(200).json({
      message: "getActiveLicenses",
      // `modules` here is the full pharmacyDashboardModules enum, not just
      // whatever the returned licenses' own `modules[]` happen to include -
      // lets the "see all plans" page render a full plan-vs-module
      // comparison.
      data: { licenses, durations, modules: pharmacyDashboardModules },
    });
  },
);

// Single-plan fetch (2026-09) for a plan-detail page - returns the full
// BasePharmacyLicense document (details included, unlike the list
// endpoints above) with each pricing entry's duration populated inline,
// since there's only one document here to enrich.
export const getLicenseById: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const license = await BasePharmacyLicense.findById(nodeId).populate(
      "pricing.duration",
    );
    if (!license) return next(new NotFoundError());
    res.status(200).json({ message: "getLicenseById", data: license });
  },
);

// Dashboard-home widget fetch (2026-09) - the pharmacy's own currently
// assigned PharmacyProfileLicense (if any), plus whether it's expired.
// Unlike resolveMyLicenseModules below (which silently falls back to the
// isDefault tier's modules on expiry, for gating purposes), the widget
// needs the raw record and expiry state directly so it can show "no
// license" / "expired" rather than pretending the fallback tier was
// actually purchased.
export const getMyCurrentLicense: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const current = await PharmacyProfileLicense.findOne({
      owner: req.pharmacy._id,
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
    if (!req.pharmacy || !req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data: input, success } = await purchaseLicenseSchema.safeParseAsync(
      req.body,
    );
    if (!success || !isValidObjectId(input.duration))
      return next(new BadInputError());
    const license = await BasePharmacyLicense.findById(nodeId);
    if (!license) return next(new NotFoundError());

    // A pharmacy with an active (non-expired) ProfileLicense can't buy
    // another plan until it expires (2026-09) - avoids double-charging and
    // silently clobbering time still left on the current plan. Same
    // expiry check getMyCurrentLicense/resolveMyLicenseModules use.
    const existingLicense = await PharmacyProfileLicense.findOne({
      owner: req.pharmacy._id,
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

    const data = await PharmacyProfileLicense.findOneAndUpdate(
      { owner: req.pharmacy._id },
      {
        owner: req.pharmacy._id,
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
        pharmacy: req.pharmacy._id,
        pharmacyLicense: license._id,
      });
    }

    res.status(200).json({ message: "purchaseLicense", data });
  },
);

// Resolves which dashboard modules a pharmacy currently has access to
// (2026-09), shared by requireLicenseModule (single-module gate on a route)
// and getMyLicenseModules (the full resolved set, for the frontend to gate
// whole pages with).
//
// Resolution order:
//  1. If this pharmacy already has a PharmacyProfileLicense AND it isn't
//     expired (expiresAt unset, or still in the future - see
//     pharmacyController.purchaseLicense for how expiresAt gets set), that
//     record's `modules` is authoritative.
//  2. Otherwise (no record, or an expired one) fall back to whichever
//     BasePharmacyLicense tier has `isDefault: true` (at most one is
//     expected, per that field's own comment) - a pharmacy who never
//     purchased anything, or whose purchase lapsed, is treated as being on
//     the default tier.
//  3. If no BasePharmacyLicense is marked default either, there is nothing
//     to gate against, so every module is considered allowed.
const resolveMyLicenseModules = async (
  pharmacyId: unknown,
): Promise<PharmacyDashboardModule[]> => {
  const current = await PharmacyProfileLicense.findOne({ owner: pharmacyId });
  const isExpired = !!current?.expiresAt && current.expiresAt < new Date();
  if (current && !isExpired) return current.modules;

  const defaultLicense = await BasePharmacyLicense.findOne({
    isDefault: true,
  });
  if (!defaultLicense) return [...pharmacyDashboardModules];
  return defaultLicense.modules;
};

// Gates a route behind a dashboard module the pharmacy's license must
// grant. Meant to sit after aclController.usePharmacy(...) in a route's
// middleware chain, same as any other req.pharmacy-dependent check here.
export const requireLicenseModule = (
  mod: PharmacyDashboardModule,
): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const modules = await resolveMyLicenseModules(req.pharmacy._id);
    if (!modules.includes(mod)) return next(new AccessError());
    next();
  });

// Pharmacy-facing resolved module list (2026-09) - lets the frontend gate an
// entire page with a friendly notice instead of letting the underlying API
// calls fail with AccessError. Deliberately not gated by any specific
// action - every pharmacy-context request, owner or delegated secretary,
// needs this to know what it can show.
export const getMyLicenseModules: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.pharmacy) return next(new MiddlewareError());
    const data = await resolveMyLicenseModules(req.pharmacy._id);
    res.status(200).json({ message: "getMyLicenseModules", data });
  },
);
