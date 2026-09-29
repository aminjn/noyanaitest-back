import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import DoctorProfile from "../Models/DoctorProfile";
import AccessLevel, {
  accessLevelModels,
  accessOperations,
  IAccessLevel,
} from "../Models/AccessLevel";
import mongoose from "mongoose";
import AppError, {
  AccessError,
  BadInputError,
  BadTaminResponseError,
  MiddlewareError,
  MissingTaminTokenError,
  NotFoundError,
  TaminRideError,
} from "../Lib/AppError";
import UserAccessLevel from "../Models/UserAccessLevel";
import Clinic from "../Models/Clinic";
import Hospital from "../Models/Hospital";
import Insurance from "../Models/Insurance";
import Notification from "../Models/Notification";

import TaminServiceType from "../Models/TaminServiceType";
import TaminPrescriptionType from "../Models/TaminPrescriptionType";
import TaminService from "../Models/TaminService";
import TaminParTaref from "../Models/TaminParTaref";
import TaminDrugUsage from "../Models/TaminDrugUsage";
import TaminDrugInstruction from "../Models/TaminDrugInstruction";
import TaminDrugAmount from "../Models/TaminDrugAmount";
import TaminPhPlan from "../Models/TaminPhPlan";
import TaminPhIllness from "../Models/TaminPhIllness";
import DoctorTaminCred from "../Models/DoctorTaminCred";
import TaminIcid, { ITaminIcid } from "../Models/TaminIdid";
import TaminComplaint, { ITaminComplaint } from "../Models/TaminComplaint";
import * as z from "zod";
import { isValidObjectId } from "mongoose";
import Pharmacy from "../Models/Pharmacy";
import * as snappClient from "../Lib/snappClient";
import {
  dispatchDeliveryForPharmacy,
  refreshDeliveryForPharmacy,
} from "./pharmacyController";
import TaminSpec, { ITaminSpec } from "../Models/TaminSpec";

export const clearUserFromDoctorProfile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await DoctorProfile.findByIdAndUpdate(req.params.nodeId, {
      $unset: { user: 1 },
    });
    res.status(200).json({ message: "clearUserFromDoctorProfile" });
  },
);

export const clearUserFromClinic: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Clinic.findByIdAndUpdate(req.params.nodeId, { $unset: { user: 1 } });
    res.status(200).json({ message: "clearUserFromClinic" });
  },
);

export const clearUserFromHospital: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Hospital.findByIdAndUpdate(req.params.nodeId, {
      $unset: { user: 1 },
    });
    res.status(200).json({ message: "clearUserFromHospital" });
  },
);

export const clearUserFromInsurance: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Insurance.findByIdAndUpdate(req.params.nodeId, {
      $unset: { user: 1 },
    });
    res.status(200).json({ message: "clearUserFromInsurance" });
  },
);

export const createNotifications: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { users, title, message, link } = req.body || {};
    const recipients: unknown[] = (
      Array.isArray(users) ? users : [users]
    ).filter((id) => typeof id === "string" && isValidObjectId(id));
    if (!recipients.length)
      return next(new BadInputError("لطفا حداقل یک کاربر را انتخاب کنید"));
    if (
      typeof title !== "string" ||
      !title.trim() ||
      typeof message !== "string" ||
      !message.trim()
    )
      return next(new BadInputError());
    // only the message itself comes from the form: who sent it and that it
    // is an admin message are set here, never taken from the client
    const data = await Notification.insertMany(
      recipients.map((user) => ({
        user,
        title: title.trim(),
        message: message.trim(),
        ...(typeof link === "string" && link.startsWith("/") && { link }),
        source: "Admin",
        createdBy: req.user?._id,
      })),
    );
    res.status(200).json({ message: "createNotifications", data: { data } });
  },
);

const fullAccess: IAccessLevel = {
  _id: "" as unknown as mongoose.Types.ObjectId,
  name: "admin",
  ...accessLevelModels.reduce(
    (acc, model) => ({
      ...acc,
      [model]: accessOperations.reduce(
        (accc, op) => ({ ...accc, [op]: true }),
        {},
      ),
    }),
    {},
  ),
};

