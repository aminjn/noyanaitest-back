import { todayStart } from "../Lib/dateUtils";
import { aclAllows } from "./aclController";
import {
  NextFunction,
  Request,
  RequestHandler,
  response,
  Response,
} from "express";
import * as env from "../Lib/Env";
import path from "path";
import fs from "fs/promises";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  AccessError,
  ActiveLicenseExistsError,
  BadInputError,
  BadTaminResponseError,
  DoctorsOnlyError,
  MiddlewareError,
  MissingTaminTokenError,
  NotFoundError,
  ServerError,
  TaminRideError,
} from "../Lib/AppError";
import BecomeDoctorRequest, {
  genders,
  medicalSystemTitles,
} from "../Models/BecomeDoctorRequest";
import { notifyUserAlertSubscribers } from "../Services/userAlertService";
import * as z from "zod";
import { provinces, provinceSlugs } from "../Lib/Provinces";
import { citySlugs } from "../Lib/Cities";
import { isValidObjectId, Model, Types } from "mongoose";
import Speciality from "../Models/Speciality";
import Province from "../Models/Geo/Province";
import City from "../Models/Geo/City";
import District from "../Models/Geo/District";
import DoctorProfile, { IDoctorProfile } from "../Models/DoctorProfile";
import ClinicDoctor from "../Models/ClinicDoctor";
import DoctorJoinClinicRequest from "../Models/DoctorJoinClinicRequest";
import ClinicAdditionRequest from "../Models/ClinicAdditionRequest";
import Clinic from "../Models/Clinic";
import HospitalDoctor from "../Models/HospitalDoctor";
import DoctorJoinHospitalRequest from "../Models/DoctorJoinHospitalRequest";
import HospitalAdditionRequest from "../Models/HospitalAdditionRequest";
import Hospital from "../Models/Hospital";
import {
  boolish,
  createCodeVerifier,
  datish,
  getSessionDateKey,
  isPoint,
  nullish,
  numerish,
  phonish,
  sleep,
  startOfTomorrow,
  toCodeChallenge,
} from "../Lib/helpers";
import { isSSID, validateProvinceAndCity } from "../Lib/validators";
import User from "../Models/User";
import { cookieOptions, extractDataFromCookie } from "./authController";
import DoctorSession, {
  DoctorSessionType,
  doctorSessionTypes,
  PatientStatus,
  patientStatuses,
} from "../Models/DoctorSession";
import Reservation from "../Models/Reservation";
import { doctorSessionKindSettingsModelDict } from "./bookingController";
import DoctorInsurance from "../Models/DoctorInsurance";
import Insurance from "../Models/Insurance";
import InsuranceAdditionRequest from "../Models/InsuranceAdditionRequest";
import DoctorPharmacy from "../Models/DoctorPharmacy";
import Pharmacy from "../Models/Pharmacy";
import PharmacyAdditionRequest from "../Models/PharmacyAdditionRequest";
import DoctorPatient from "../Models/DoctorPatient";
import UserVital from "../Models/UserVitals";
import PatientProfile from "../Models/PatiantProfile";
import PatientProfileRecord from "../Models/PatientProfileRecord";
import UserFile from "../Models/UserFile";
import GalleryItem from "../Models/GalleryItem";
import UserIdentity, { IUserIdentity } from "../Models/UserIdentity";
import Office, { IOffice } from "../Models/Office";
import Service from "../Models/Service";
import ServicePackage from "../Models/ServicePackage";
import Order from "../Models/Order";
import BadEvent from "../Models/BadEvent";
import McCode from "../Models/McCode";
import DoctorSocialMedia, { socialMedias } from "../Models/DoctorSocialMedia";
import DoctorFaq from "../Models/DoctorFaq";
import DoctorTaminCred from "../Models/DoctorTaminCred";
import TaminService, { ITaminService } from "../Models/TaminService";
import TaminDrugInstruction, {
  ITaminDrugInstruction,
} from "../Models/TaminDrugInstruction";
import TaminDrugUsage, { ITaminDrugUsage } from "../Models/TaminDrugUsage";
import TaminDrugAmount, { ITaminDrugAmount } from "../Models/TaminDrugAmount";
import FavoriteDrug from "../Models/FavoriteDrug";
import Prescription, { IPrescription } from "../Models/Prescription";
import moment, { duration } from "moment-jalaali";
import TaminPrescription from "../Models/TaminPrescription";
import makeTaminRequest from "../Lib/MakeTamjinRequest";
import TaminServiceType from "../Models/TaminServiceType";
import BaseDoctorLicense, {
  doctorDashboardModules,
  DoctorDashboardModule,
} from "../Models/BaseDoctorLicense";
import DoctorProfileLicense from "../Models/DoctorProfileLicense";
import LicenseDuration from "../Models/LicenseDuration";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import DoctorShift, {
  DoctorShiftDay,
  doctorShiftDays,
} from "../Models/DoctorShift";
import updateDoctorAvailability from "../Lib/updateDoctorAvailablity";
import Booking from "../Models/Booking";

const SERACH_LIMIT = 10;

const becomeDoctorSchema = z.strictObject({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  ssid: z.string().trim().length(10),
  gender: z.enum(genders),
  medicalSystemTitle: z.enum(medicalSystemTitles),
  medicalSystemCode: z.string().min(1),
  province: z.enum(provinceSlugs),
  city: z.enum(citySlugs),
  address: z.string().trim().min(1),
  description: z.string().optional(),
  specialities: z.array(z.string()).min(1),
});

export const becomeDoctor: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const cur = await DoctorProfile.findOne({ user: req.user._id });
    if (!!cur) return next(new AppError("شما قبلا پزشک شده اید", 409));
    const pending = await BecomeDoctorRequest.exists({
      user: req.user._id,
      status: "Pending",
    });
    if (pending)
      return next(
        new AppError("درخواست شما قبلا ثبت شده در دست بررسی میباشد", 411),
      );
    const { data, success } = await becomeDoctorSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    if (!validateProvinceAndCity(data.province, data.city))
      return next(new BadInputError());
    const uniqueIds = new Set(data.specialities);
    if (uniqueIds.size !== data.specialities.length)
      return next(new BadInputError());
    for (let i = 0; i < data.specialities.length; ++i) {
      const _id = data.specialities[i];
      if (!isValidObjectId(_id)) return next(new BadInputError());
      const exists = await Speciality.exists({ _id });
      if (!exists) return next(new NotFoundError());
    }
    const becomeDoctorRequest = await BecomeDoctorRequest.findOneAndUpdate(
      { user: req.user._id },
      {
        ...data,
        user: req.user._id,
        status: "Pending",
      },
      { upsert: true, new: true },
    );
    notifyUserAlertSubscribers(
      "newBecomeDoctorRequest",
      {
        title: "درخواست پزشک شدن",
        message: `کاربر ${req.user.phone} درخواست پزشک شدن ثبت کرد.`,
      },
      {
        requestId: becomeDoctorRequest._id.toString(),
        userPhone: req.user.phone,
      },
    ).catch((err) =>
      console.log(
        `[doctorController] failed to notify staff of becomeDoctor request by ${req.user?._id}:`,
        err,
      ),
    );
    res.status(200).json({ message: "becomeDoctor" });
  },
);

export const getMyBecomeDoctorRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await McCode.find({ user: req.user._id });
    res
      .status(200)
      .json({ message: "getMyBecomeDoctorRequest", data: { data } });
  },
);

export const getMyMedicalSystemInfo: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const identity = await UserIdentity.findOne({ user: req.user._id });
    if (!identity) return next(new AppError("احراز هویت شما یافت نشد", 400));
    let result;
    const params = new URLSearchParams();
    params.append("scProductId", "45682");
    params.append("scApiKey", env.GET_MEDICAL_SYSTEM_CODE_API_KEY);
    params.append("nationalCode", identity.nationalId);
    try {
      const response = await fetch(env.podiumUrl2, {
        method: "POST",
        headers: {
          _token_: env.PODIUM_TOKEN,
          _token_issuer_: "1",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });
      const data = (await response.json()) as PodiumResponse2;
      if (data.hasError || !data.result?.result) throw new Error(data.message);
      const mcResult = JSON.parse(data.result.result) as GetMcCodesResponse;
      result = mcResult;
      if (!mcResult.IsSuccess || !mcResult.Result) {
        await BadEvent.create({
          place: "GetMedicalCodes",
          payload: JSON.stringify({
            incoming: req.user.phone,
            error: mcResult.Message,
          }),
        });
        return next(
          new AppError(
            mcResult.Message || "خطایی در استعلام کد نظام پزشکی رخ داد",
            400,
          ),
        );
      }
      for (let i = 0; i < mcResult.Result.length; ++i) {
        await McCode.findOneAndUpdate(
          { user: req.user._id, mcCode: mcResult.Result[i].McCode },
          {
            user: req.user._id,
            mcCode: mcResult.Result[i].McCode,
          },
          { upsert: true },
        );
      }
    } catch (e) {
      await BadEvent.create({
        place: "GetMedicalCodes",
        payload: JSON.stringify({
          incoming: req.user.phone,
          error: e instanceof Error ? e.message : "UNKNOWN",
        }),
      });
      return next(new AppError("سرویس استعلام کد نظام پزشکی فعال نیست", 400));
    }
    res.status(200).json({ message: "getMyMedicalSystemInfoi" });
  },
);

type PodiumResponse2 = {
  hasError: boolean;
  message?: string;
  result?: {
    result?: string;
  };
};

type GetMcCodesResponse = {
  Result: { McCode: string }[] | null;
  IsSuccess: boolean;
  Message: string | null;
};

export const getMyMcCodeDetails: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await McCode.findOne({ user: req.user._id, _id: nodeId });
    if (!node) return next(new NotFoundError());
    if (node.title)
      return res
        .status(200)
        .json({ message: "getMyMcCodeDetails", data: node });
    const params = new URLSearchParams();
    params.append("scApiKey", env.GET_MC_CERTIFICATE_API_KEY);
    params.append("scProductId", "115027");
    params.append("mcCode", node.mcCode);
    try {
      const response = await fetch(env.podiumUrl2, {
        method: "POST",
        headers: {
          _token_: env.PODIUM_TOKEN,
          _token_issuer_: "1",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });
      const data = (await response.json()) as PodiumResponse2;
      if (data.hasError || !data.result?.result)
        throw new Error("سیستم نظام پزشکی جمهوری اسلامی در دسترس نیست");
      const mcData = JSON.parse(data.result.result) as McDetailResponse;
      if (!mcData.IsSuccess || !mcData.Result) {
        await BadEvent.create({
          place: "GetMcDetails",
          payload: JSON.stringify({
            incoming: req.user.phone,
            error: mcData.Message || "Unknown",
          }),
        });
        return next(
          new AppError(
            mcData.Message || "خطایی در دریافت جزئیات کد نظام پزشکی رخ داد",
            400,
          ),
        );
      }
      const newNode = await McCode.findOneAndUpdate(
        { _id: node._id },
        {
          title: mcData.Result?.Spec_DegreeFieldTitle,
          city: mcData.Result?.Spec_InstituteCityTitle,
          acquiredAt: mcData.Result?.Spec_DateShamsi,
        },
        { new: true },
      );
      return res
        .status(200)
        .json({ message: "getMyMcCodeDetails", data: newNode });
    } catch (e) {
      await BadEvent.create({
        place: "GetMcDetails",
        payload: JSON.stringify({
          incoming: req.user.phone,
          error: e instanceof Error ? e.message : "Unknown",
        }),
      });
      return next(
        new AppError("خطایی در دریافت اطلاعات نظام پزشکی رخ داد", 400),
      );
    }
  },
);

type McDetailResponse = {
  Result: {
    Spec_DegreeFieldTitle: string;
    Spec_DateShamsi: string;
    Spec_InstituteCityTitle: string;
  } | null;
  IsSuccess: boolean;
  Message: null | string;
};

export const createMyDoctorProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const identity = await UserIdentity.findOne({ user: req.user._id });
    if (!identity) return next(new AppError("اطلاعات هویتی شما یافت نشد", 400));
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const mc = await McCode.findOne({ _id: nodeId, user: req.user._id });
    if (!mc) return next(new NotFoundError());
    const dup = await DoctorProfile.exists({ user: req.user._id });
    if (dup) return next(new AppError("پروفایل شما قبلا ساخته شده", 400));
    await DoctorProfile.create({
      firstName: identity.givenName,
      lastName: identity.lastName,
      gender: identity.gender,
      ssid: identity.nationalId,
      user: req.user._id,
      mcCode: mc._id,
    });
    res.status(200).json({ message: "createMyDoctorProfile" });
  },
);


export const getMyDoctorProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorProfile.findById(req.doctor._id).populate({
      path: "mcCode",
      select: "mcCode",
    });
    if (!data) return next(new DoctorsOnlyError());
    res.status(200).json({ message: "getMyDoctorProfile", data: { data } });
  },
);

const objectIdField = z
  .string()
  .refine((val) => isValidObjectId(val), { message: "invalid id" });

const updateProfileSchema = z.strictObject({
  location: isPoint.optional(),
  introduction: z.string().optional(),
  services: z.array(z.string()).optional(),
  achivements: z.array(z.string()).optional(),
  website: z.string().optional(),
  landLine: z.string().optional(),
  address: z.string().optional(),
  province: objectIdField.optional(),
  city: objectIdField.optional(),
  district: objectIdField.optional(),
  mainSpeciality: objectIdField.optional(),
  specialities: z.array(objectIdField).optional(),
});

