import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  AccessError,
  BadInputError,
  DoctorsOnlyError,
  MiddlewareError,
  NotFoundError,
  ServerError,
} from "../Lib/AppError";
import BecomeDoctorRequest, {
  genders,
  medicalSystemTitles,
} from "../Models/BecomeDoctorRequest";
import * as z from "zod";
import { provinceSlugs } from "../Lib/Provinces";
import { citySlugs } from "../Lib/Cities";
import { isValidObjectId, Model } from "mongoose";
import Speciality from "../Models/Speciality";
import DoctorProfile from "../Models/DoctorProfile";
import ClinicDoctor from "../Models/ClinicDoctor";
import DoctorJoinClinicRequest from "../Models/DoctorJoinClinicRequest";
import ClinicAdditionRequest from "../Models/ClinicAdditionRequest";
import Clinic from "../Models/Clinic";
import {
  boolish,
  datish,
  getSessionDateKey,
  isPoint,
  nullish,
  numerish,
  phonish,
  sleep,
  startOfTomorrow,
} from "../Lib/helpers";
import { validateProvinceAndCity } from "../Lib/validators";
import User from "../Models/User";
import { cookieOptions, extractDataFromCookie } from "./authController";
import DoctorSession, {
  DoctorSessionType,
  doctorSessionTypes,
} from "../Models/DoctorSession";
import { doctorSessionKindSettingsModelDict } from "./bookingController";
import DoctorInsurance from "../Models/DoctorInsurance";
import Insurance from "../Models/Insurance";
import InsuranceAdditionRequest from "../Models/InsuranceAdditionRequest";
import DoctorPharmacy from "../Models/DoctorPharmacy";
import Pharmacy from "../Models/Pharmacy";
import PharmacyAdditionRequest from "../Models/PharmacyAdditionRequest";

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
        new AppError("درخواست شما قبلا ثبت شده در دست بررسی میباشد", 411)
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
    await BecomeDoctorRequest.findOneAndUpdate(
      { user: req.user._id },
      {
        ...data,
        user: req.user._id,
        status: "Pending",
      },
      { upsert: true }
    );
    res.status(200).json({ message: "becomeDoctor" });
  }
);

export const getMyBecomeDoctorRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await BecomeDoctorRequest.findOne({ user: req.user._id });
    res
      .status(200)
      .json({ message: "getMyBecomeDoctorRequest", data: { data } });
  }
);

export const getMyDoctorProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorProfile.findById(req.doctor._id);
    if (!data) return next(new DoctorsOnlyError());
    res.status(200).json({ message: "getMyDoctorProfile", data: { data } });
  }
);

const updateProfileSchema = z.strictObject({ location: isPoint.optional() });

export const updateMyProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = await updateProfileSchema.safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    const payload: Record<string, unknown> = {};
    if (data.location)
      payload.location = { type: "Point", coordinates: data.location };
    await DoctorProfile.findByIdAndUpdate(req.doctor._id, payload);
    res.status(200).json({ message: "updateMyProfile" });
  }
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
              .join("")
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
  }
);

export const getMyJoinClinicRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorJoinClinicRequest.find({
      doctor: req.doctor._id,
    }).populate({ path: "clinic" });
    res.status(200).json({ message: "getMyJoinClinicRequest", data });
  }
);

export const getMyClinicAdditionRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await ClinicAdditionRequest.find({
      submittedBy: req.doctor._id,
    });
    res.status(200).json({ message: "getMyClinicAdditionRequests", data });
  }
);

export const toggleJoinClinicRequestStatus: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    res.status(200).json({ message: "toggleJoinClinicRequestStatus" });
  }
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
  }
);

const joinClinicRequestSchema = z.strictObject({
  message: z.string().optional(),
  clinic: z.string(),
});
export const submitAJoinClinicRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());

    const { data, success } = await joinClinicRequestSchema.safeParseAsync(
      req.body
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
  }
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
      req.body
    );
    if (!success) return next(new BadInputError());
    if (!validateProvinceAndCity(data.province, data.city))
      return next(new BadInputError());
    await ClinicAdditionRequest.create({
      ...data,
      submittedBy: req.doctor._id,
    });
    res.status(200).json({ message: "submitAClinicAdditionRequest" });
  }
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
  }
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
  }
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
    {} as Record<DoctorSessionType, unknown>
  ),
});
export const addSessions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success, error } = await addSessionsSchema.safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    if (data.end <= data.start) return next(new BadInputError());
    if (data.end - data.start <= data.duration)
      return next(new BadInputError());
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
        });
      }
    }
    if (sessionsToInsert.length)
      await DoctorSession.insertMany(sessionsToInsert);
    res.status(200).json({ message: "addSessions" });
  }
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
  }
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
    }).populate({ path: "booking" });
    res.status(200).json({ message: "getSessionsByDayFull", data });
  }
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
  }
);

