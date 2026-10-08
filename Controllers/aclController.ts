import e, { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  AccessError,
  BadInputError,
  MiddlewareError,
  NotFoundError,
  PathNotFoundError,
  ServerError,
} from "../Lib/AppError";
import { isValidObjectId, Model } from "mongoose";
import InsuranceAcl, {
  InsuranceAction,
  insuranceActions,
} from "../Models/InsuranceAcl";
import ClinicAcl, { ClinicAction, clinicActions } from "../Models/clinicAcl";
import DoctorAcl, { DoctorAction, doctorActions } from "../Models/DoctorAcl";
import PharmacyAcl, {
  PharmacyAction,
  pharmacyActions,
} from "../Models/pharmacyAcl";
import * as z from "zod";
import { boolish, nullish, phonish } from "../Lib/helpers";
import SecretaryRequest from "../Models/SecretaryRequest";
import User from "../Models/User";
import Notification from "../Models/Notification";
import { sendSMS } from "../Lib/sendSms";
import Secretary, {
  SecretaryAclPath,
  SecretaryNodePath,
  nodesWithAclToSecreataryAclPathDict,
} from "../Models/Secretary";
import { cookieOptions, extractDataFromCookie } from "./authController";
import Clinic from "../Models/Clinic";
import DoctorProfile from "../Models/DoctorProfile";
import Insurance from "../Models/Insurance";
import Pharmacy from "../Models/Pharmacy";
import { NODE_ENV } from "../Lib/Env";
import ParaClinicAcl, {
  ParaClinicAction,
  paraClinicActions,
} from "../Models/ParaClinicAcl";
import ParaClinic from "../Models/Paraclinic";
import HospitalAcl, {
  HospitalAction,
  hospitalActions,
} from "../Models/hospitalAcl";
import Hospital from "../Models/Hospital";
import { nodesWithAcl, NodeWithAcl } from "../Lib/enums";
import {
  ACTIVE_CENTRE_HEADER,
  activeCentreCookie,
  isMultiCentreKind,
  resolveOwnedCentre,
} from "../Lib/activeCentre";

export { nodesWithAcl };
export type { NodeWithAcl };

export const nameToAclModel: Record<NodeWithAcl, Model<any>> = {
  insurance: InsuranceAcl,
  clinic: ClinicAcl,
  doctor: DoctorAcl,
  pharmacy: PharmacyAcl,
  paraClinic: ParaClinicAcl,
  hospital: HospitalAcl,
};

export const nameToAclActions: Record<NodeWithAcl, readonly string[]> = {
  clinic: clinicActions,
  doctor: doctorActions,
  insurance: insuranceActions,
  pharmacy: pharmacyActions,
  paraClinic: paraClinicActions,
  hospital: hospitalActions,
} as const;

export const nameToModel: Record<NodeWithAcl, Model<any>> = {
  clinic: Clinic,
  doctor: DoctorProfile,
  insurance: Insurance,
  pharmacy: Pharmacy,
  paraClinic: ParaClinic,
  hospital: Hospital,
};

export const nameToModelName: Record<NodeWithAcl, SecretaryNodePath> =
  nodesWithAclToSecreataryAclPathDict;

export const nameToAclModelName: Record<NodeWithAcl, SecretaryAclPath> = {
  clinic: "ClinicAcl",
  doctor: "DoctorAcl",
  insurance: "InsuranceAcl",
  pharmacy: "PharmacyAcl",
  paraClinic: "ParaClinicAcl",
  hospital: "HospitalAcl",
};

export const getMyAcls: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const data = await nameToAclModel[name].find({
      $or: [{ owner: req[name]._id }, { owner: null }],
    });
    res.status(200).json({ message: "getMyAccessLevels", data });
  },
);

const mutateAccessLevelSchema = (actions: readonly string[]) =>
  z.strictObject({
    name: z.string().optional(),
    ...actions.reduce(
      (acc, action) => ({ ...acc, [action]: boolish.optional() }),
      {},
    ),
  });
export const createAcl: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const { data, success } = await mutateAccessLevelSchema(
      nameToAclActions[name],
    ).safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const created = await nameToAclModel[name].create({
      ...data,
      owner: req[name]._id,
    });
    // the id lets the invite flow create a role and use it in one go
    res.status(200).json({ message: "createAcl", data: { _id: created._id } });
  },
);

export const editAcl: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await mutateAccessLevelSchema(
      nameToAclActions[name],
    ).safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const node = await nameToAclModel[name].findOne({
      _id: nodeId,
      owner: req[name]._id,
    });
    if (!node) return next(new NotFoundError());
    await nameToAclModel[name].findByIdAndUpdate(node._id, data);
    res.status(200).json({ message: "editAcl" });
  },
);

export const deleteAcl: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const { nodeId } = req.params;
    const node = await nameToAclModel[name].findOne({
      _id: nodeId,
      owner: req[name]._id,
    });
    if (!node) return next(new NotFoundError());
    await nameToAclModel[name].findByIdAndDelete(node._id);
    res.status(200).json({ message: "deleteAcl" });
  },
);