export const updateMyProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success, error } = await updateProfileSchema.safeParseAsync(
      req.body,
    );
    console.log(error);
    if (!success) return next(new BadInputError());
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
    if (data.mainSpeciality) {
      const exists = await Speciality.exists({
        _id: data.mainSpeciality,
        active: true,
      });
      if (!exists) return next(new NotFoundError("تخصص"));
    }
    if (data.specialities) {
      const uniqueIds = new Set(data.specialities);
      if (uniqueIds.size !== data.specialities.length)
        return next(new BadInputError());
      const count = await Speciality.countDocuments({
        _id: { $in: data.specialities },
        active: true,
      });
      if (count !== data.specialities.length)
        return next(new NotFoundError("تخصص"));
    }
    if (req.file) {
      const avatar = `Avatar__${req.doctor._id.toString()}__${new Date().getTime()}.${req.file.originalname
        .split(".")
        .findLast(() => true)}`;
      await fs.writeFile(
        path.join(process.cwd(), "Public", avatar),
        req.file.buffer,
      );
      payload.avatar = avatar;
    }
    await DoctorProfile.findByIdAndUpdate(req.doctor._id, payload);
    res.status(200).json({ message: "updateMyProfile" });
  },
);

export const searchShitByName: (args: {
  model: Model<any>;
}) => RequestHandler = ({ model }) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { query: _name } = req.body;
    if (typeof _name !== "string") return next(new BadInputError());
    const name = _name.trim();
    if (name.length < 3) return next(new BadInputError());
    const data = await model
      .find({
        name: {
          $regex: new RegExp(
            name
              .split(" ")
              .map((seg) => `(?=.*${seg})`)
              .join(""),
          ),
        },
        active: true,
      })
      .sort({ order: 1, _id: 1 })
      .select({ name: 1, address: 1 })
      .limit(SERACH_LIMIT);
    res.status(200).json({ message: "searchShitByName", data });
  });

export const getMyClinics: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await ClinicDoctor.find({ doctor: req.doctor._id }).populate([
      { path: "clinic", select: { name: 1, slug: 1 } },
      { path: "department", select: { name: 1 } },
    ]);
    res.status(200).json({ message: "getMyClinics", data });
  },
);

export const getMyJoinClinicRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorJoinClinicRequest.find({
      doctor: req.doctor._id,
    }).populate({ path: "clinic" });
    res.status(200).json({ message: "getMyJoinClinicRequest", data });
  },
);

export const getMyClinicAdditionRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await ClinicAdditionRequest.find({
      submittedBy: req.doctor._id,
    });
    res.status(200).json({ message: "getMyClinicAdditionRequests", data });
  },
);

const respondToJoinClinicSchema = z.strictObject({
  status: z.enum(["Approved", "Rejected"]),
});

// The doctor's answer to a join request the clinic sent them
// (submissionParty "Clinic", still Pending). Approving creates the
// ClinicDoctor membership; rejecting just records the answer.
export const toggleJoinClinicRequestStatus: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = respondToJoinClinicSchema.safeParse(req.body);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const node = await DoctorJoinClinicRequest.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
      submissionParty: "Clinic",
      status: "Pending",
    });
    if (!node) return next(new NotFoundError());
    if (parsed.data.status === "Approved")
      await ClinicDoctor.findOneAndUpdate(
        { clinic: node.clinic._id, doctor: req.doctor._id },
        { clinic: node.clinic._id, doctor: req.doctor._id },
        { upsert: true },
      );
    await DoctorJoinClinicRequest.findByIdAndUpdate(node._id, {
      status: parsed.data.status,
      statusLastChangedAt: new Date(),
    });
    res.status(200).json({ message: "toggleJoinClinicRequestStatus" });
  },
);

export const resubmitJoinClinicRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await DoctorJoinClinicRequest.findOne({
      status: "Rejected",
      doctor: req.doctor._id,
      _id: nodeId,
    });
    if (!node) return next(new NotFoundError());
    const joined = await ClinicDoctor.exists({
      clinic: node.clinic._id,
      doctor: node.doctor._id,
    });
    if (joined) {
      await DoctorJoinClinicRequest.findByIdAndUpdate(node._id, {
        status: "Approved",
      });
      return next(new AppError("شما در حال حاضر عضو این کلینیک هستید", 400));
    }
    await DoctorJoinClinicRequest.findByIdAndUpdate(node._id, {
      status: "Pending",
    });
    res.status(200).json({ message: "resubmitJoinClinicRequest" });
  },
);

const joinClinicRequestSchema = z.strictObject({
  message: z.string().optional(),
  clinic: z.string(),
});
export const submitAJoinClinicRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());

    const { data, success } = await joinClinicRequestSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(data.clinic)) return next(new BadInputError());
    const clinic = await Clinic.findOne({ _id: data.clinic, active: true });
    if (!clinic) return next(new NotFoundError());
    const dup = await DoctorJoinClinicRequest.exists({
      doctor: req.doctor._id,
      clinic: clinic._id,
    });
    if (dup) return next(new AppError("درخواست شما قبلا ثبت شده", 400));
    const joined = await ClinicDoctor.exists({
      doctor: req.doctor._id,
      clinic: clinic._id,
    });
    if (joined)
      return next(new AppError("شما در حال حاضر در این کلینیک هستید", 400));
    await DoctorJoinClinicRequest.create({
      submissionParty: "DoctorProfile",
      doctor: req.doctor._id,
      clinic: clinic._id,
      message: data.message,
    });
    res.status(200).json({ message: "submitAJoinClinicRequest" });
  },
);

const clinicAdditionRequestSchema = z.strictObject({
  clinicName: z.string().trim().min(1),
  ownerName: z.string().trim().min(1),
  ownerPhone: z.string().regex(/^\d+$/),
  province: z.enum(provinceSlugs),
  city: z.enum(citySlugs),
  clinicAddress: z.string().trim().min(1),
  description: z.string().optional(),
});
export const submitAClinicAdditionRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { success, data } = await clinicAdditionRequestSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    if (!validateProvinceAndCity(data.province, data.city))
      return next(new BadInputError());
    const clinicAdditionRequest = await ClinicAdditionRequest.create({
      ...data,
      submittedBy: req.doctor._id,
    });
    notifyUserAlertSubscribers(
      "newClinicAdditionRequest",
      {
        title: "درخواست افزودن کلینیک",
        message: `پزشکی درخواست افزودن کلینیک «${data.clinicName}» را ثبت کرد.`,
      },
      {
        requestId: clinicAdditionRequest._id.toString(),
        name: data.clinicName,
      },
    ).catch((err) =>
      console.log(
        `[doctorController] failed to notify staff of clinic addition request by ${req.doctor?._id}:`,
        err,
      ),
    );
    res.status(200).json({ message: "submitAClinicAdditionRequest" });
  },
);

export const leaveClinic: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await ClinicDoctor.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
    });
    if (!node) return next(new NotFoundError());
    await ClinicDoctor.findByIdAndDelete(node._id);
    res.status(200).json({ message: "leaveClinic" });
  },
);

// Hospital counterparts of the clinic-join functions above (2026-09) - one
// doctor dashboard, both org types (minus prescriptions, which hospitals
// don't have). Mirrors getMyClinics/getMyJoinClinicRequests/
// getMyClinicAdditionRequests/toggleJoinClinicRequestStatus/
// resubmitJoinClinicRequest/submitAJoinClinicRequest/
// submitAClinicAdditionRequest/leaveClinic above.
export const getMyHospitals: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await HospitalDoctor.find({ doctor: req.doctor._id }).populate(
      [
        { path: "hospital", select: { name: 1, slug: 1 } },
        { path: "department", select: { name: 1 } },
      ],
    );
    res.status(200).json({ message: "getMyHospitals", data });
  },
);

export const getMyJoinHospitalRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorJoinHospitalRequest.find({
      doctor: req.doctor._id,
    }).populate({ path: "hospital" });
    res.status(200).json({ message: "getMyJoinHospitalRequest", data });
  },
);

export const getMyHospitalAdditionRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await HospitalAdditionRequest.find({
      submittedBy: req.doctor._id,
    });
    res.status(200).json({ message: "getMyHospitalAdditionRequests", data });
  },
);

const respondToJoinHospitalSchema = z.strictObject({
  status: z.enum(["Approved", "Rejected"]),
});

// The doctor's answer to a join request the hospital sent them
// (submissionParty "Hospital", still Pending). Approving creates the
// HospitalDoctor membership; rejecting just records the answer.
export const toggleJoinHospitalRequestStatus: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = respondToJoinHospitalSchema.safeParse(req.body);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const node = await DoctorJoinHospitalRequest.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
      submissionParty: "Hospital",
      status: "Pending",
    });
    if (!node) return next(new NotFoundError());
    if (parsed.data.status === "Approved")
      await HospitalDoctor.findOneAndUpdate(
        { hospital: node.hospital._id, doctor: req.doctor._id },
        { hospital: node.hospital._id, doctor: req.doctor._id },
        { upsert: true },
      );
    await DoctorJoinHospitalRequest.findByIdAndUpdate(node._id, {
      status: parsed.data.status,
      statusLastChangedAt: new Date(),
    });
    res.status(200).json({ message: "toggleJoinHospitalRequestStatus" });
  },
);

export const resubmitJoinHospitalRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await DoctorJoinHospitalRequest.findOne({
      status: "Rejected",
      doctor: req.doctor._id,
      _id: nodeId,
    });
    if (!node) return next(new NotFoundError());
    const joined = await HospitalDoctor.exists({
      hospital: node.hospital._id,
      doctor: node.doctor._id,
    });
    if (joined) {
      await DoctorJoinHospitalRequest.findByIdAndUpdate(node._id, {
        status: "Approved",
      });
      return next(new AppError("شما در حال حاضر عضو این بیمارستان هستید", 400));
    }
    await DoctorJoinHospitalRequest.findByIdAndUpdate(node._id, {
      status: "Pending",
    });
    res.status(200).json({ message: "resubmitJoinHospitalRequest" });
  },
);

const joinHospitalRequestSchema = z.strictObject({
  message: z.string().optional(),
  hospital: z.string(),
});
export const submitAJoinHospitalRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());

    const { data, success } = await joinHospitalRequestSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(data.hospital)) return next(new BadInputError());
    const hospital = await Hospital.findOne({
      _id: data.hospital,
      isActive: true,
    });
    if (!hospital) return next(new NotFoundError());
    const dup = await DoctorJoinHospitalRequest.exists({
      doctor: req.doctor._id,
      hospital: hospital._id,
    });
    if (dup) return next(new AppError("درخواست شما قبلا ثبت شده", 400));
    const joined = await HospitalDoctor.exists({
      doctor: req.doctor._id,
      hospital: hospital._id,
    });
    if (joined)
      return next(new AppError("شما در حال حاضر در این بیمارستان هستید", 400));
    await DoctorJoinHospitalRequest.create({
      submissionParty: "DoctorProfile",
      doctor: req.doctor._id,
      hospital: hospital._id,
      message: data.message,
    });
    res.status(200).json({ message: "submitAJoinHospitalRequest" });
  },
);

const hospitalAdditionRequestSchema = z.strictObject({
  hospitalName: z.string().trim().min(1),
  ownerName: z.string().trim().min(1),
  ownerPhone: z.string().regex(/^\d+$/),
  province: z.enum(provinceSlugs),
  city: z.enum(citySlugs),
  hospitalAddress: z.string().trim().min(1),
  description: z.string().optional(),
});
export const submitAHospitalAdditionRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { success, data } =
      await hospitalAdditionRequestSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    if (!validateProvinceAndCity(data.province, data.city))
      return next(new BadInputError());
    const hospitalAdditionRequest = await HospitalAdditionRequest.create({
      ...data,
      submittedBy: req.doctor._id,
    });
    notifyUserAlertSubscribers(
      "newHospitalAdditionRequest",
      {
        title: "درخواست افزودن بیمارستان",
        message: `پزشکی درخواست افزودن بیمارستان «${data.hospitalName}» را ثبت کرد.`,
      },
      {
        requestId: hospitalAdditionRequest._id.toString(),
        name: data.hospitalName,
      },
    ).catch((err) =>
      console.log(
        `[doctorController] failed to notify staff of hospital addition request by ${req.doctor?._id}:`,
        err,
      ),
    );
    res.status(200).json({ message: "submitAHospitalAdditionRequest" });
  },
);

export const leaveHospital: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await HospitalDoctor.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
    });
    if (!node) return next(new NotFoundError());
    await HospitalDoctor.findByIdAndDelete(node._id);
    res.status(200).json({ message: "leaveHospital" });
  },
);

export const getSessions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new BadInputError());
    const { stamp: _stamp } = req.query;
    if (typeof _stamp !== "string") return next(new BadInputError());
    const stamp = new Date(_stamp);
    if (isNaN(stamp.getTime())) return next(new BadInputError());
    const data = await DoctorSession.find({
      doctor: req.doctor._id,
      date: getSessionDateKey(stamp),
    });
    res.status(200).json({ message: "getSessions", data });
  },
);

// Doctor-side counterpart of userController.getMyReservation, scoped by
// doctor instead of patient - powers app/doctorpanel/booking/[nodeId]
// (DoctorManageBookingPage), which also surfaces the inPerson check-in
// action below.
export const getMyDoctorReservation: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Reservation.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
    }).populate([{ path: "user" }, { path: "patient" }, { path: "office" }]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyDoctorReservation", data });
  },
);

// inPerson reservations have no automatic signal for "both parties are
// here" (unlike textChat/voiceCall/videoCall/sipCall, which mark presence
// themselves - see Services/reservationProgressService.ts), so the doctor
// checks the patient in manually once they've arrived at the office. Marks
// both sides present: the doctor is necessarily present to be performing
// this action, and the patient's arrival is exactly what it's reporting.
export const checkInReservation: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const reservation = await Reservation.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
      sessionType: "inPerson",
    });
    if (!reservation) return next(new NotFoundError());
    if (!["pending", "active"].includes(reservation.status))
      return next(new AppError("این نوبت قابل ثبت حضور نیست", 400));
    const now = new Date();
    if (!reservation.patientPresentAt) reservation.patientPresentAt = now;
    if (!reservation.doctorPresentAt) reservation.doctorPresentAt = now;
    await reservation.save();
    res.status(200).json({ message: "checkInReservation", data: reservation });
  },
);

