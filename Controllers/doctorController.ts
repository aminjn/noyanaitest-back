import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  AccessError,
  BadInputError,
  DoctorsOnlyError,
  MiddlewareError,
  NotFoundError,
  NotImplementedError,
  ServerError,
} from "../Lib/AppError";
import BecomeDoctorRequest, {
  genders,
  medicalSystemTitles,
} from "../Models/BecomeDoctorRequest";
import * as z from "zod";
import { provinceSlugs } from "../Lib/Provinces";
import { citySlugs } from "../Lib/Cities";
import { isValidObjectId } from "mongoose";
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
  nullish,
  numerish,
  phonish,
  sleep,
  startOfTomorrow,
} from "../Lib/helpers";
import { validateProvinceAndCity } from "../Lib/validators";
import DoctorSecretary from "../Models/DoctorSecretary";
import DoctorSecretaryRequest from "../Models/DoctorSecretaryRequest";
import DoctorSecretaryAccessLevel, {
  DoctorSecretaryAction,
  doctorSecretaryActions,
} from "../Models/DoctorSecretaryAccessLevel";
import User from "../Models/User";
import { cookieOptions, extractDataFromCookie } from "./authController";
import DoctorSession, {
  DoctorSessionType,
  doctorSessionTypes,
} from "../Models/DoctorSession";
import { doctorSessionKindSettingsModelDict } from "./bookingController";

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
    return;
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

export const useDoctor: (
  action?: DoctorSecretaryAction | true
) => RequestHandler = (action) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { doctor } = req.cookies;
    if (doctor) {
      const decoded = await extractDataFromCookie({
        cookie: doctor,
        name: "doctor",
        res: res,
      });
      const fail = () => {
        res.clearCookie("doctor", cookieOptions);
        return next(new DoctorsOnlyError());
      };
      if (!decoded) return fail();
      const { id } = decoded;
      if (!isValidObjectId(id)) return fail();
      const node = await DoctorSecretary.findOne({
        _id: id,
        secretary: req.user._id,
      });
      if (!node) return fail();
      if (!node.doctor) return fail();
      const profile = await DoctorProfile.findById({ _id: node.doctor._id });
      if (!profile) return fail();
      if (action === true) return next(new AccessError());
      if (action) {
        if (!node.accessLevel) return next(new AccessError());
        const acl = await DoctorSecretaryAccessLevel.findById({
          _id: node.accessLevel._id,
        });
        if (!acl) return next(new AccessError());
        if (!acl[action]) return next(new AccessError());
        req.doctor = profile;
      } else {
        req.doctor = profile;
      }
    } else {
      const profile = await DoctorProfile.findOne({ user: req.user._id });
      if (!profile) return next(new DoctorsOnlyError());
      req.doctor = profile;
    }
    next();
  });

export const getMyDoctorAcl: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor || !req.user) return next(new MiddlewareError());
    if (req.doctor.user?._id.toString() === req.user._id.toString())
      return res
        .status(200)
        .json({ message: "getMyDoctorAcl", data: { access: "FULL" } });
    const acl = await DoctorSecretary.findOne({
      doctor: req.doctor._id,
      secretary: req.user._id,
    });
    if (!acl || !acl.accessLevel) return next(new AccessError());
    const access = await DoctorSecretaryAccessLevel.findById(
      acl.accessLevel._id
    );
    if (!access) return next(new AccessError());
    res.status(200).json({ message: "getMyDoctorAcl", data: { access } });
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

export const searchClinics: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { query: _name } = req.body;
    if (typeof _name !== "string") return next(new BadInputError());
    const name = _name.trim();
    if (name.length < 3) return next(new BadInputError());
    const data = await Clinic.find({
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
      .limit(10);
    res.status(200).json({ message: "searchClinics", data });
  }
);

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

export const getMyAccessLevels: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorSecretaryAccessLevel.find({
      $or: [{ owner: req.doctor._id }, { owner: null }],
    });
    res.status(200).json({ message: "getMyAccessLevels", data });
  }
);

const mutateAccessLevelSchema = z.strictObject({
  name: z.string().optional(),
  ...doctorSecretaryActions.reduce(
    (acc, action) => ({ ...acc, [action]: boolish.optional() }),
    {}
  ),
});
export const createAccessLevel: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success, error } =
      await mutateAccessLevelSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    await DoctorSecretaryAccessLevel.create({
      ...data,
      owner: req.doctor._id,
    });
    res.status(200).json({ message: "createAccessLevel" });
  }
);