export const useAcl: <T extends NodeWithAcl>(
  action?: (typeof nameToAclActions)[T][number] | true,
) => RequestHandler = (action) => {
  return catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (NODE_ENV === "development" && typeof action === "string") {
      if (!nameToAclActions[name].find((a) => a === action)) {
        console.log({ name, action, stupid: "You" });
        return next(new ServerError());
      }
    }
    if (!req.user) return next(new MiddlewareError());
    // a clinic / hospital panel names its centre (the switcher's header):
    // honoured only for a centre this account owns (Lib/activeCentre.ts)
    const pickedCentre = isMultiCentreKind(name) ? req.get(ACTIVE_CENTRE_HEADER) : undefined;
    const cookie = pickedCentre ? undefined : req.cookies[name];
    if (cookie) {
      const decoded = await extractDataFromCookie({
        cookie,
        name,
        res,
      });
      const fail = () => {
        res.clearCookie(name, cookieOptions);
        return next(new AccessError());
      };
      if (!decoded) return fail();
      const { id } = decoded;
      if (!isValidObjectId(id)) return fail();
      const node = await Secretary.findOne({
        _id: id,
        secretary: req.user._id,
      });
      if (!node) return fail();
      if (!node.owner) return fail();
      const profile = await nameToModel[name].findById({
        _id: node.owner._id,
      });
      if (!profile) return fail();
      if (action === true) return next(new AccessError());
      const acl = node.acl
        ? await nameToAclModel[name].findById({ _id: node.acl._id })
        : null;
      if (action) {
        if (!acl) return next(new AccessError());
        if (!acl[action]) return next(new AccessError());
      }
      req[name] = profile;
      req.aclGrant = acl ? (acl.toObject() as Record<string, unknown>) : null;
    } else if (isMultiCentreKind(name)) {
      // one account can own several clinics / hospitals: the active one
      const picked = await resolveOwnedCentre(name, req.user._id, {
        header: pickedCentre,
        cookie: req.cookies?.[activeCentreCookie[name]],
      });
      if (picked.denied || !picked.centre) return next(new AccessError());
      if (picked.stale) res.clearCookie(activeCentreCookie[name], cookieOptions);
      req[name] = picked.centre;
      req.aclGrant = "FULL";
    } else {
      const profile = await nameToModel[name].findOne({ user: req.user._id });
      if (!profile) return next(new AccessError());
      req[name] = profile;
      req.aclGrant = "FULL";
    }
    next();
  });
};

export const useDoctor = (action?: DoctorAction | true) => useAcl(action);

export const useClinic = (action?: ClinicAction | true) => useAcl(action);

export const useInsurance = (action?: InsuranceAction | true) => useAcl(action);

export const usePharmacy = (action?: PharmacyAction | true) => useAcl(action);

export const useParaClinic = (action?: ParaClinicAction | true) =>
  useAcl(action);

export const useHospital = (action?: HospitalAction | true) => useAcl(action);

export const getMySecretaryRequests: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const data = await SecretaryRequest.find({
      owner: req[name]._id,
    }).populate({ path: "acl" });
    res.status(200).json({ message: "getMySecretaryRequests", data });
  },
);

const submitSecretaryRequestSchema = z.strictObject({
  phone: phonish,
  displayName: z.string().optional(),
  acl: z.string().optional(),
  message: z.string().optional(),
});
export const submitASecretaryRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const { data, success, error } =
      await submitSecretaryRequestSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const user = await User.findOne({ _id: req[name].user?._id });
    if (!user) return next(new ServerError());
    if (user.phone === data.phone)
      return next(new AppError("نمیتوانید منشی خودتان باشید", 400));
    if (data.acl) {
      if (!isValidObjectId(data.acl)) return next(new BadInputError());
      const acl = await nameToAclModel[name].exists({
        _id: data.acl,
        $or: [{ owner: req[name]._id }, { owner: null }],
      });
      if (!acl) return next(new NotFoundError());
    }
    // only an open invite blocks a new one; a rejected or cancelled phone
    // can be invited again
    const dup = await SecretaryRequest.exists({
      phone: data.phone,
      owner: req[name]._id,
      status: "Pending",
    });
    if (dup) return next(new AppError("این درخواست قبلا ثبت شده", 400));
    const invited = await User.findOne({ phone: data.phone }).select("_id");
    if (invited) {
      const already = await Secretary.exists({
        owner: req[name]._id,
        ownerPath: nameToModelName[name],
        secretary: invited._id,
      });
      if (already) return next(new AppError("این شخص در حال حاضر منشی شماست", 400));
    }
    await SecretaryRequest.create({
      owner: req[name]._id,
      ownerPath: nameToModelName[name],
      aclPath: nameToAclModelName[name],
      ...data,
    });
    // SMS the invitee (works before they have an account; no-op while the
    // admin hasn't set SECRETARY_INVITE_PATTERN)
    const ownerDoc = req[name] as unknown as { firstName?: string; lastName?: string; name?: string };
    const ownerLabel =
      [ownerDoc.firstName, ownerDoc.lastName].filter(Boolean).join(" ") || ownerDoc.name || "";
    sendSMS(data.phone, { owner: ownerLabel }, "SECRETARY_INVITE_PATTERN").catch(() => undefined);
    // tell the invitee in-app if they already have an account (the invite
    // is matched to them by phone when they log in)
    if (invited)
      await Notification.create({
        user: invited._id,
        title: "دعوت به همکاری به‌عنوان منشی",
        message: data.displayName
          ? `برای همکاری با عنوان «${data.displayName}» دعوت شده‌اید. برای پذیرش به پنل منشی بروید.`
          : "برای همکاری به‌عنوان منشی دعوت شده‌اید. برای پذیرش به پنل منشی بروید.",
        link: "/secretarypanel",
      }).catch(() => undefined);
    res.status(200).json({ message: "submitASecretaryRequest" });
  },
);