const addSessionsSchema = z.strictObject({
  start: numerish(0, 1440),
  end: numerish(0, 1440),
  duration: numerish(1, 1440),
  gap: numerish(0, 1440),
  note: z.string().optional(),
  days: z.preprocess((val) => {
    if (typeof val === "string")
      try {
        return JSON.parse(val);
      } catch {}
    return val;
  }, z.array(datish)),
  ...doctorSessionTypes.reduce(
    (acc, el) => ({ ...acc, [el]: boolish.optional() }),
    {} as Record<DoctorSessionType, unknown>,
  ),
  ...patientStatuses.reduce(
    (acc, el) => ({ ...acc, [el]: boolish.optional() }),
    {} as Record<PatientStatus, unknown>,
  ),
  clinic: z.string().optional(),
});

export const addSessions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = await addSessionsSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    if (data.end <= data.start) return next(new BadInputError());
    if (data.end - data.start <= data.duration)
      return next(new BadInputError());
    if (!doctorSessionTypes.some((t) => !!data[t]))
      return next(
        new AppError("لطفا حداقل یک مورد نوع جلسه را انتخاب کنید", 400),
      );
    if (!patientStatuses.some((s) => !!data[s]))
      return next(new AppError("لطفا حئاقل یک نوع بیمار را انتخاب کنید", 400));
    let clinic: IOffice | undefined | null;
    if (data.inPerson && data.clinic) {
      clinic = await Office.findOne({
        _id: data.clinic,
        doctor: req.doctor._id,
      });
      if (!clinic) return next(new NotFoundError());
    }
    const tomorrow = startOfTomorrow();
    const sessionsToInsert = [];
    for (let i = 0; i < data.days.length; ++i) {
      const day = data.days[i];
      if (day.getTime() < tomorrow.getTime()) continue;
      const dateKey = getSessionDateKey(day);
      for (
        let _start = data.start;
        _start < data.end;
        _start += data.duration + data.gap
      ) {
        const _end = _start + data.duration;
        if (_end > data.end) break;
        const isOverlapping = await DoctorSession.exists({
          doctor: req.doctor._id,
          date: dateKey,
          start: { $lt: _end },
          end: { $gt: _start },
        });
        if (isOverlapping) continue;
        sessionsToInsert.push({
          doctor: req.doctor._id,
          date: dateKey,
          start: _start,
          end: _end,
          note: data.note,
          textChat: data.textChat,
          sipCall: data.sipCall,
          videoCall: data.videoCall,
          voiceCall: data.voiceCall,
          inPerson: data.inPerson,
          oldPatient: data.oldPatient,
          newPatient: data.newPatient,
          clinic: clinic?._id,
        });
      }
    }
    if (sessionsToInsert.length)
      await DoctorSession.insertMany(sessionsToInsert);
    res.status(200).json({ message: "addSessions" });
  },
);

export const getSessionsByDaySummary: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { stamp: _stamp } = req.params;
    const stamp = new Date(isNaN(Number(_stamp)) ? _stamp : Number(_stamp));
    if (isNaN(stamp.getTime())) return next(new BadInputError());
    const data = await DoctorSession.find({
      date: getSessionDateKey(stamp),
      doctor: req.doctor._id,
    }).populate({ path: "booking", select: "_id" });
    res.status(200).json({ message: "getSessionsByDay", data });
  },
);

export const getSessionsByDayFull: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { stamp: _stamp } = req.params;
    const stamp = new Date(Number(_stamp));
    if (isNaN(stamp.getTime())) return next(new BadInputError());
    const data = await DoctorSession.find({
      date: getSessionDateKey(stamp),
      doctor: req.doctor._id,
    }).populate([{ path: "booking" }, { path: "clinic" }]);
    res.status(200).json({ message: "getSessionsByDayFull", data });
  },
);

// Merged per F-01: this used to query Booking only (System A), so a doctor
// checking their schedule would never see Reservations (System B) - the
// actively-developed flow every public entry point now goes through. Both
// lists are returned separately (their shapes aren't equivalent - see
// AUDIT/06_DATABASE_DRIFT.md 6.1) rather than forced into one array; the
// frontend groups them by day for display. See AUDIT/FIXES_TODO.md F-01.
export const getMySchedule: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const [bookings, reservations] = await Promise.all([
      Booking.find({ doctor: req.doctor._id }).populate([
        {
          path: "session",
          populate: [{ path: "clinic" }],
        },
        { path: "user", select: { username: 1, phone: 1 } },
        { path: "patient" },
      ]),
      Reservation.find({ doctor: req.doctor._id }).populate([
        { path: "user", select: { username: 1, phone: 1 } },
        { path: "patient" },
        { path: "office" },
      ]),
    ]);
    bookings.sort((a, b) => {
      const aDate = a.session?.date || "";
      const bDate = b.session?.date || "";
      if (aDate !== bDate) return aDate < bDate ? -1 : 1;
      return (a.session?.start || 0) - (b.session?.start || 0);
    });
    reservations.sort((a, b) => {
      const aDate = new Date(a.date).getTime();
      const bDate = new Date(b.date).getTime();
      if (aDate !== bDate) return aDate - bDate;
      return a.start - b.start;
    });
    res
      .status(200)
      .json({ message: "getMySchedule", data: { bookings, reservations } });
  },
);

export const deleteSession: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await DoctorSession.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
    }).populate("booking");
    if (!node) return next(new NotFoundError());
    if (node.booking)
      return next(new AppError("این جلسه رزرو شده و امکان حذف ندارد", 400));
    await DoctorSession.findByIdAndDelete(node._id);
    res.status(200).json({ message: "deleteSession" });
  },
);

const editSessionSchema = z.strictObject({
  start: numerish(0, 1440),
  end: numerish(0, 1440),
  note: z.string().optional(),
  ...doctorSessionTypes.reduce(
    (acc, el) => ({ ...acc, [el]: boolish.optional() }),
    {} as Record<DoctorSessionType, unknown>,
  ),
});
export const editSession: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = await editSessionSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    if (data.start >= data.end) return next(new BadInputError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await DoctorSession.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
    }).populate("booking");
    if (!node) return next(new NotFoundError());
    if (node.booking)
      return next(new AppError("این جلسه رزرو شده و امکان اصلاح ندارد", 400));
    const isOverlapping = await DoctorSession.exists({
      $and: [
        {
          doctor: req.doctor._id,
          date: node.date,
          start: { $lt: data.end },
          end: { $gt: data.start },
        },
        { _id: { $ne: node._id } },
      ],
    });
    if (isOverlapping)
      return next(
        new AppError("زمان درخواستی قبلا برای جلسه دیگر ثبت شده", 400),
      );
    //TODO: maybe check if there is at least one kind selected
    await DoctorSession.findByIdAndUpdate(node._id, {
      start: data.start,
      end: data.end,
      note: data.note,
      textChat: data.textChat,
      sipCall: data.sipCall,
      videoCall: data.videoCall,
      voiceCall: data.voiceCall,
      inPerson: data.inPerson,
    });
    res.status(200).json({ message: "editSession" });
  },
);

const createSessionSchema = z.strictObject({
  start: numerish(0, 1440),
  end: numerish(0, 1440),
  note: z.string().optional(),
  stamp: z.string(),
  ...doctorSessionTypes.reduce(
    (acc, el) => ({ ...acc, [el]: boolish.optional() }),
    {} as Record<DoctorSessionType, unknown>,
  ),
});
export const createSession: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = await createSessionSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const _stamp = new Date(Number(data.stamp));
    if (isNaN(_stamp.getTime())) return next(new BadInputError());
    if (_stamp < new Date()) return next(new BadInputError());
    const dateKey = getSessionDateKey(_stamp);
    //TODO: maybe check if there is at least one kind selected
    const isOverlapping = await DoctorSession.exists({
      doctor: req.doctor._id,
      date: dateKey,
      start: { $lt: data.end },
      end: { $gt: data.start },
    });
    if (isOverlapping)
      return next(
        new AppError("زمان انتخاب شده قبلا برای جلسه دیگری وارد شده است", 400),
      );
    await DoctorSession.create({
      date: dateKey,
      doctor: req.doctor._id,
      end: data.end,
      note: data.note,
      start: data.start,
      ...doctorSessionTypes.reduce(
        (acc, el) => ({ ...acc, [el]: data[el] }),
        {},
      ),
    });
    res.status(200).json({ message: "createSession" });
  },
);

export const getMySettings: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { kind: _kind } = req.params;
    const kind = doctorSessionTypes.find((el) => el === _kind);
    if (!kind) return next(new BadInputError());
    const data = await doctorSessionKindSettingsModelDict[
      kind
    ].findOneAndUpdate(
      { doctor: req.doctor._id },
      { doctor: req.doctor._id },
      { upsert: true, new: true },
    );
    res.status(200).json({ message: "getMySettings", data });
  },
);

const common = {
  price: numerish(0, Number.MAX_SAFE_INTEGER).optional(),
  active: boolish.optional(),
};

const editSettingsSchemaDict: Record<DoctorSessionType, z.ZodSchema<any>> = {
  inPerson: z.strictObject({ hidePrice: boolish.optional(), ...common }),
  sipCall: z.strictObject({
    //TODO: add Phone Validators
    receiver: z.string(),
    ...common,
  }),
  textChat: z.strictObject(common),
  videoCall: z.strictObject(common),
  voiceCall: z.strictObject(common),
  phone: z.strictObject(common),
};

export const editMySettings: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { kind: _kind } = req.params;
    const kind = doctorSessionTypes.find((el) => el === _kind);
    if (!kind) return next(new BadInputError());
    const { data, success, error } = await editSettingsSchemaDict[
      kind
    ].safeParseAsync(req.body);
    console.log(error);
    if (!success) return next(new BadInputError());
    await doctorSessionKindSettingsModelDict[kind].findOneAndUpdate(
      { doctor: req.doctor._id },
      { ...data, doctor: req.doctor._id },
      { upsert: true, new: true },
    );
    res.status(200).json({ message: "editMySettings" });
  },
);

export const getMyInsurances: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorInsurance.find({
      doctor: req.doctor._id,
    }).populate({ path: "insurance" });
    res.status(200).json({ message: "getMyInsurances", data });
  },
);

export const leaveInsurance: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await DoctorInsurance.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
    });
    if (!node) return next(new NotFoundError());
    await DoctorInsurance.findByIdAndDelete(node._id);
    res.status(200).json({ message: "leaveInsurance" });
  },
);

export const addInsurance: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await Insurance.findById(nodeId);
    if (!node) return next(new NotFoundError());
    const exists = await DoctorInsurance.exists({
      insurance: node._id,
      doctor: req.doctor._id,
    });
    if (exists)
      return next(new AppError("این بیمه در لیست بیمه های شما وجود داشت", 400));
    await DoctorInsurance.create({
      doctor: req.doctor._id,
      insurance: node._id,
    });
    res.status(200).json({ message: "addInsurance" });
  },
);

export const getMyInsuranceAdditions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await InsuranceAdditionRequest.find({
      submittedBy: req.doctor._id,
    });
    res.status(200).json({ message: "getMyInsuranceAdditions", data });
  },
);

const insuranceAdditionSubmissionSchema = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
});
export const submitInsuranceAddition: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } =
      await insuranceAdditionSubmissionSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const insuranceAdditionRequest = await InsuranceAdditionRequest.create({
      ...data,
      submittedBy: req.doctor._id,
    });
    notifyUserAlertSubscribers(
      "newInsuranceAdditionRequest",
      {
        title: "درخواست افزودن بیمه",
        message: `پزشکی درخواست افزودن بیمه «${data.name}» را ثبت کرد.`,
      },
      {
        requestId: insuranceAdditionRequest._id.toString(),
        name: data.name,
      },
    ).catch((err) =>
      console.log(
        `[doctorController] failed to notify staff of insurance addition request by ${req.doctor?._id}:`,
        err,
      ),
    );
    res.status(200).json({ message: "submitInsuranceAddition" });
  },
);

export const getMyPharmacies: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorPharmacy.find({ doctor: req.doctor._id }).populate(
      {
        path: "pharmacy",
      },
    );
    res.status(200).json({ message: "getMyPharmacies", data });
  },
);

export const addPharmacy: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await Pharmacy.findOne({ active: true, _id: nodeId });
    if (!node) return next(new NotFoundError());
    const exists = await DoctorPharmacy.exists({
      doctor: req.doctor._id,
      pharmacy: node._id,
    });
    if (exists)
      return next(new AppError("این داروخانه در لیست شما وجود داشت", 400));
    await DoctorPharmacy.create({ doctor: req.doctor._id, pharmacy: node._id });
    res.status(200).json({ message: "addPharmacy" });
  },
);

export const leavePharmacy: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const exists = await DoctorPharmacy.exists({
      _id: nodeId,
      doctor: req.doctor._id,
    });
    if (!exists) return next(new NotFoundError());
    await DoctorPharmacy.findByIdAndDelete(nodeId);
    res.status(200).json({ message: "leavePharmacy" });
  },
);

const pharmacyAdditionRequestSchema = z.strictObject({
  name: z.string(),
  address: z.string(),
  province: z.enum(provinceSlugs),
  city: z.enum(citySlugs),
  description: z.string().optional(),
});
export const submitPharmacyAdditionRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } =
      await pharmacyAdditionRequestSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    if (!validateProvinceAndCity(data.province, data.city))
      return next(new BadInputError());
    const pharmacyAdditionRequest = await PharmacyAdditionRequest.create({
      ...data,
      submittedBy: req.doctor._id,
    });
    notifyUserAlertSubscribers(
      "newPharmacyAdditionRequest",
      {
        title: "درخواست افزودن داروخانه",
        message: `پزشکی درخواست افزودن داروخانه «${data.name}» را ثبت کرد.`,
      },
      {
        requestId: pharmacyAdditionRequest._id.toString(),
        name: data.name,
      },
    ).catch((err) =>
      console.log(
        `[doctorController] failed to notify staff of pharmacy addition request by ${req.doctor?._id}:`,
        err,
      ),
    );
    res.status(200).json({ message: "submitPharmacyAdditionRequest" });
  },
);

export const getMyPharmacyAdditionRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await PharmacyAdditionRequest.find({
      submittedBy: req.doctor._id,
    });
    res.status(200).json({ message: "getMyPharmacyAdditionRequests", data });
  },
);