export const editAccessLevel: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await mutateAccessLevelSchema.safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    const node = await DoctorSecretaryAccessLevel.findOne({
      _id: nodeId,
      owner: req.doctor._id,
    });
    if (!node) return next(new NotFoundError());
    await DoctorSecretaryAccessLevel.findByIdAndUpdate(node._id, data);
    res.status(200).json({ message: "editAccessLevel" });
  }
);

export const deleteAccessLevel: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    const node = await DoctorSecretaryAccessLevel.findOne({
      _id: nodeId,
      owner: req.doctor._id,
    });
    if (!node) return next(new NotFoundError());
    await DoctorSecretaryAccessLevel.findByIdAndDelete(node._id);
    res.status(200).json({ message: "deleteAccessLevel" });
  }
);

export const getMySecretaryRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorSecretaryRequest.find({
      doctor: req.doctor._id,
    }).populate({ path: "accessLevel" });
    res.status(200).json({ message: "getMySecretaryRequests", data });
  }
);

const submitSecretaryRequestSchema = z.strictObject({
  phone: phonish,
  displayName: z.string().optional(),
  accessLevel: z.string().optional(),
  message: z.string().optional(),
});
export const submitASecretaryRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } = await submitSecretaryRequestSchema.safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    const user = await User.findOne({ _id: req.doctor.user?._id });
    if (!user) return next(new ServerError());
    if (user.phone === data.phone)
      return next(new AppError("نمیتوانید منشی خودتان باشید", 400));
    if (data.accessLevel) {
      if (!isValidObjectId(data.accessLevel)) return next(new BadInputError());
      const acl = await DoctorSecretaryAccessLevel.exists({
        _id: data.accessLevel,
        $or: [{ owner: req.doctor._id }, { owner: null }],
      });
      if (!acl) return next(new NotFoundError());
    }
    const dup = await DoctorSecretaryRequest.exists({
      phone: data.phone,
      doctor: req.doctor._id,
    });
    if (dup) return next(new AppError("این درخواست قبلا ثبت شده", 400));
    await DoctorSecretaryRequest.create({ doctor: req.doctor._id, ...data });
    res.status(200).json({ message: "submitASecretaryRequest" });
  }
);

const editSecretaryRequestSchema = z.strictObject({
  displayName: z.string().optional(),
  accessLevel: nullish,
  message: z.string().optional(),
});
export const editSecretaryRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    const { data, success } = await editSecretaryRequestSchema.safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await DoctorSecretaryRequest.findOne({
      _id: nodeId,
      doctor: req.doctor._id,
    });
    if (!node) return next(new NotFoundError());
    if (node.status !== "Pending")
      return next(new AppError("این درخواست در شرایط مناسبی قرار ندارد", 400));
    if (data.accessLevel) {
      if (!isValidObjectId(data.accessLevel)) return next(new BadInputError());
      const acl = await DoctorSecretaryAccessLevel.exists({
        _id: data.accessLevel,
        $or: [{ owner: req.doctor._id }, { owner: null }],
      });
      if (!acl) return next(new NotFoundError());
    }
    await DoctorSecretaryRequest.findByIdAndUpdate(node._id, data);
    res.status(200).json({ message: "editSecretaryRequest" });
  }
);

export const getMySecretaries: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await DoctorSecretary.find({
      doctor: req.doctor._id,
    }).populate([
      { path: "accessLevel", select: "name" },
      { path: "secretary", select: "phone" },
    ]);
    res.status(200).json({ message: "getMySecretaries", data });
  }
);

const editSecretarySchema = z.strictObject({ accessLevel: nullish });
export const editMySecretary: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await editSecretarySchema.safeParseAsync(
      req.body
    );
    if (!success) return next(new BadInputError());
    if (data.accessLevel) {
      if (!isValidObjectId(data.accessLevel)) return next(new BadInputError());
      const acl = await DoctorSecretaryAccessLevel.findOne({
        _id: data.accessLevel,
        $or: [{ owner: req.doctor._id }, { owner: null }],
      });
      if (!acl) return next(new NotFoundError());
    }
    const secretary = await DoctorSecretary.findOne({
      doctor: req.doctor._id,
      _id: nodeId,
    });
    if (!secretary) return next(new NotFoundError());
    await DoctorSecretary.findByIdAndUpdate(secretary._id, {
      accessLevel: data.accessLevel,
    });
    res.status(200).json({ message: "editMySecretary" });
  }
);

export const deleteMySecretary: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const secretary = await DoctorSecretary.findOne({
      doctor: req.doctor._id,
      _id: nodeId,
    });
    if (!secretary) return next(new NotFoundError());
    await DoctorSecretary.findByIdAndDelete(secretary._id);
    res.status(200).json({ message: "deleteMySecretary" });
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