export const getMyAccessLevel: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    if (req.user.role === "admin")
      return res
        .status(200)
        .json({ message: "getMyAccessLevel", data: { data: fullAccess } });
    const accessLevel = await UserAccessLevel.findOne({ user: req.user._id });
    if (!accessLevel) return next(new AccessError());
    const access = await AccessLevel.findById(
      accessLevel.accessLevel?._id.toString(),
    );
    if (!access) return next(new AccessError());
    res
      .status(200)
      .json({ message: "getMyAccessLevel", data: { data: access } });
  },
);

export const refreshTaminServiceTypes: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-service-type";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data?.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      if (!data.data[i].srvType) continue;
      await TaminServiceType.findOneAndUpdate(
        {
          srvType: data.data[i].srvType,
        },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminServiceTypes" });
  },
);

export const refreshTaminPrescriptionTypes: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-prescription-type";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data?.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      if (!data.data[i].prescTypeCode) continue;
      await TaminPrescriptionType.findOneAndUpdate(
        { prescTypeCode: data.data[i].prescTypeCode },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminPrescriptionTypes" });
  },
);

export const refreshTaminServices: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const serviceTypes = await TaminServiceType.find();
    if (!serviceTypes.length)
      return next(new AppError("لطفا اول سرویس تایپ ها رو بگیرید", 400));
    for (let j = 0; j < serviceTypes.length; ++j) {
      console.log(`getting Shit For ${serviceTypes[j].srvTypeDes}`);
      const url = `https://ep-test.tamin.ir/api/v2/ws-services?serviceType=${serviceTypes[j].srvType}`;
      const response = await fetch(url);
      if (
        !response.ok ||
        !response.headers.get("Content-Type")?.includes("json")
      ) {
        console.log(`failed For ${serviceTypes[j].srvTypeDes}`);
        // return next(new TaminRideError());
        continue;
      }
      const data = await response.json();
      if (!Array.isArray(data?.data)) return next(new BadTaminResponseError());
      for (let i = 0; i < data.data.length; ++i) {
        if (!data.data[i].wsSrvCode) continue;
        const stripped = {
          ...data.data[i],
          srvType: data.data[i].srvType?.srvType,
          parTarefGrp: data.data[i].parTarefGrp?.parGrpCode,
        };
        await TaminService.findOneAndUpdate(
          {
            wsSrvCode: data.data[i].wsSrvCode,
          },
          stripped,
          { upsert: true },
        );
      }
    }
    res.status(200).json({ message: "refreshTaminServices" });
  },
);

export const refreshTaminParTarefs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-par-taref";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data?.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      await TaminParTaref.findOneAndUpdate(
        { parGrpCode: data.data[i].parGrpCode },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminParTarefs" });
  },
);

export const refreshTaminDrugUsages: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-drug-usage";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data?.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      await TaminDrugUsage.findOneAndUpdate(
        { drugUsageId: data.data[i].drugUsageId },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminDrugUsages" });
  },
);

export const refreshTaminDrugInstructions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-drug-instruction";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      await TaminDrugInstruction.findOneAndUpdate(
        { drugInstId: data.data[i].drugInstId },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminDrugInstructions" });
  },
);

export const refreshTaminDrugAmounts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-drug-amount";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      await TaminDrugAmount.findOneAndUpdate(
        {
          drugAmntId: data.data[i].drugAmntId,
        },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminDrugAmounts" });
  },
);

export const refreshTaminPhPlans: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-ph-plan";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data?.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      await TaminPhPlan.findOneAndUpdate(
        { planId: data.data[i].planId },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminPhPlans" });
  },
);

export const refreshTaminPhIllnesses: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/v2/ws-ph-illness";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("json"))
      return next(new TaminRideError());
    const data = await response.json();
    if (!Array.isArray(data?.data)) return next(new BadTaminResponseError());
    for (let i = 0; i < data.data.length; ++i) {
      await TaminPhIllness.findOneAndUpdate(
        { illnessId: data.data[i].illnessId },
        { ...data.data[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminPhIllnesses" });
  },
);

export const refreshTaminIcids: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const url = "https://ep-test.tamin.ir/api/icd10/getAll";
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${cred.token}`,
      },
    });
    const data = await response.json();
    const list = data.data.list as ITaminIcid[];
    for (let i = 0; i < list.length; ++i) {
      await TaminIcid.findOneAndUpdate(
        { icdId: list[i].icdId },
        { ...list[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminIcids", data });
  },
);

export const refreshTaminComplaints: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const cred = await DoctorTaminCred.findOne();
    if (!cred?.token) return next(new MissingTaminTokenError());
    const url = "https://ep-test.tamin.ir/api/complaint";
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${cred.token}`,
      },
    });
    const data = await response.json();
    const list = data.data.list.map((el: any) => ({
      ...el,
      taminId: el.id,
      id: undefined,
    })) as ITaminComplaint[];
    for (let i = 0; i < list.length; ++i) {
      await TaminComplaint.findOneAndUpdate(
        { taminId: list[i].taminId },
        { ...list[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminComplaints", data });
  },
);

export const refreshTaminSpecs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const url = "https://ep-test.tamin.ir/api/specials";
    const response = await fetch(url);
    const data = await response.json();
    const list = data.data as ITaminSpec[];
    for (let i = 0; i < list.length; ++i) {
      await TaminSpec.findOneAndUpdate(
        { specCode: list[i].specCode },
        { ...list[i] },
        { upsert: true },
      );
    }
    res.status(200).json({ message: "refreshTaminSpecs", data });
  },
);