export const getMyPatients: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorPatient.find({ doctor: req.doctor._id }).populate({
      path: "user",
      select: { username: 1, phone: 1 },
      populate: { path: "identity" },
    });
    res.status(200).json({ message: "getMyPatients", data });
  },
);

export const getMyPatient: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await DoctorPatient.findOne({
      doctor: req.doctor._id,
      _id: nodeId,
    }).populate({
      path: "user",
      select: { username: 1, phone: 1, avatar: 1 },
      populate: [{ path: "identity" }, { path: "vital" }, { path: "medical" }],
    });
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyPatient", data });
  },
);

export const getMyPatientVitals: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const patient = await DoctorPatient.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
    });
    if (!patient) return next(new NotFoundError());
    const data = await UserVital.find({ user: patient.user._id }).populate({
      path: "author",
      select: { firstName: 1, lastName: 1 },
    });
    res.status(200).json({ message: "getMyPatientVitals", data });
  },
);

const addNewVitalSchema = z.strictObject({
  heartRate: numerish(40, 200),
  bloodOxygen: numerish(60, 100),
  bodyTemp: numerish(20, 50),
  bloodPressure: numerish(30, 300),
});

export const addNewVital: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await addNewVitalSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const patient = await DoctorPatient.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
    });
    if (!patient) return next(new NotFoundError());
    await UserVital.create({
      user: patient.user._id,
      author: req.doctor._id,
      ...data,
    });
    res.status(200).json({ message: "AddNewVital" });
  },
);

export const getMyPatientFiles: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new BadInputError());
    const { nodeId } = req.params;
    const profile = await DoctorPatient.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
    });
    if (!profile) return next(new NotFoundError());
    const data = await PatientProfile.find({ user: profile.user._id }).populate(
      { path: "doctor", select: { firstName: 1, lastName: 1 } },
    );
    res.status(200).json({ message: "getMyPatientFile", data });
  },
);

const newPatientFileSchema = z.strictObject({
  title: z.string(),
  description: z.string().optional(),
  diagnosis: z.string().optional(),
});

export const newPatientFile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await newPatientFileSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const patient = await DoctorPatient.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
    });
    if (!patient) return next(new NotFoundError());
    await PatientProfile.create({
      ...data,
      user: patient.user._id,
      doctor: req.doctor._id,
    });
    res.status(200).json({ message: "newPatientFile" });
  },
);

const editPatientFileSchema = z.strictObject({
  title: z.string().optional(),
  description: z.string().optional(),
  diagnosis: z.string().optional(),
});

export const editPatientFile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { success, data } = await editPatientFileSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const file = await PatientProfile.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
    });
    if (!file) return next(new NotFoundError());
    await PatientProfile.findByIdAndUpdate(file._id, data);
    res.status(200).json({ message: "editPatientFile" });
  },
);

export const getPatientFileRecords: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const file = await PatientProfile.findOne({ _id: nodeId });
    if (!file) return next(new NotFoundError());
    const isDoctorPatient = await DoctorPatient.exists({
      doctor: req.doctor._id,
      user: file.user._id,
    });
    if (!isDoctorPatient) return next(new NotFoundError());
    const data = await PatientProfile.findOne({ _id: file._id }).populate([
      { path: "user", populate: { path: "identity" } },
      { path: "doctor", select: { firstName: 1, lastName: 1 } },
      {
        path: "records",
        ...(file.doctor._id.toString() === req.doctor._id.toString()
          ? {}
          : { match: { isPublic: true } }),
        populate: [
          { path: "author", select: { firstName: 1, lastName: 1 } },
          { path: "files" },
        ],
      },
    ]);
    res.status(200).json({ message: "getPatientFileRecords", data });
  },
);

const newPatientFileRecordSchema = z.strictObject({
  title: z.string(),
  description: z.string().optional(),
  isPublic: boolish.optional(),
  //TODO: add Symptoms
});

export const newPatientFileRecord: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await newPatientFileRecordSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const profile = await PatientProfile.findOne({ _id: nodeId });
    if (!profile) return next(new NotFoundError());
    const isOwnPatient = await DoctorPatient.exists({
      doctor: req.doctor._id,
      user: profile.user._id,
    });
    if (!isOwnPatient) return next(new NotFoundError());
    const result = await PatientProfileRecord.create({
      profile: profile._id,
      author: req.doctor._id,
      ...data,
    });
    if (Array.isArray(req.files) && req.files?.length) {
      console.log(req.files);
      for (let i = 0; i < req.files.length; ++i) {
        const filename = `PatientProfileRecord__${
          result._id
        }__${new Date().getTime()}.${req.files[i].originalname
          .split(".")
          .findLast(() => true)}`;
        await fs.writeFile(
          path.join(process.cwd(), "NotPublic", filename),
          req.files[i].buffer,
        );
        await UserFile.create({
          chat: result._id,
          chatPath: "PatientProfileRecord",
          file: filename,
        });
      }
    }
    res.status(200).json({ message: "newPatientFileRecord" });
  },
);

const editPatientFileRecordSchema = z.strictObject({
  title: z.string().optional(),
  description: z.string().optional(),
  isPublic: boolish.optional(),
  //TODO: add Symptoms
});

export const editPatientFileRecord: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { success, data } = await editPatientFileRecordSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const record = await PatientProfileRecord.findById(nodeId);
    if (!record) return next(new NotFoundError());
    if (record.author._id.toString() !== req.doctor._id.toString())
      return next(new AppError("شما مجاز به اصلاح این رکورد نیستید", 400));
    //TODO: add files
    await PatientProfileRecord.findByIdAndUpdate(record._id, data);
    res.status(200).json({ message: "editPatientFileRecord" });
  },
);

export const getGallery: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await GalleryItem.find({ owner: req.doctor._id });
    res.status(200).json({ message: "getGallery", data });
  },
);

const editGalleryItemSchema = z.strictObject({
  alt: z.string().optional(),
  description: z.string().optional(),
  order: numerish(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).optional(),
  active: boolish.optional(),
});
export const editGalleryItem: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await editGalleryItemSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const node = await GalleryItem.findOne({
      owner: req.doctor._id,
      _id: nodeId,
    });
    if (!node) return next(new BadInputError());
    let image: string | undefined;
    if (req.file) {
      image = `Gallery__${req.doctor._id.toString()}__${new Date().getTime()}.${req.file.originalname
        .split(".")
        .findLast(() => true)}`;
      await fs.writeFile(
        path.join(process.cwd(), "Public", image),
        req.file.buffer,
      );
    }
    await GalleryItem.findByIdAndUpdate(node._id, { ...data, image });
    res.status(200).json({ message: "editGalleryItem" });
  },
);

const addGalleryItemSchema = z.strictObject({
  alt: z.string(),
  description: z.string().optional(),
  order: numerish(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).optional(),
  active: boolish.optional(),
});
export const addGalleryItem: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = await addGalleryItemSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    if (!req.file) return next(new BadInputError());
    const image = `Gallery__${req.doctor._id.toString()}__${new Date().getTime()}.${req.file.originalname
      .split(".")
      .findLast(() => true)}`;
    await fs.writeFile(
      path.join(process.cwd(), "Public", image),
      req.file.buffer,
    );
    await GalleryItem.create({
      owner: req.doctor._id,
      ownerPath: "DoctorProfile",
      image,
      ...data,
    });
    res.status(200).json({ message: "addGalleryItem" });
  },
);

export const removeGalleryItem: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await GalleryItem.findOne({
      owner: req.doctor._id,
      _id: nodeId,
    });
    if (!node) return next(new NotFoundError());
    await GalleryItem.findByIdAndDelete(node._id);
    res.status(200).json({ message: "removeGalleryItem" });
  },
);

export const getMyOffices: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await Office.find({ doctor: req.doctor._id });
    res.status(200).json({ message: "getMyOffices", data });
  },
);

export const getMyOffice: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Office.findOne({ _id: nodeId, doctor: req.doctor._id });
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyOffice", data });
  },
);

const mutateOfficeSchema = z.strictObject({
  name: z.string().optional(),
  address: z.string().optional(),
  tel: z.string().optional(),
  order: numerish(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).optional(),
  active: boolish.optional(),
  location: isPoint.optional(),
});
export const createOffice: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = await mutateOfficeSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const { location, ...rest } = data;
    await Office.create({
      ...rest,
      doctor: req.doctor._id,
      location: location ? { type: "Point", coordinates: location } : undefined,
    });
    res.status(200).json({ message: "createOffice" });
  },
);

export const editMyOffice: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await mutateOfficeSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const node = await Office.findOne({ doctor: req.doctor._id, _id: nodeId });
    if (!node) return next(new NotFoundError());
    const { location, ...rest } = data;
    await Office.findByIdAndUpdate(node._id, {
      ...rest,
      location: location ? { type: "Point", coordinates: location } : undefined,
    });
    res.status(200).json({ message: "editMyOffice" });
  },
);

export const removeMyOffice: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await Office.findOne({ _id: nodeId, doctor: req.doctor._id });
    if (!node) return next(new NotFoundError());
    await Office.findOneAndDelete(node._id);
    res.status(200).json({ message: "removeMyOffice" });
  },
);

export const getMyServices: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await Service.find({ owner: req.doctor._id }).populate(
      "category",
    );
    res.status(200).json({ message: "getMyServices", data });
  },
);

// Incoming orders (2026-08) - orders placed by patients that include at
// least one of this doctor's services/servicePackages. Mirrors
// pharmacyController.getMyIncomingOrders - see its comment for why each
// order is filtered down to just this doctor's own line items rather than
// exposing the whole order.

// Ids of the Service/ServicePackage docs this doctor owns - used to both
// query for orders containing them and to filter/scope a matched order's
// item arrays down to this doctor's own items.
const getMyIncomingOrderOwnedIds = async (doctorId: Types.ObjectId) => {
  const [serviceIds, packageIds] = await Promise.all([
    Service.find({ owner: doctorId }).distinct("_id"),
    ServicePackage.find({ owner: doctorId }).distinct("_id"),
  ]);
  return {
    serviceIds,
    packageIds,
    serviceIdStrings: serviceIds.map((id) => id.toString()),
    packageIdStrings: packageIds.map((id) => id.toString()),
  };
};

// Filters an order's services/servicePackages down to just this doctor's
// own line items and computes a subtotal over them.
const scopeOrderToDoctor = (
  order: InstanceType<typeof Order>,
  serviceIdStrings: string[],
  packageIdStrings: string[],
) => {
  const services = order.services.filter((s) =>
    serviceIdStrings.includes((s.item as any)?._id?.toString()),
  );
  const servicePackages = order.servicePackages.filter((s) =>
    packageIdStrings.includes((s.item as any)?._id?.toString()),
  );
  const subtotal = [...services, ...servicePackages].reduce(
    (sum, i) => sum + i.price * i.qty,
    0,
  );
  return {
    _id: order._id,
    user: order.user,
    submittedAt: order.submittedAt,
    status: order.status,
    services,
    servicePackages,
    subtotal,
  };
};

const incomingOrderPopulate = [
  { path: "user", select: "username phone avatar" },
  { path: "services", populate: { path: "item" } },
  { path: "servicePackages", populate: { path: "item" } },
];

export const getMyIncomingOrders: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { serviceIds, packageIds, serviceIdStrings, packageIdStrings } =
      await getMyIncomingOrderOwnedIds(req.doctor._id);
    // only paid orders - a "pending" SEP order isn't paid yet (2026-09)
    const orders = await Order.find({
      status: "paid",
      $or: [
        { "services.item": { $in: serviceIds } },
        { "servicePackages.item": { $in: packageIds } },
      ],
    })
      .sort({ submittedAt: -1 })
      .populate(incomingOrderPopulate);
    const data = orders.map((order) =>
      scopeOrderToDoctor(order, serviceIdStrings, packageIdStrings),
    );
    res.status(200).json({ message: "getMyIncomingOrders", data });
  },
);

export const getMyIncomingOrder: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());

    const { serviceIds, packageIds, serviceIdStrings, packageIdStrings } =
      await getMyIncomingOrderOwnedIds(req.doctor._id);
    const order = await Order.findOne({
      _id: nodeId,
      status: "paid",
      $or: [
        { "services.item": { $in: serviceIds } },
        { "servicePackages.item": { $in: packageIds } },
      ],
    }).populate(incomingOrderPopulate);
    if (!order) return next(new NotFoundError());

    const data = scopeOrderToDoctor(order, serviceIdStrings, packageIdStrings);
    res.status(200).json({ message: "getMyIncomingOrder", data });
  },
);

// Fulfill/cancel one of this doctor's own line items within an order
// (2026-08). Scoped the same way getMyIncomingOrder(s) are: the target item
// must belong to a Service/ServicePackage owned by this doctor, so a doctor
// can never touch another seller's item in a shared order.
const mutateIncomingOrderItemSchema = z.strictObject({
  model: z.enum(["services", "servicePackages"]),
  itemId: z.string(),
  status: z.enum(["fulfilled", "cancelled"]),
});

export const mutateIncomingOrderItem: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } =
      await mutateIncomingOrderItemSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(data.itemId)) return next(new BadInputError());

    const { serviceIdStrings, packageIdStrings } =
      await getMyIncomingOrderOwnedIds(req.doctor._id);
    const ownedIdStrings =
      data.model === "services" ? serviceIdStrings : packageIdStrings;
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

export const getMyService: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Service.findOne({
      _id: nodeId,
      owner: req.doctor._id,
    }).populate("category");
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyService", data });
  },
);

const mutateServiceSchema = z.strictObject({
  name: z.string().optional(),
  order: numerish(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).optional(),
  isActive: boolish.optional(),
  price: numerish(0, Number.MAX_SAFE_INTEGER).optional(),
  discount: numerish(0, Number.MAX_SAFE_INTEGER).optional(),
  inventory: numerish(0, Number.MAX_SAFE_INTEGER).optional(),
  isHome: boolish.optional(),
  category: objectIdField.optional(),
  special: boolish.optional(),
  description: z.string().optional(),
  whyChoose: z.string().optional(),
  stages: z.string().optional(),
  results: z.string().optional(),
  sameAs: z.array(objectIdField).optional(),
});

