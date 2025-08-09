import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  DoctorsOnlyError,
  MiddlewareError,
  NotFoundError,
  NotImplementedError,
} from "../Lib/AppError";
import BecomeDoctorRequest, {
  genders,
  medicalSystemTitles,
} from "../Models/BecomeDoctorRequest";
import * as z from "zod";
import { provinces, provinceSlugs } from "../Lib/Provinces";
import { cities, citySlugs } from "../Lib/Cities";
import { isValidObjectId } from "mongoose";
import Speciality from "../Models/Speciality";
import DoctorProfile from "../Models/DoctorProfile";
import ClinicDoctor from "../Models/ClinicDoctor";
import DoctorJoinClinicRequest from "../Models/DoctorJoinClinicRequest";
import ClinicAdditionRequest from "../Models/ClinicAdditionRequest";
import Clinic from "../Models/Clinic";
import { sleep } from "../Lib/helpers";
import { validateProvinceAndCity } from "../Lib/validators";

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

export const useDoctor: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { secretary } = req.headers;
    if (secretary) {
      return next(new NotImplementedError());
    } else {
      const profile = await DoctorProfile.findOne({ user: req.user._id });
      if (!profile) return next(new DoctorsOnlyError());
      req.doctor = profile;
    }
    next();
  }
);

export const getMyDoctorProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await DoctorProfile.findOne({ user: req.user });
    if (!data) return next(new DoctorsOnlyError());
    res.status(200).json({ message: "getMyDoctorProfile", data: { data } });
  }
);

export const searchClinics: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await sleep(3000);
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
    if (!req.user) return next(new MiddlewareError());
    const data = await ClinicAdditionRequest.find({
      submittedBy: req.user._id,
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

export const submitAJoinClinicRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const joinClinicRequestSchema = z.strictObject({
      message: z.string().optional(),
      clinic: z.string(),
    });
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

export const submitAClinicAdditionRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const clinicAdditionRequestSchema = z.strictObject({
      clinicName: z.string().trim().min(1),
      ownerName: z.string().trim().min(1),
      ownerPhone: z.string().regex(/^\d+$/),
      province: z.enum(provinceSlugs),
      city: z.enum(citySlugs),
      clinicAddress: z.string().trim().min(1),
      description: z.string().optional(),
    });
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