const editSessionSchema = z.strictObject({
  start: numerish(0, 1440),
  end: numerish(0, 1440),
  note: z.string().optional(),
  ...doctorSessionTypes.reduce(
    (acc, el) => ({ ...acc, [el]: boolish.optional() }),
    {} as Record<DoctorSessionType, unknown>
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
        new AppError("زمان درخواستی قبلا برای جلسه دیگر ثبت شده", 400)
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
  }
);

const createSessionSchema = z.strictObject({
  start: numerish(0, 1440),
  end: numerish(0, 1440),
  note: z.string().optional(),
  stamp: z.string(),
  ...doctorSessionTypes.reduce(
    (acc, el) => ({ ...acc, [el]: boolish.optional() }),
    {} as Record<DoctorSessionType, unknown>
  ),
});
export const createSession: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = await createSessionSchema.safeParseAsync(
      req.body
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
        new AppError("زمان انتخاب شده قبلا برای جلسه دیگری وارد شده است", 400)
      );
    await DoctorSession.create({
      date: dateKey,
      doctor: req.doctor._id,
      end: data.end,
      note: data.note,
      start: data.start,
      ...doctorSessionTypes.reduce(
        (acc, el) => ({ ...acc, [el]: data[el] }),
        {}
      ),
    });
    res.status(200).json({ message: "createSession" });
  }
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
      { upsert: true, new: true }
    );
    res.status(200).json({ message: "getMySettings", data });
  }
);

const common = {
  price: numerish(0, Number.MAX_SAFE_INTEGER),
  active: boolish,
};

const editSettingsSchemaDict: Record<DoctorSessionType, z.ZodSchema<any>> = {
  inPerson: z.strictObject(common),
  sipCall: z.strictObject({
    //TODO: add Phone Validators
    reciever: z.string(),
    ...common,
  }),
  textChat: z.strictObject(common),
  videoCall: z.strictObject(common),
  voiceCall: z.strictObject(common),
};

export const editMySettings: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { kind: _kind } = req.params;
    const kind = doctorSessionTypes.find((el) => el === _kind);
    if (!kind) return next(new BadInputError());
    const { data, success } = await editSettingsSchemaDict[kind].safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    await doctorSessionKindSettingsModelDict[kind].findOneAndUpdate(
      { doctor: req.doctor._id },
      { ...data, doctor: req.doctor._id },
      { upsert: true, new: true }
    );
    res.status(200).json({ message: "editMySettings" });
  }
);

export const getMyInsurances: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorInsurance.find({
      doctor: req.doctor._id,
    }).populate({ path: "insurance" });
    res.status(200).json({ message: "getMyInsurances", data });
  }
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
  }
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
  }
);

export const getMyInsuranceAdditions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await InsuranceAdditionRequest.find({
      submittedBy: req.doctor._id,
    });
    res.status(200).json({ message: "getMyInsuranceAdditions", data });
  }
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
    await InsuranceAdditionRequest.create({
      ...data,
      submittedBy: req.doctor._id,
    });
    res.status(200).json({ message: "submitInsuranceAddition" });
  }
);

export const getMyPharmacies: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorPharmacy.find({ doctor: req.doctor._id }).populate(
      {
        path: "pharmacy",
      }
    );
    res.status(200).json({ message: "getMyPharmacies", data });
  }
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
  }
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
  }
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
    await PharmacyAdditionRequest.create({
      ...data,
      submittedBy: req.doctor._id,
    });
    res.status(200).json({ message: "submitPharmacyAdditionRequest" });
  }
);

export const getMyPharmacyAdditionRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await PharmacyAdditionRequest.find({
      submittedBy: req.doctor._id,
    });
    res.status(200).json({ message: "getMyPharmacyAdditionRequests", data });
  }
);