export const createService: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = await mutateServiceSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    let image: string | undefined;
    if (req.file) {
      image = `Service__${req.doctor._id.toString()}__${new Date().getTime()}.${req.file.originalname
        .split(".")
        .findLast(() => true)}`;
      await fs.writeFile(
        path.join(process.cwd(), "Public", image),
        req.file.buffer,
      );
    }
    await Service.create({ ...data, owner: req.doctor._id, image });
    res.status(200).json({ message: "createService" });
  },
);

export const editMyService: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await mutateServiceSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const node = await Service.findOne({
      _id: nodeId,
      owner: req.doctor._id,
    });
    if (!node) return next(new NotFoundError());
    let image: string | undefined;
    if (req.file) {
      image = `Service__${req.doctor._id.toString()}__${new Date().getTime()}.${req.file.originalname
        .split(".")
        .findLast(() => true)}`;
      await fs.writeFile(
        path.join(process.cwd(), "Public", image),
        req.file.buffer,
      );
    }
    await Service.findByIdAndUpdate(node._id, { ...data, image });
    res.status(200).json({ message: "editMyService" });
  },
);

export const removeMyService: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await Service.findOne({
      _id: nodeId,
      owner: req.doctor._id,
    });
    if (!node) return next(new NotFoundError());
    await Service.findByIdAndDelete(node._id);
    res.status(200).json({ message: "removeMyService" });
  },
);

export const getMyServicePackages: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await ServicePackage.find({ owner: req.doctor._id })
      .populate("category")
      .populate("services");
    res.status(200).json({ message: "getMyServicePackages", data });
  },
);

export const getMyServicePackage: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await ServicePackage.findOne({
      _id: nodeId,
      owner: req.doctor._id,
    })
      .populate("category")
      .populate("services");
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyServicePackage", data });
  },
);

const mutateServicePackageSchema = z.strictObject({
  name: z.string().optional(),
  services: z.array(objectIdField).optional(),
  price: numerish(0, Number.MAX_SAFE_INTEGER).optional(),
  discount: numerish(0, Number.MAX_SAFE_INTEGER).optional(),
  category: objectIdField.optional(),
  isActive: boolish.optional(),
  order: numerish(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).optional(),
  sameAs: z.array(objectIdField).optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  whyChoose: z.string().optional(),
  stages: z.string().optional(),
  results: z.string().optional(),
});

const assertOwnedServicePackageRefs = async (
  req: Request,
  data: z.infer<typeof mutateServicePackageSchema>,
): Promise<boolean> => {
  if (!req.doctor) return false;
  if (data.services && data.services.length) {
    const count = await Service.countDocuments({
      _id: { $in: data.services },
      owner: req.doctor._id,
    });
    if (count !== data.services.length) return false;
  }
  if (data.sameAs && data.sameAs.length) {
    const count = await ServicePackage.countDocuments({
      _id: { $in: data.sameAs },
      owner: req.doctor._id,
    });
    if (count !== data.sameAs.length) return false;
  }
  return true;
};

export const createServicePackage: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = await mutateServicePackageSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    if (!(await assertOwnedServicePackageRefs(req, data)))
      return next(new BadInputError());
    let image: string | undefined;
    if (req.file) {
      image = `ServicePackage__${req.doctor._id.toString()}__${new Date().getTime()}.${req.file.originalname
        .split(".")
        .findLast(() => true)}`;
      await fs.writeFile(
        path.join(process.cwd(), "Public", image),
        req.file.buffer,
      );
    }
    await ServicePackage.create({ ...data, owner: req.doctor._id, image });
    res.status(200).json({ message: "createServicePackage" });
  },
);

export const editMyServicePackage: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await mutateServicePackageSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    if (!(await assertOwnedServicePackageRefs(req, data)))
      return next(new BadInputError());
    const node = await ServicePackage.findOne({
      _id: nodeId,
      owner: req.doctor._id,
    });
    if (!node) return next(new NotFoundError());
    let image: string | undefined;
    if (req.file) {
      image = `ServicePackage__${req.doctor._id.toString()}__${new Date().getTime()}.${req.file.originalname
        .split(".")
        .findLast(() => true)}`;
      await fs.writeFile(
        path.join(process.cwd(), "Public", image),
        req.file.buffer,
      );
    }
    await ServicePackage.findByIdAndUpdate(node._id, { ...data, image });
    res.status(200).json({ message: "editMyServicePackage" });
  },
);

export const removeMyServicePackage: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await ServicePackage.findOne({
      _id: nodeId,
      owner: req.doctor._id,
    });
    if (!node) return next(new NotFoundError());
    await ServicePackage.findByIdAndDelete(node._id);
    res.status(200).json({ message: "removeMyServicePackage" });
  },
);

export const getMySocialMedias: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorSocialMedia.find({ doctor: req.doctor._id });
    res.status(200).json({ message: "getMySocialMedias", data });
  },
);

const createSocialMediaSchema = z.strictObject({
  target: z.string(),
  media: z.enum(socialMedias),
});

export const createSocialMedia: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = await createSocialMediaSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    await DoctorSocialMedia.create({ doctor: req.doctor._id, ...data });
    res.status(200).json({ message: "createSocialMedia" });
  },
);

const editSocialMediaSchema = z.strictObject({
  target: z.string().optional(),
  media: z.enum(socialMedias).optional(),
});

export const editMySocialMedia: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await editSocialMediaSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const node = await DoctorSocialMedia.findOne({
      doctor: req.doctor._id,
      _id: nodeId,
    });
    if (!node) return next(new NotFoundError());
    await DoctorSocialMedia.findByIdAndUpdate(node._id, data);
    res.status(200).json({ message: "editMySocialMedia" });
  },
);

export const removeMySocialMedia: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await DoctorSocialMedia.findOne({
      doctor: req.doctor._id,
      _id: nodeId,
    });
    if (!node) return next(new NotFoundError());
    await DoctorSocialMedia.findByIdAndDelete(node._id);
    res.status(200).json({ message: "removeMySocialMedia" });
  },
);

export const getMyFaqs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorFaq.find({ doctor: req.doctor._id });
    res.status(200).json({ message: "getMyFaqs", data });
  },
);

const createFaqSchema = z.strictObject({
  question: z.string(),
  answer: z.string(),
  active: boolish.optional(),
  order: numerish(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).optional(),
});

export const createFaq: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = await createFaqSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    await DoctorFaq.create({ doctor: req.doctor._id, ...data });
    res.status(200).json({ message: "createFaq" });
  },
);

const updateFaqSchema = z.strictObject({
  question: z.string().optional(),
  answer: z.string().optional(),
  active: boolish.optional(),
  order: numerish(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).optional(),
});

export const updateFaq: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await updateFaqSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const node = await DoctorFaq.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
    });
    if (!node) return next(new NotFoundError());
    await DoctorFaq.findByIdAndUpdate(node._id, data);
    res.status(200).json({ message: "updateFaq" });
  },
);

export const deleteFaq: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await DoctorFaq.findOne({
      doctor: req.doctor._id,
      _id: nodeId,
    });
    if (!node) return next(new NotFoundError());
    await DoctorFaq.findByIdAndDelete(node._id);
    res.status(200).json({ message: "deleteFaq" });
  },
);

export const checkTaminToken: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const cred = await DoctorTaminCred.findOneAndUpdate(
      {
        doctor: req.doctor._id,
      },
      { doctor: req.doctor._id },
      { upsert: true, new: true },
    );
    const verifier = createCodeVerifier();
    const challenge = await toCodeChallenge(verifier);
    await DoctorTaminCred.findByIdAndUpdate(cred._id, { verifier, challenge });
    res.status(200).json({ message: "checkTaminTokenb", data: { challenge } });
  },
);

const taminCbSchema = z.strictObject({ code: z.string() });

export const taminCb: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = await taminCbSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const cred = await DoctorTaminCred.findOneAndUpdate(
      { doctor: req.doctor._id },
      { doctor: req.doctor._id },
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
    await DoctorTaminCred.findByIdAndUpdate(cred._id, {
      token: resData.access_token,
      tokenRefreshedAt: new Date(),
    });
    res.status(200).json({ message: "taminCb" });
  },
);

export const getTokenDate: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const cred = await DoctorTaminCred.findOneAndUpdate(
      { doctor: req.doctor._id },
      { doctor: req.doctor._id },
      { upsert: true, new: true },
    );
    res
      .status(200)
      .json({ message: "getTokenDate", data: cred.tokenRefreshedAt });
  },
);

const inquiryPatientSchema = z.strictObject({
  nationalId: z.string().length(10),
});
export const inquiryPatient: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await inquiryPatientSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    const { nationalId } = data;
    if (!isSSID(nationalId)) return next(new BadInputError());
    const identity = await UserIdentity.findOne({ nationalId });
    let phone: string | undefined;
    if (identity?.user) {
      phone =
        (await User.findById(identity.user).select("phone"))?.phone ||
        undefined;
    }
    res.status(200).json({
      message: "inquiryPatient",
      data: { identity: identity ? { ...identity.toObject(), phone } : null },
    });
  },
);

const inquiryPatientPrivilegeSchema = z.strictObject({
  nationalCode: z.string(),
});