// ---- Snapp integration test page (2026-09) ----
// Admin-only endpoints backing a manual test page for Lib/snappClient.ts -
// see Routers/adminRouter.ts's /snapp/* routes. Not part of any real
// business flow; exists purely so the integration can be exercised by hand
// since this environment can't reach Snapp's actual API to test it live.

// Raw console: calls one Lib/snappClient.ts method directly with whatever
// payload the admin provides, and returns Snapp's response (or throws
// whatever error the client/Snapp itself raised) as-is. No business rules
// applied here - this deliberately bypasses dispatchDeliveryForPharmacy's
// order/pharmacy scoping so any endpoint can be poked directly.
const snappTestActions = [
  "balance",
  "price",
  "requestRide",
  "activeRides",
  "refreshRide",
  "rideStatus",
  "cancelRide",
  "rideHistory",
  "financialHistory",
  "payment",
] as const;

const snappTestSchema = z.strictObject({
  action: z.enum(snappTestActions),
  payload: z.record(z.string(), z.any()).optional(),
});

export const snappTest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success, error } = await snappTestSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError(error.message));
    const payload = data.payload || {};

    const result = await (async () => {
      switch (data.action) {
        case "balance":
          return snappClient.getBalance();
        case "price":
          return snappClient.getRidePrice(payload as any);
        case "requestRide":
          return snappClient.requestRide(payload as any);
        case "activeRides":
          return snappClient.getActiveRides();
        case "refreshRide":
          return snappClient.refreshRide(payload.hri);
        case "rideStatus":
          return snappClient.getRideStatus(payload.hri);
        case "cancelRide":
          return snappClient.cancelRide(payload.hri);
        case "rideHistory":
          return snappClient.getRideHistory(payload as any);
        case "financialHistory":
          return snappClient.getFinancialHistory(payload as any);
        case "payment":
          return snappClient.createPayment(payload.amount);
      }
    })();

    res.status(200).json({ message: "snappTest", data: result });
  },
);

// Exercises the real dispatchOrderDelivery logic against any pharmacy/order
// pair, without needing to log in as that pharmacy (dispatchDeliveryForPharmacy
// is the exact function pharmacyController.dispatchOrderDelivery calls).
const adminDispatchDeliverySchema = z.strictObject({
  pharmacyId: z.string(),
  orderId: z.string(),
});

export const adminDispatchDelivery: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = await adminDispatchDeliverySchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError());
    if (!isValidObjectId(data.pharmacyId)) return next(new BadInputError());
    const pharmacy = await Pharmacy.findById(data.pharmacyId);
    if (!pharmacy) return next(new NotFoundError("داروخانه"));

    const result = await dispatchDeliveryForPharmacy(pharmacy, data.orderId);
    res.status(200).json({ message: "adminDispatchDelivery", data: result });
  },
);

export const adminGetDeliveryStatus: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { pharmacyId, orderId } = req.query;
    if (typeof pharmacyId !== "string" || typeof orderId !== "string")
      return next(new BadInputError());
    if (!isValidObjectId(pharmacyId)) return next(new BadInputError());
    const pharmacy = await Pharmacy.findById(pharmacyId);
    if (!pharmacy) return next(new NotFoundError("داروخانه"));

    const result = await refreshDeliveryForPharmacy(pharmacy, orderId);
    res.status(200).json({ message: "adminGetDeliveryStatus", data: result });
  },
);
