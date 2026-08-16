import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import * as z from "zod";
import AppError, {
  AccessError,
  BadInputError,
  MiddlewareError,
  MissingTaminTokenError,
} from "../Lib/AppError";
import ParaClinic from "../Models/Paraclinic";
import BecomeParaClinicRequest from "../Models/BecomeParaClinicRequest";
import DoctorTaminCred from "../Models/DoctorTaminCred";
import makeTaminRequest from "../Lib/MakeTamjinRequest";
import TaminIcid from "../Models/TaminIdid";

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