export const inquiryPatientPrivilege: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } =
      await inquiryPatientPrivilegeSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    if (!isSSID(data.nationalCode)) return next(new BadInputError());
    const cred = await DoctorTaminCred.findOneAndUpdate(
      { doctor: req.doctor._id },
      { doctor: req.doctor._id },
      { upsert: true, new: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ep-test.tamin.ir/api/v2/patients/deserve-info/${1234567891}/${2000200092}/${2000200092}/${data.nationalCode}`,
      method: "GET",
      token: cred.token,
    });
    if (!response.headers.get("Content-Type")?.includes("json")) {
      console.log(await response.text());
      return next(new TaminRideError());
    }
    const taminData = await response.json();
    if (typeof taminData?.data?.hasDeserve !== "boolean")
      return next(new TaminRideError());
    res.status(200).json({
      message: "inquiryPatientPrivilege",
      data: taminData.data.hasDeserve,
    });
  },
);

export const getPatientFiles: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const identity = await UserIdentity.findById(nodeId);
    if (!identity) return next(new NotFoundError());
    //TODO
    if (!identity.user) return next(new AppError("بعدا تلاش کنید", 400));
    const user = await User.findById(identity.user);
    if (!user) return next(new AppError("بعدا تلاش کنید", 400));
    const profiles = await PatientProfile.find({ user: user._id }).populate({
      path: "doctor",
      select: { firstName: 1, lastName: 1 },
    });
    res.status(200).json({ message: "getPatientFiles", data: { profiles } });
  },
);

export const getPatientProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await PatientProfile.findOne({ _id: nodeId }).populate([
      { path: "doctor", populate: { path: "mainSpeciality" } },
      {
        path: "records",
        populate: [
          { path: "author", populate: { path: "mainSpeciality" } },
          { path: "symptoms" },
          { path: "files" },
        ],
      },
    ]);
    if (!node) return next(new NotFoundError());
    res
      .status(200)
      .json({ message: "getPatientProfile", data: { profile: node } });
  },
);

export const getMyFavoriteDrugs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await FavoriteDrug.find({ doctor: req.doctor._id }).populate([
      { path: "drug" },
      { path: "instruction" },
      { path: "amount" },
      { path: "usage" },
    ]);
    res.status(200).json({ message: "getMyFavoriteDrugs", data });
  },
);

const favoritePrescriptionItemSchema = z.strictObject({
  item: z.string().length(24),
  qty: z.preprocess(
    (val: unknown) =>
      typeof val === "string" && !isNaN(Number(val)) ? Number(val) : val,
    z.number().min(1).int(),
  ),
  instruction: z.string().length(24),
  amount: z.string().length(24),
  usage: z.string().length(24),
  description: z.string().max(500).optional(),
});
export const favoritePrescriptionItem: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { success, data } =
      await favoritePrescriptionItemSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const {
      amount: _amount,
      instruction: _instruction,
      item: _item,
      usage: _usage,
      description,
      qty,
    } = data;
    if (
      !isValidObjectId(_amount) ||
      !isValidObjectId(_instruction) ||
      !isValidObjectId(_item) ||
      !isValidObjectId(_usage)
    )
      return next(new BadInputError());
    const amount = await TaminDrugAmount.findById(_amount);
    const instruction = await TaminDrugInstruction.findById(_instruction);
    const item = await TaminService.findById(_item);
    const usage = await TaminDrugUsage.findById(_usage);
    if (!amount || !instruction || !item || !usage)
      return next(new BadInputError());
    await FavoriteDrug.create({
      doctor: req.doctor._id,
      drug: item._id,
      amount: amount._id,
      instruction: instruction._id,
      qty,
      usage: usage._id,
      description,
    });
    res.status(200).json({ message: "favoritePrescriptionItem" });
  },
);

export const getFavoriteLabItems: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    res.status(200).json({ message: "getFavoriteLabItems" });
  },
);

const favoriteLabItemSchema = z.strictObject({
  item: z.string().length(24),
  description: z.string().optional(),
});
export const favoriteLabItem: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = await favoriteLabItemSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());

    res.status(200).json({ message: "favoriteLabItem" });
  },
);

const DRUG_SEARCH_LIMIT = 5;
const searchDrugsSchema = z.strictObject({
  query: z.string().min(1).max(500).trim(),
  srvType: z.string(),
});
export const searchDrugs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success, error } = await searchDrugsSchema.safeParseAsync(
      req.body,
    );
    console.log(error);
    if (!success) return next(new BadInputError());
    //TODO: I know this is too expensive
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const segments = data.query.trim().split(/\s+/).map(escapeRegex);
    const reg = {
      $regex: segments.map((seg) => `(?=.*${seg})`).join(""),
      $options: "i",
    };
    const nodes = await TaminService.find({
      $or: [{ srvName: reg }, { gSrvCode: reg }, { srvCode: reg }],
      srvType: data.srvType,
    }).limit(DRUG_SEARCH_LIMIT);
    res.status(200).json({ message: "searchDrugs", data: nodes });
  },
);

export const getPrescriptionInstructions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await TaminDrugInstruction.find();
    res.status(200).json({ message: "getPrescriptionInstructions", data });
  },
);

export const getPrescriptionUsages: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await TaminDrugUsage.find();
    res.status(200).json({ message: "getPrecriptionUsages", data });
  },
);

export const getPrescriptionAmounts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await TaminDrugAmount.find();
    res.status(200).json({ message: "getPrescriptionAmounts", data });
  },
);

const draftPrescriptionSchema = z.strictObject({
  patient: z.string().length(24),
  items: z
    .array(
      z.strictObject({
        item: z.string().length(24),
        qty: z.preprocess(
          (val: unknown) =>
            typeof val === "string" && !isNaN(Number(val)) ? Number(val) : val,
          z.number().int().min(1),
        ),
        usage: z.string().length(24),
        instruction: z.string().length(24),
        amount: z.string().length(24),
        description: z.string().max(500).optional(),
      }),
    )
    .optional(),
  labItems: z
    .array(
      z.strictObject({
        item: z.string().length(24),
        qty: z.preprocess(
          (val: unknown) =>
            typeof val === "string" && !isNaN(Number(val)) ? Number(val) : val,
          z.number().int().min(1),
        ),
        dateDo: datish.optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

type FlattendPrescriptionData = Record<
  keyof IPrescription["items"][number],
  string
>[];

type LabItem = {
  item: string;
  dateDo?: Date;
  qty: number;
  description?: string;
};

const validateIncomingItems: (args: {
  incoming: {
    item: string;
    qty: number;
    usage: string;
    instruction: string;
    amount: string;
    description?: string | undefined;
  }[];
  incomingLabItems: {
    item: string;
    qty: number;
    dateDo?: Date;
    description?: string;
  }[];
}) => Promise<
  | {
      success: true;
      data: FlattendPrescriptionData;
      unflattend: IPrescription["items"];
      labItems: LabItem[];
      unflattendLabItems: IPrescription["labItems"];
      error?: never;
    }
  | {
      success: false;
      error?: string;
      data?: never;
      unflattend?: never;
      labItems?: never;
      unflattendLabItems?: never;
    }
> = async ({ incoming: _items, incomingLabItems }) => {
  console.log("9");
  if (!_items.length && !incomingLabItems.length) return { success: false };
  console.log("8");
  const items: FlattendPrescriptionData = [];
  const unflattend: IPrescription["items"] = [];
  for (const element of _items) {
    const {
      item: _item,
      amount: _amount,
      instruction: _instruction,
      usage: _usage,
      qty,
      description,
    } = element;
    if (
      !isValidObjectId(_item) ||
      !isValidObjectId(_amount) ||
      !isValidObjectId(_instruction) ||
      !isValidObjectId(_usage)
    ) {
      console.log("7");
      return { success: false };
    }
    const item = await TaminService.findOne({ _id: _item, srvType: "01" });
    const amount = await TaminDrugAmount.findById(_amount);
    const instruction = await TaminDrugInstruction.findById(_instruction);
    const usage = await TaminDrugUsage.findById(_usage);
    if (!item || !amount || !instruction || !usage) {
      console.log("6");
      return { success: false };
    }
    items.push({
      item: item._id.toString(),
      amount: amount._id.toString(),
      instruction: instruction._id.toString(),
      usage: usage._id.toString(),
      qty: qty.toString(),
      description: description || "",
    });
    unflattend.push({ item, amount, instruction, usage, qty, description });
  }
  const labItems: LabItem[] = [];
  const unflattendLabItems: IPrescription["labItems"] = [];
  for (const element of incomingLabItems) {
    const item = await TaminService.findOne({
      _id: element.item,
      srvType: "02",
    });
    if (!item) {
      console.log("5");
      return { success: false };
    }
    if (element.dateDo) {
      if (element.dateDo < new Date()) {
        console.log("4");
        return { success: false, error: "تاریخ اجرا نامعتبر است" };
      }
    }
    unflattendLabItems.push({
      item,
      qty: element.qty,
      description: element.description,
      dateDo: element.dateDo,
    });
    labItems.push({
      item: item._id.toString(),
      qty: element.qty,
      description: element.description,
      dateDo: element.dateDo,
    });
  }
  return {
    success: true,
    data: items,
    unflattend,
    labItems,
    unflattendLabItems,
  };
};

const generateNoteDetailEprscs = (items: IPrescription["items"]) =>
  items.map((item) => ({
    srvId: {
      srvType: { srvType: item.item.srvType },
      srvCode: item.item.wsSrvCode,
    },
    srvQty: item.qty,
    timesAday: { drugAmntId: Number(item.amount.drugAmntId) },
    drugInstruction: { drugInstId: Number(item.instruction.drugInstId) },
    dose: item.usage.drugUsageConcept || "",
  }));

const generateNoteDetailEprscsLab = (items: IPrescription["labItems"]) =>
  items.map((item) => ({
    srvId: {
      srvType: { srvType: item.item.srvType },
      srvCode: item.item.wsSrvCode,
      parTarefGrp: { parGrpCode: item.item.parTarefGrp },
    },
    srvQty: item.qty,
    dateDo: item.dateDo
      ? moment(new Date(item.dateDo)).format("jYYYYjMMjDD")
      : undefined,
    // dose: item.description || "",
  }));

const _draftPrescription = async (
  req: Request,
  next: NextFunction,
): Promise<void | IPrescription> => {
  if (!req.doctor) return next(new MiddlewareError());
  const { success, data } = await draftPrescriptionSchema.safeParseAsync(
    req.body,
  );
  if (!success) return next(new BadInputError());
  const { items: _items, patient: _patient, labItems: _labItems } = data;
  if (!isValidObjectId(_patient)) return next(new BadInputError());
  const patient = await UserIdentity.findById(_patient);
  if (!patient) return next(new NotFoundError());
  const {
    success: itemsSuccess,
    data: items,
    labItems,
  } = await validateIncomingItems({
    incoming: _items || [],
    incomingLabItems: _labItems || [],
  });
  if (!itemsSuccess) return next(new BadInputError());
  return await Prescription.create({
    author: req.doctor._id,
    items,
    labItems,
    patient: patient._id,
  });
};

const _editDraftPrescription: (args: { req: Request }) => Promise<
  | {
      success: true;
      error?: never;
    }
  | { success: false; error: AppError }
> = async ({ req }) => {
  if (!req.doctor) return { success: false, error: new MiddlewareError() };
  const { nodeId } = req.params;
  if (!isValidObjectId(nodeId))
    return { success: false, error: new BadInputError() };
  const { success, data } = await draftPrescriptionSchema
    .partial()
    .safeParseAsync(req.body);
  if (!success) return { success: false, error: new BadInputError() };
  let patient: IUserIdentity | undefined;
  if (data.patient) {
    if (!isValidObjectId(data.patient))
      return { success: false, error: new BadInputError() };
    const identity = await UserIdentity.findById(data.patient);
    if (!identity) return { success: false, error: new NotFoundError() };
    patient = identity;
  }
  const {
    success: itemsSuccess,
    data: items,
    labItems,
  } = await validateIncomingItems({
    incoming: data.items || [],
    incomingLabItems: data.labItems || [],
  });
  if (!itemsSuccess) return { success: false, error: new BadInputError() };
  const prescription = await Prescription.findOne({
    _id: nodeId,
    author: req.doctor._id,
  }).populate({ path: "taminStatus" });
  if (!prescription) return { success: false, error: new NotFoundError() };
  if (!!prescription.taminStatus)
    return {
      success: false,
      error: new AppError("این نسخه در سامانه ثبت شده", 400),
    };
  await Prescription.findByIdAndUpdate(prescription._id, {
    patient: patient?._id,
    items,
    labItems,
  });
  return { success: true };
};

export const editDraftPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { success, error } = await _editDraftPrescription({ req });
    if (!success) return next(error);
    res.status(200).json({ message: "editDraftPrescription" });
  },
);

export const editCommitDraftPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    const { success, error } = await _editDraftPrescription({ req });
    if (!success) return next(error);
    const { success: commitSuccess, error: commitError } =
      await _commitPrescription({ id: nodeId, doctor: req.doctor });
    if (!commitSuccess) return next(commitError);
    res.status(200).json({ message: "editCommitDraftPrescription" });
  },
);

export const editTaminPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const prescription = await Prescription.findOne({
      _id: nodeId,
      author: req.doctor._id,
    }).populate([{ path: "taminStatus" }]);
    if (!prescription?.taminStatus?.taminId)
      return next(new AppError("این نسخه هنوز در تامین ثبت نشده", 400));
    const { data, success, error } = await draftPrescriptionSchema
      .pick({ items: true, labItems: true })
      .safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const {
      unflattend,
      error: _error,
      success: itemsSuccess,
      data: flattend,
      labItems,
      unflattendLabItems,
    } = await validateIncomingItems({
      incoming: data.items || [],
      incomingLabItems: data.labItems || [],
    });
    console.log("1");
    if (!itemsSuccess)
      return next(_error ? new AppError(_error, 400) : new BadInputError());
    console.log("2");
    if (!prescription.items.length && !!flattend.length)
      return next(
        new AppError("برای اضافه کردن دسته بندی نسخه جدید بزنید", 400),
      );
    if (!prescription.labItems.length && !!labItems.length)
      return next(
        new AppError("برای اضافه کردن دسته بندی نسخه جدید بزنید", 400),
      );
    const itemsChanged = prescription.items.some((item) => {
      const element = data.items?.find(
        (el) => el.item === item.item._id.toString(),
      );
      if (!element) return true;
      if (Number(item.qty) !== Number(element.qty)) return true;
      if (item.instruction._id.toString() !== element.instruction) return true;
      if (item.usage._id.toString() !== element.usage) return true;
      if (item.amount._id.toString() !== element.amount) return true;
      return false;
    });
    const labChanged = prescription.labItems.some((item) => {
      console.log(labItems);
      const element = labItems.find(
        (el) => el.item === item.item._id.toString(),
      );
      console.log({ item, element });
      if (!element) return true;
      if (Number(item.qty) !== Number(element.qty)) return true;
      if (item.dateDo?.toString() !== element.dateDo?.toString()) return true;
      return false;
    });
    console.log({ itemsChanged, labChanged });
    if (!itemsChanged && !labChanged)
      return next(new AppError("تغییری مشاهده نشد", 400));
    const cred = await DoctorTaminCred.findOneAndUpdate(
      { doctor: req.doctor._id },
      { doctor: req.doctor._id },
      { new: true, upsert: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());
    if (prescription.taminStatus.taminId && itemsChanged) {
      const response = await makeTaminRequest({
        path: `https://ep-test.tamin.ir/api/v2/ep/update/${prescription.taminStatus.taminId}/1234567891/2000200092`,
        method: "POST",
        token: cred.token,
        payload: generateNoteDetailEprscs(unflattend),
      });
      if (!response.headers.get("content-type")?.includes("json")) {
        console.log(await response.text());
        return next(new BadTaminResponseError());
      }
      const responseData = await response.json();
      console.log(responseData);
      if (responseData.data.statusCode !== "200")
        return next(new BadTaminResponseError());
      await Prescription.findByIdAndUpdate(prescription._id, {
        items: flattend,
      });
    }
    if (prescription.taminStatus.labTaminId && labChanged) {
      const response = await makeTaminRequest({
        path: `https://ep-test.tamin.ir/api/v2/ep/update/${prescription.taminStatus.labTaminId}/1234567891/2000200092`,
        method: "POST",
        token: cred.token,
        payload: generateNoteDetailEprscsLab(unflattendLabItems),
      });
      if (!response.headers.get("content-type")?.includes("json")) {
        console.log(await response.text());
        return next(new BadTaminResponseError());
      }
      const responseData = await response.json();
      console.log(responseData);
      if (responseData.data.statusCode !== "200")
        return next(new BadTaminResponseError());
      await Prescription.findByIdAndUpdate(prescription._id, {
        labItems,
      });
    }
    res.status(200).json({ message: "editTaminPrescription" });
  },
);

const _commitPrescription: (args: {
  id: string;
  doctor: IDoctorProfile;
}) => Promise<
  { success: true; error?: never } | { success: false; error: AppError }
