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
import * as z from "zod";
import Pharmacy from "../Models/Pharmacy";
import BecomePharmacyRequest from "../Models/BecomePharmacyRequest";
import DoctorTaminCred from "../Models/DoctorTaminCred";
import makeTaminRequest from "../Lib/MakeTamjinRequest";
import PharmacyTaminPrescription from "../Models/PharmacyTaminPrescription";
import PharmacyTaminPrescriptionItem from "../Models/PharmacyTaminPrescriptionItem";
import PharmacyFilledPrescription from "../Models/PharmacyFilledPrescription";
import PharmacyFilledPrescriptionItem from "../Models/PharmacyFilledPrescriptionItem";
import { isValidObjectId } from "mongoose";

const becomePharmacyRequestSchema = z.strictObject({ name: z.string() });
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
    await BecomePharmacyRequest.findOneAndUpdate(
      { user: req.user._id },
      {
        ...data,
        user: req.user._id,
        status: "Pending",
      },
      { upsert: true },
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