const editSecretaryRequestSchema = z.strictObject({
  displayName: z.string().optional(),
  acl: nullish,
  message: z.string().optional(),
});
export const editSecretaryRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const { nodeId } = req.params;
    const { data, success } = await editSecretaryRequestSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await SecretaryRequest.findOne({
      _id: nodeId,
      owner: req[name]._id,
    });
    if (!node) return next(new NotFoundError());
    if (node.status !== "Pending")
      return next(new AppError("این درخواست در شرایط مناسبی قرار ندارد", 400));
    if (data.acl) {
      if (!isValidObjectId(data.acl)) return next(new BadInputError());
      const acl = await nameToAclModel[name].exists({
        _id: data.acl,
        $or: [{ owner: req[name]._id }, { owner: null }],
      });
      if (!acl) return next(new NotFoundError());
    }
    await SecretaryRequest.findByIdAndUpdate(node._id, data);
    res.status(200).json({ message: "editSecretaryRequest" });
  },
);

export const cancelSecretaryRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await SecretaryRequest.findOneAndDelete({
      _id: nodeId,
      owner: req[name]._id,
      status: "Pending",
    });
    if (!node) return next(new NotFoundError());
    res.status(200).json({ message: "cancelSecretaryRequest" });
  },
);

export const getMySecretaries: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const data = await Secretary.find({
      owner: req[name]._id,
      ownerPath: nameToModelName[name],
    }).populate([
      { path: "acl", select: "name" },
      { path: "secretary", select: "phone" },
    ]);
    res.status(200).json({ message: "getMySecretaries", data });
  },
);

const editSecretarySchema = z.strictObject({ acl: nullish });
export const editMySecretary: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const { data, success } = await editSecretarySchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    if (data.acl) {
      if (!isValidObjectId(data.acl)) return next(new BadInputError());
      const acl = await nameToAclModel[name].findOne({
        _id: data.acl,
        $or: [{ owner: req[name]._id }, { owner: null }],
      });
      if (!acl) return next(new NotFoundError());
    }
    const secretary = await Secretary.findOne({
      owner: req[name]._id,
      ownerPath: nameToModelName[name],
      _id: nodeId,
    });
    if (!secretary) return next(new NotFoundError());
    await Secretary.findByIdAndUpdate(secretary._id, {
      acl: data.acl,
    });
    res.status(200).json({ message: "editMySecretary" });
  },
);

export const deleteMySecretary: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name]) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    // removes the secretary from this owner's team (the Secretary link),
    // never an access level
    const secretary = await Secretary.findOne({
      owner: req[name]._id,
      ownerPath: nameToModelName[name],
      _id: nodeId,
    });
    if (!secretary) return next(new NotFoundError());
    await Secretary.findByIdAndDelete(secretary._id);
    res.status(200).json({ message: "deleteMySecretary" });
  },
);

export const getMyCurrentAcl: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const name = nodesWithAcl.find((n) => n === req.params.name);
    if (!name) return next(new PathNotFoundError());
    if (!req[name] || !req.user) return next(new MiddlewareError());
    if (req[name].user?._id.toString() === req.user._id.toString())
      return res
        .status(200)
        .json({ message: "getMyCurrentAcl", data: { access: "FULL" } });
    const acl = await Secretary.findOne({
      owner: req[name]._id,
      ownerPath: nameToModelName[name],
      secretary: req.user._id,
    });
    if (!acl || !acl.acl) return next(new AccessError());
    const access = await nameToAclModel[name].findById(acl.acl._id);
    if (!access) return next(new AccessError());
    res.status(200).json({ message: "getMyCurrentAcl", data: { access } });
  },
);

// For handlers behind useAcl() that return several sections: whether the
// current owner/secretary may see the part guarded by `action`.
export const aclAllows = (req: Request, action: string) =>
  req.aclGrant === "FULL" || !!req.aclGrant?.[action];