> = async ({ id, doctor }) => {
  if (!isValidObjectId(id))
    return { success: false, error: new BadInputError() };
  const prescription = await Prescription.findOne({
    _id: id,
    author: doctor._id,
  }).populate([
    { path: "patient" },
    { path: "items.item" },
    { path: "items.usage" },
    { path: "items.instruction" },
    { path: "items.amount" },
    { path: "labItems.item" },
  ]);
  if (!prescription) return { success: false, error: new NotFoundError() };
  const alreadyCommitted = await TaminPrescription.findOne({
    prescription: prescription._id,
  });
  const actionable =
    (!alreadyCommitted?.taminId && !!prescription.items.length) ||
    (!alreadyCommitted?.labTaminId && !!prescription.labItems.length);
  if (!actionable)
    return {
      success: false,
      error: new AppError("این نسخه قبلا در سامانه ثبت شده است", 400),
    };
  const cred = await DoctorTaminCred.findOneAndUpdate(
    { doctor: doctor._id },
    { doctor: doctor._id },
    { upsert: true, new: true },
  );
  //TODO: this is definitely not the way
  const submitASegmentForTamin = async (
    args:
      | { items: IPrescription["items"]; labItems?: never }
      | { labItems: IPrescription["labItems"]; items?: never },
  ) => {
    if (!cred.token)
      return { success: false, error: new MissingTaminTokenError() };
    const body = {
      patient: "0123456789",
      mobile: "09129999999",
      prescType: { prescTypeId: args.items ? 1 : 2 },
      prescDate: moment(new Date()).format("jYYYYjMMjDD"),
      docId: "2000200092",
      docMobileNo: "09991111111",
      docNationalCode: "1234567891",
      comments: "",
      expireDate: "14030102",
      clientId: "0123456789",
      // noteDetailEprscs: generateNoteDetailEprscs(prescription.items),
      noteDetailEprscs: args.items
        ? generateNoteDetailEprscs(args.items)
        : generateNoteDetailEprscsLab(args.labItems),
    };
    const response = await makeTaminRequest({
      path: "https://ep-test.tamin.ir/api/v2/SendEpresc",
      method: "POST",
      token: cred.token,
      payload: body,
    });
    if (!response.headers.get("content-type")?.includes("json"))
      return { success: false, error: new BadTaminResponseError() };
    const data = (await response.json()) as TaminResponse;
    //TODO: remove log
    console.log(data);
    if (data.data?.result?.error_Code) {
      if (
        data.data?.result?.error_Code === "304" &&
        !!data.data.result.error_Msg
      ) {
        const taminId = data.data.result.error_Msg.match(/شناسه\s*(\d+)/)?.[1];
        const tracking =
          data.data.result.error_Msg.match(/کد رهگیری\s*(\d+)/)?.[1];
        if (!taminId || !tracking)
          return { success: false, error: new BadTaminResponseError() };
        const dup = await TaminPrescription.exists({
          [args.labItems ? "labTaminId" : "taminId"]: taminId,
          [args.labItems ? "labTracking" : "tracking"]: tracking,
        });
        if (dup)
          return {
            success: false,
            error: new AppError(`نسخه تکراری است کد رهگیری ${tracking}`, 400),
          };
        await TaminPrescription.findOneAndUpdate(
          {
            prescription: prescription._id,
          },
          {
            prescription: prescription._id,
            [args.labItems ? "labTracking" : "tracking"]: tracking,
            [args.labItems ? "labTaminId" : "taminId"]: taminId,
          },
          { upsert: true },
        );
      } else {
        return {
          success: false,
          error: new AppError(
            `درخواست تامین ناموفق بود: ${
              data.data.result.error_Msg || "نامعلوم"
            }`,
            400,
          ),
        };
      }
    } else {
      if (!data.data?.result?.head_EPRSC_ID || !data.data.result.trackingCode)
        return { success: false, error: new BadTaminResponseError() };
      await TaminPrescription.findOneAndUpdate(
        {
          prescription: prescription._id,
        },
        {
          prescription: prescription._id,
          [args.labItems ? "labTaminId" : "taminId"]:
            data.data.result.head_EPRSC_ID,
          [args.labItems ? "labTracking" : "tracking"]:
            data.data.result.trackingCode,
        },
        { upsert: true },
      );
    }
  };
  console.log({ alreadyCommitted, prescription });
  if (!alreadyCommitted?.taminId && !!prescription.items.length)
    await submitASegmentForTamin({ items: prescription.items });
  if (!alreadyCommitted?.labTaminId && !!prescription.labItems.length)
    await submitASegmentForTamin({ labItems: prescription.labItems });
  return { success: true };
};

export const commitPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const presc = await _draftPrescription(req, next);
    if (!presc) return;
    const { success, error } = await _commitPrescription({
      id: presc._id.toString(),
      doctor: req.doctor,
    });
    if (!success) {
      await Prescription.findByIdAndDelete(presc._id);
      return next(error);
    }
    res.status(200).json({ message: "commitPrescription" });
  },
);

export const draftPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const presc = await _draftPrescription(req, next);
    if (!presc) return;
    res.status(200).json({ message: "draftPrescription" });
  },
);

export type TaminResponse = {
  data?: {
    result?: {
      trackingCode?: number | null;
      error_Msg?: string | null;
      error_Code?: string | null;
      complemantary_Msg?: string | null;
      head_EPRSC_ID?: string | null;
    };
  };
};

export const commitDraftedPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const prescription = await Prescription.findOne({
      _id: nodeId,
      author: req.doctor._id,
    });
    if (!prescription) return next(new NotFoundError());
    const { success, error } = await _commitPrescription({
      doctor: req.doctor,
      id: nodeId,
    });
    if (!success) return next(error);
    res.status(200).json({ message: "commitDraftedPrescription" });
  },
);

export const getMyPrescriptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await Prescription.find({ author: req.doctor._id }).populate([
      {
        path: "patient",
      },
      { path: "taminStatus" },
    ]);
    res.status(200).json({ message: "getMyPrescriptions", data });
  },
);

type ReloadPrescriptionTaminResponse =
  | {
      noteDetailsEprscId: number;
      noteDetailDrug: null;
      srvId: {
        srvId: number;
        srvType: {
          srvType: string;
          srvTypeDes: string;
          status: string;
          statusstDate: string;
          custType: string;
          prescTypeId: number;
          headExpireDate: number;
        };
        srvCode: string;
        srvName: string;
        srvName2: null;
        srvBimSw: string;
        srvSex: null;
        srvPrice: number;
        srvPriceDate: string;
        doseCode: null;
        formCode: {
          formCode: string;
          formDes: string;
          formGrp: null;
          status: string;
          statusstDate: string;
        };
        parTarefGrp: null;
        status: string;
        statusstDate: string;
        bGType: string;
        gSrvCode: string;
        agreementFlag: null;
        isDeleted: string;
        visible: string;
        dentalServiceType: null;
        wsSrvCode: string;
        hosprescType: string;
        srvRule: null;
        countIsRestricted: null;
        drugWarning: string;
        terminology: null;
        srvCodeComplete: string;
      };
      srvQty: number;
      srvRem: number;
      srvPrice: number;
      timesAday: {
        drugAmntId: number;
        drugAmntCode: string;
        drugAmntSumry: string;
        drugAmntLatin: string;
        drugAmntConcept: string;
        visibled: string;
      };
      dose: string;
      doseCode: number;
      repeat: null;
      isBrand: null;
      dateDo: null;
      isOk: string;
      drugInstruction: {
        drugInstId: number;
        drugInstCode: string;
        drugInstSumry: null;
        drugInstLatin: null;
        drugInstConcept: string;
      };
      isPayable: null;
      organId: null;
      organDesc: null;
      illnessId: null;
      illnessDesc: null;
      planId: null;
      planDesc: null;
      organDet: null;
      organDetDesc: null;
      confirmStatusflag: null;
      drugAmntId: number;
      drugInstId: number;
      isDentalService: null;
      noteHeadEprscId: null;
      toothId: null;
      referenceStatus: null;
      repeatDays: null;
      readOnly: boolean;
      messages: null;
      dialysisType: null;
    }[]
  | NonNullable<TaminResponse["data"]>["result"];

const reloadPrescriptionFromTaminSchema = z.strictObject({
  tracking: z.string(),
});
export const reloadPrescriptionFromTamin: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } =
      await reloadPrescriptionFromTaminSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const cred = await DoctorTaminCred.findOneAndUpdate(
      {
        doctor: req.doctor._id,
      },
      { doctor: req.doctor._id },
      { upsert: true, new: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ep-test.tamin.ir/api/v2/ep/${data.tracking}/${1234567891}/${2000200092}/detail`,
      method: "GET",
      token: cred.token,
    });
    if (!response.headers.get("Content-Type")?.includes("json")) {
      console.log(await response.text());
      return next(new TaminRideError());
    }
    const data1 = (await response.json()) as {
      data?: ReloadPrescriptionTaminResponse;
    };
    if (Array.isArray(data1.data)) {
      for (let i = 0; 0 < data1.data.length; ++i) {
        // const item = data1.data[i];
        return res
          .status(200)
          .json({ message: "reloadPrescriptionsFromTamin", data: data1.data });
      }
    } else {
      console.log(data1.data);
      return next(
        new AppError(data1.data?.error_Msg || "خطای ناشناخته ای رخ داده", 400),
      );
    }
  },
);

export const getMyPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Prescription.findOne({
      _id: nodeId,
      author: req.doctor._id,
    }).populate([
      { path: "author", populate: { path: "mcCode" } },
      { path: "patient" },
      { path: "items.item" },
      { path: "items.usage" },
      { path: "items.instruction" },
      { path: "items.amount" },
      { path: "taminStatus" },
      { path: "labItems.item" },
    ]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyPrescription", data });
  },
);

type RemoteTaminPrescription = {
  noteDetailsEprscId: number;
  noteDetailDrug: string | null;
  srvId: {
    srvId: number;
    srvType: {
      srvType: string;
      srvTypeDes: string;
      status: "0" | "1";
      statusstDate: string;
      custType: string;
      prescTypeId: number;
      headExpireDate: number;
    };
    srvCode: string;
    srvName: string;
    srvName2: string | null;
    srvBimSw: "0" | "1";
    srvSex: string | null;
    srvPrice: number;
    srvPriceDate: string;
    doseCode: string;
    formCode: {
      formCode: string;
      formDes: string;
      formGrp: string | null;
      status: "0" | "1";
      statusstDate: string;
    };
    parTarefGrp: string | null;
    status: "0" | "1";
    statusstDate: string;
    bGType: "0" | "1";
    gSrvCode: string | null;
    agreementFlag: null;
    isDeleted: "0" | "1";
    visible: "0" | "1";
    dentalServiceType: null | string;
    wsSrvCode: string;
    hosprescType: "0" | "1";
    srvRule: null | "string";
    countIsRestricted: null | string;
    drugWarning: "0" | "1";
    terminology: null | string;
    srvCodeComplete?: string;
  };
  srvQty: number;
  srvRem: number;
  srvPrice: number;
  timesAday: {
    drugAmntId: number;
    drugAmntCode: string;
    drugAmntSumry: string;
    drugAmntLatin: string;
    drugAmntConcept: string;
    visibled: "0" | "1";
  };
  dose: string | null;
  doseCode: number;
  repeat: string | null;
  isBrand: string | null;
  dateDo: string | null;
  isOk: "0" | "1";
  drugInstruction: {
    drugInstId: number;
    drugInstCode: string;
    drugInstSumry: string | null;
    drugInstLatin: string | null;
    drugInstConcept: string;
  };
  isPayable: null;
  organId: null;
  organDesc: null;
  illnessId: null;
  illnessDesc: null;
  planId: null;
  planDesc: null;
  organDet: null;
  organDetDesc: null;
  confirmStatusflag: null;
  drugAmntId: number;
  drugInstId: number;
  isDentalService: null;
  noteHeadEprscId: null;
  toothId: null;
  referenceStatus: null;
  repeatDays: null;
  readOnly: boolean;
  messages: null;
  dialysisType: null;
};

export const getTaminPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const prescription = await Prescription.findOne({
      _id: nodeId,
      author: req.doctor._id,
    }).populate({ path: "taminStatus" });
    if (!prescription) return next(new NotFoundError());
    if (!prescription.taminStatus?.taminId)
      return next(new AppError("این نسخه هنوز در تامین اجتماعی ثبت نشده", 400));
    const cred = await DoctorTaminCred.findOneAndUpdate(
      { doctor: req.doctor._id },
      { doctor: req.doctor._id },
      { upsert: true, new: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ep-test.tamin.ir/api/v2/ep/${prescription.taminStatus.taminId}/1234567891/2000200092/detail`,
      method: "GET",
      token: cred.token,
    });
    if (!response.headers.get("content-type")?.includes("json")) {
      console.log(await response.text());
      return next(new BadTaminResponseError());
    }
    const data = (await response.json()) as {
      data: ReloadPrescriptionTaminResponse;
    };
    res.status(200).json({ message: "getTaminPrescription", data });
  },
);

export const deletePrescriptionFromTamin: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const prescription = await Prescription.findOne({
      author: req.doctor._id,
      _id: nodeId,
    }).populate({ path: "taminStatus" });
    if (!prescription) return next(new NotFoundError());
    if (!prescription.taminStatus?.taminId)
      return next(new AppError("این نسخه هنوز یه تامین فرستاده نشده", 400));
    const cred = await DoctorTaminCred.findOneAndUpdate(
      { doctor: req.doctor._id },
      { doctor: req.doctor._id },
      { upsert: true, new: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ep-test.tamin.ir/api/v2/ep/${prescription.taminStatus.taminId}/1234567891/2000200092`,
      method: "POST",
      token: cred.token,
    });
    if (!response.headers.get("content-type")?.includes("json")) {
      console.log(await response.text());
      return next(new BadTaminResponseError());
    }
    const data = await response.json();
    if (data.status !== 200)
      return next(new AppError("عملیات با خطا مواجه شد", 400));
    console.log(data);
    await TaminPrescription.findByIdAndDelete(prescription.taminStatus._id);
    res.status(200).json({ message: "deletePrescriptionFromTamin" });
  },
);

export const getTaminServiceTypes: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const data = await TaminServiceType.find();
    res.status(200).json({ message: "getTaminServiceTypes", data });
  },
);

export const getShifts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorShift.find({ doctor: req.doctor._id });
    res.status(200).json({ message: "getShifts", data });
  },
);

const setShiftShcema = z.strictObject({
  shifts: z.array(
    z.strictObject({
      day: z.number().int().min(0).max(6),
      start: z
        .number()
        .int()
        .min(0)
        .max(24 * 60),
      end: z
        .number()
        .int()
        .min(0)
        .max(60 * 24),
      office: z.string(),
      duration: z.number().int().min(0),
      gap: z.number().int().min(0),
      sessionTypes: z.array(z.enum(doctorSessionTypes)).nonempty(),
      patientTypes: z.array(z.enum(patientStatuses)).nonempty(),
      name: z.string(),
    }),
  ),
});

export const setShifts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success, error } = await setShiftShcema.safeParseAsync(
      req.body,
    );
    if (!success) {
      console.log(error);
      return next(new AppError(error.message, 400));
    }
    const offices = await Office.find({ doctor: req.doctor._id });
    for (const shift of data.shifts) {
      if (!offices.find((office) => office._id.toString() === shift.office))
        return next(new BadInputError("Office Not Found"));
      if (shift.end < shift.start)
        return next(new BadInputError("Bad Shift Bounds"));
    }
    for (const day of doctorShiftDays) {
      const todaysShifts = data.shifts.filter((shift) => shift.day === day);
      for (let i = 1; i < todaysShifts.length; i++) {
        if (todaysShifts[i].start < todaysShifts[i - 1].end) {
          return next(new BadInputError("Shifts Overlap"));
        }
      }
    }
    await DoctorShift.deleteMany({ doctor: req.doctor._id });
    await DoctorShift.insertMany(
      data.shifts.map((el) => ({ ...el, doctor: req.doctor?._id })),
    );
    res.status(200).json({ message: "setShifts " });
    const now = new Date();
    const lastDay = new Date();
    lastDay.setDate(lastDay.getDate() + env.BOOKING_HORIZON_DAYS);
    await updateDoctorAvailability({
      doctor: req.doctor,
      startDate: now,
      endDate: lastDay,
    });
  },
);

// Doctor-facing license catalog + purchase (2026-09) - lets a doctor buy one
// of the admin-managed BaseDoctorLicense tiers, unlocking the dashboard
// modules that tier grants. See Models/BaseDoctorLicense.ts (the catalog)
// and Models/DoctorProfileLicense.ts (the doctor's own current license
// record, one per doctor).

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
    new Set(
      licenses.flatMap((license) =>
        license.pricing.map((p) => `${p.duration}`),
      ),
    ),
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
    if (!req.doctor) return next(new MiddlewareError());
    const licenses = await BaseDoctorLicense.find({
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
    if (!req.doctor) return next(new MiddlewareError());
    const licenses = await BaseDoctorLicense.find({ isActive: true })
      .sort({ order: 1 })
      .select("-details");
    const durations = await findReferencedDurations(licenses);
    res.status(200).json({
      message: "getActiveLicenses",
      // `modules` here is the full doctorDashboardModules enum, not just
      // whatever the returned licenses' own `modules[]` happen to include -
      // lets the "see all plans" page render a full plan-vs-module
      // comparison.
      data: { licenses, durations, modules: doctorDashboardModules },
    });
  },
);

// Single-plan fetch (2026-09) for a plan-detail page - returns the full
// BaseDoctorLicense document (details included, unlike the list endpoints
// above) with each pricing entry's duration populated inline, since
// there's only one document here to enrich.
export const getLicenseById: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const license =
      await BaseDoctorLicense.findById(nodeId).populate("pricing.duration");
    if (!license) return next(new NotFoundError());
    res.status(200).json({ message: "getLicenseById", data: license });
  },
);

// Dashboard-home widget fetch (2026-09) - the doctor's own currently
// assigned DoctorProfileLicense (if any), plus whether it's expired. Unlike
// resolveMyLicenseModules below (which silently falls back to the
// isDefault tier's modules on expiry, for gating purposes), the widget
// needs the raw record and expiry state directly so it can show "no
// license" / "expired" rather than pretending the fallback tier was
// actually purchased.
export const getMyCurrentLicense: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const current = await DoctorProfileLicense.findOne({
      owner: req.doctor._id,
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
    if (!req.doctor || !req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data: input, success } = await purchaseLicenseSchema.safeParseAsync(
      req.body,
    );
    if (!success || !isValidObjectId(input.duration))
      return next(new BadInputError());
    const license = await BaseDoctorLicense.findById(nodeId);
    if (!license) return next(new NotFoundError());

    // A doctor with an active (non-expired) ProfileLicense can't buy
    // another plan until it expires (2026-09) - avoids double-charging and
    // silently clobbering time still left on the current plan. Same
    // expiry check getMyCurrentLicense/resolveMyLicenseModules use.
    const existingLicense = await DoctorProfileLicense.findOne({
      owner: req.doctor._id,
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

    const data = await DoctorProfileLicense.findOneAndUpdate(
      { owner: req.doctor._id },
      {
        owner: req.doctor._id,
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
        doctor: req.doctor._id,
        license: license._id,
      });
    }

    res.status(200).json({ message: "purchaseLicense", data });
  },
);

// Resolves which dashboard modules a doctor currently has access to
// (2026-09), shared by requireLicenseModule (single-module gate on a route)
// and getMyLicenseModules (the full resolved set, for the frontend to gate
// whole pages with).
//
// Resolution order:
//  1. If this doctor already has a DoctorProfileLicense AND it isn't
//     expired (expiresAt unset, or still in the future - see
//     doctorController.purchaseLicense for how expiresAt gets set), that
//     record's `modules` is authoritative.
//  2. Otherwise (no record, or an expired one) fall back to whichever
//     BaseDoctorLicense tier has `isDefault: true` (at most one is
//     expected, per that field's own comment) - a doctor who never
//     purchased anything, or whose purchase lapsed, is treated as being on
//     the default tier.
//  3. If no BaseDoctorLicense is marked default either, there is nothing to
//     gate against, so every module is considered allowed.
const resolveMyLicenseModules = async (
  doctorId: unknown,
): Promise<DoctorDashboardModule[]> => {
  const current = await DoctorProfileLicense.findOne({ owner: doctorId });
  const isExpired = !!current?.expiresAt && current.expiresAt < new Date();
  if (current && !isExpired) return current.modules;

  const defaultLicense = await BaseDoctorLicense.findOne({ isDefault: true });
  if (!defaultLicense) return [...doctorDashboardModules];
  return defaultLicense.modules;
};

// Gates a route behind a dashboard module the doctor's license must grant.
// Meant to sit after aclController.useDoctor(...) in a route's middleware
// chain, same as any other req.doctor-dependent check here.
export const requireLicenseModule = (
  mod: DoctorDashboardModule,
): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const modules = await resolveMyLicenseModules(req.doctor._id);
    if (!modules.includes(mod)) return next(new AccessError());
    next();
  });

// Doctor-facing resolved module list (2026-09) - lets the frontend gate an
// entire page with a friendly notice instead of letting the underlying API
// calls fail with AccessError. Deliberately not gated by "readLicenses" (or
// any other action) - every doctor-context request, owner or delegated
// secretary, needs this to know what it can show.
export const getMyLicenseModules: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await resolveMyLicenseModules(req.doctor._id);
    res.status(200).json({ message: "getMyLicenseModules", data });
  },
);

const DASHBOARD_TODAY_LIMIT = 12;
const DASHBOARD_UPCOMING_DAYS = 7;
const DASHBOARD_PERIOD_DAYS = 30;

// GET /doctor/dashboard - everything the doctor panel home shows, in one
// request. Each section is included only if the owner/secretary may see it
// (aclAllows), mirroring the sidebar's permissions; hidden sections are null.
export const getMyDashboard: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const doctor = req.doctor;
    const isOwner = req.aclGrant === "FULL";
    const canSchedule = aclAllows(req, "readSchedule");
    const canFinance = aclAllows(req, "readFinance");
    const canOrders = aclAllows(req, "readOrders");

    const today = todayStart();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const upcomingEnd = new Date(tomorrow);
    upcomingEnd.setDate(upcomingEnd.getDate() + DASHBOARD_UPCOMING_DAYS);
    const periodStart = new Date(today);
    periodStart.setDate(periodStart.getDate() - DASHBOARD_PERIOD_DAYS);

    const schedule = canSchedule
      ? await Promise.all([
          Reservation.find({
            doctor: doctor._id,
            date: { $gte: today, $lt: tomorrow },
            status: { $ne: "cancelled" },
          })
            .sort({ start: 1 })
            .limit(DASHBOARD_TODAY_LIMIT)
            .populate([
              { path: "patient", select: "givenName lastName" },
              { path: "user", select: "phone" },
              { path: "office", select: "name" },
            ])
            .select("date start end status sessionType patient user office"),
          Reservation.countDocuments({
            doctor: doctor._id,
            date: { $gte: tomorrow, $lt: upcomingEnd },
            status: { $in: ["pending", "active"] },
          }),
          Reservation.aggregate([
            {
              $match: {
                doctor: doctor._id,
                date: { $gte: periodStart, $lt: tomorrow },
              },
            },
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
                total: { $sum: { $ifNull: ["$subtotal", 0] } },
              },
            },
          ]),
        ])
      : null;

    let pendingOrders: number | null = null;
    if (canOrders) {
      const { serviceIds, packageIds } = await getMyIncomingOrderOwnedIds(doctor._id);
      pendingOrders = await Order.countDocuments({
        status: "paid",
        $or: [
          { services: { $elemMatch: { item: { $in: serviceIds }, status: "pending" } } },
          { servicePackages: { $elemMatch: { item: { $in: packageIds }, status: "pending" } } },
        ],
      });
    }

    // Setup checklist - what a new doctor still has to do before patients
    // can book. Owner only (it links to owner-level settings pages).
    let setup: { key: string; done: boolean }[] | null = null;
    if (isOwner) {
      const [offices, shifts, services, activeSettings] = await Promise.all([
        Office.countDocuments({ doctor: doctor._id }),
        DoctorShift.countDocuments({ doctor: doctor._id }),
        Service.countDocuments({ owner: doctor._id }),
        Promise.all(
          Object.values(doctorSessionKindSettingsModelDict).map((model) =>
            model.exists({ doctor: doctor._id, active: true, price: { $gt: 0 } }),
          ),
        ).then((found) => found.filter(Boolean).length),
      ]);
      setup = [
        { key: "profile", done: !!(doctor.firstName && doctor.lastName && doctor.mainSpeciality && doctor.avatar) },
        { key: "introduction", done: !!doctor.introduction },
        { key: "office", done: offices > 0 },
        { key: "settings", done: activeSettings > 0 },
        { key: "shift", done: shifts > 0 },
        { key: "service", done: services > 0 },
      ];
    }

    const byStatus = schedule
      ? Object.fromEntries(schedule[2].map((row: any) => [row._id, row.count]))
      : null;
    const completedIncome = schedule
      ? schedule[2]
          .filter((row: any) => row._id === "completed")
          .reduce((sum: number, row: any) => sum + row.total, 0)
      : 0;

    res.status(200).json({
      message: "getMyDashboard",
      data: {
        doctor: {
          firstName: doctor.firstName,
          lastName: doctor.lastName,
          active: doctor.active,
          slug: doctor.slug,
          averageScore: doctor.averageScore,
          feedbackCount: doctor.feedbackCount,
        },
        isOwner,
        periodDays: DASHBOARD_PERIOD_DAYS,
        upcomingDays: DASHBOARD_UPCOMING_DAYS,
        today: schedule ? schedule[0] : null,
        upcoming: schedule ? schedule[1] : null,
        period: schedule
          ? {
              byStatus,
              total: Object.values(byStatus || {}).reduce(
                (sum: number, n) => sum + (n as number),
                0,
              ),
              completedIncome: canFinance ? completedIncome : null,
            }
          : null,
        pendingOrders,
        setup,
      },
    });
  },
);

const FINANCE_MONTHS = 6;
const FINANCE_PAGE_SIZE = 20;

const financeQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
});

// GET /doctor/finance?page= (readFinance) - the doctor's money in one view:
// wallet balance of the doctor's own account, earned payouts (this month,
// last month, all time, and per month for the chart), income still to come
// from booked-but-unfinished reservations, license spend, and a paginated
// list of every transaction tied to this doctor profile (reservation
// payouts and license purchases - see Services/reservationProgressService.ts
// and purchaseLicense).
export const getMyFinance: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const parsed = financeQuerySchema.safeParse(req.query);
    if (!parsed.success) return next(new BadInputError(parsed.error.message));
    const { page } = parsed.data;
    const doctor = req.doctor;

    // Jalali (Persian calendar) months - "this month" and the chart follow
    // the calendar the panel shows, not Gregorian months.
    const monthStart = moment().startOf("jMonth").toDate();
    const lastMonthStart = moment().subtract(1, "jMonth").startOf("jMonth").toDate();
    const monthStarts = Array.from({ length: FINANCE_MONTHS + 1 }, (_, i) =>
      moment()
        .subtract(FINANCE_MONTHS - 1 - i, "jMonth")
        .startOf("jMonth")
        .toDate(),
    );
    const doctorUserId = doctor.user?._id;

    const payoutMatch = { doctor: doctor._id, reservation: { $exists: true }, amount: { $gt: 0 } };
    const sumOf = async (match: Record<string, unknown>) =>
      (
        await Transaction.aggregate([
          { $match: match },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ])
      )[0]?.total || 0;

    const [wallet, thisMonth, lastMonth, allTime, licenseSpend, upcoming, monthly, items, total] =
      await Promise.all([
        doctorUserId ? Wallet.findOne({ user: doctorUserId }).select("balance").lean() : null,
        sumOf({ ...payoutMatch, createdAt: { $gte: monthStart } }),
        sumOf({ ...payoutMatch, createdAt: { $gte: lastMonthStart, $lt: monthStart } }),
        sumOf(payoutMatch),
        sumOf({ doctor: doctor._id, license: { $exists: true } }),
        Reservation.aggregate([
          { $match: { doctor: doctor._id, status: { $in: ["pending", "active"] } } },
          { $group: { _id: null, total: { $sum: { $ifNull: ["$subtotal", 0] } }, count: { $sum: 1 } } },
        ]),
        Promise.all(
          monthStarts.slice(0, FINANCE_MONTHS).map((start, i) =>
            sumOf({ ...payoutMatch, createdAt: { $gte: start, $lt: monthStarts[i + 1] } }),
          ),
        ),
        Transaction.find({ doctor: doctor._id })
          .sort({ createdAt: -1 })
          .skip((page - 1) * FINANCE_PAGE_SIZE)
          .limit(FINANCE_PAGE_SIZE)
          .populate([
            {
              path: "reservation",
              select: "date start sessionType patient",
              populate: { path: "patient", select: "givenName lastName" },
            },
            { path: "license", select: "displayName" },
          ])
          .select("amount createdAt reservation license")
          .lean(),
        Transaction.countDocuments({ doctor: doctor._id }),
      ]);

    // one entry per Jalali month, oldest first; `month` is its first day
    const months = monthly.map((total: number, i: number) => ({
      month: monthStarts[i],
      total,
    }));

    res.status(200).json({
      message: "getMyFinance",
      data: {
        balance: wallet?.balance ?? 0,
        income: { thisMonth, lastMonth, allTime },
        upcoming: { total: upcoming[0]?.total || 0, count: upcoming[0]?.count || 0 },
        licenseSpend: Math.abs(licenseSpend),
        months,
        transactions: { items, total, page, limit: FINANCE_PAGE_SIZE },
      },
    });
  },
);
