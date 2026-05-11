import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  BadTaminResponseError,
  MiddlewareError,
  MissingTaminTokenError,
  NotFoundError,
  ServerError,
} from "../Lib/AppError";
import Prescription2, {
  IPrescription2,
} from "../Models/Prescription/Prescription2";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import PrescriptionItem, {
  IPrescriptionItem,
} from "../Models/Prescription/PrescriptionItem";
import TaminService from "../Models/TaminService";
import { boolish, datish } from "../Lib/helpers";
import TaminDrugAmount from "../Models/TaminDrugAmount";
import TaminDrugInstruction from "../Models/TaminDrugInstruction";
import UserIdentity from "../Models/UserIdentity";
import Prescription from "../Models/Prescription";
import makeTaminRequest from "../Lib/MakeTamjinRequest";
import moment from "moment-jalaali";
import DoctorTaminCred from "../Models/DoctorTaminCred";
import TaminServiceType, {
  ITaminServiceType,
} from "../Models/TaminServiceType";
import { TaminResponse } from "./doctorController";
import TaminPrescription2, {
  ITaminPrescription2,
} from "../Models/Prescription/TaminPrescription2";
import TaminPrescriptionType, {
  ITaminPrescriptionType,
} from "../Models/TaminPrescriptionType";
import VisitPrescription from "../Models/VisitPrescription";
import TaminSpec from "../Models/TaminSpec";
import TaminComplaint from "../Models/TaminComplaint";
import TaminIcid from "../Models/TaminIdid";
import ReferralPrescription from "../Models/ReferralPrescription";

export const getPrescriptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await Prescription2.find({ author: req.doctor._id }).populate([
      {
        path: "patient",
      },
      { path: "taminPrescriptions", populate: { path: "prescType" } },
    ]);
    res.status(200).json({ message: "getPrescriptions", data });
  },
);

export const getPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await Prescription2.findOne({
      author: req.doctor._id,
      _id: nodeId,
    }).populate([
      { path: "patient" },
      {
        path: "items",
        populate: [
          { path: "service" },
          { path: "timesADay" },
          { path: "drugInstruction" },
        ],
      },
      {
        path: "taminPrescriptions",
        populate: [{ path: "prescType" }, { path: "serviceType" }],
      },
    ]);
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getPrescription", data });
  },
);

const createPrescriptionSchema = z.strictObject({
  patient: z.string(),
  items: z
    .array(
      z.strictObject({
        item: z.string().length(24),
        qty: z.preprocess(
          (val: unknown) =>
            typeof val === "string" && !isNaN(Number(val)) ? Number(val) : val,
          z.number().int().min(1),
        ),
        timesADay: z.string().length(24).optional(),
        instruction: z.string().length(24).optional(),
        dose: z.string().optional(),
        dateDo: z
          .preprocess(
            (val: unknown) => (typeof val === "string" ? new Date(val) : val),
            z.date(),
          )
          .optional(),
        isDentalService: boolish.optional(),
        toothId: z.string().optional(),
        illnessId: z.string().optional(),
        planId: z.string().optional(),
      }),
    )
    .nonempty(),
});

type ValidatedItems = Omit<IPrescriptionItem, "_id" | "prescription">[];
const validateCreatePrescriptionInput = async ({
  items,
}: {
  items: z.infer<typeof createPrescriptionSchema>["items"];
}): Promise<
  | {
      success: true;
      items: ValidatedItems;
      error?: never;
    }
  | { success: false; error: AppError; items?: never }
> => {
  const clone: ValidatedItems = [];
  for (let i = 0; i < items.length; ++i) {
    const item = items[i];
    const service = await TaminService.findById(item.item);
    if (!service) return { success: false, error: new NotFoundError("سرویس") };
    if (Number(service.srvType) === 1) {
      const timesADay = await TaminDrugAmount.findById(item.timesADay);
      const instruction = await TaminDrugInstruction.findById(item.instruction);
      if (!timesADay || !instruction) {
        return { success: false, error: new BadInputError() };
      }
      clone.push({
        service: service,
        qty: item.qty,
        timesADay: timesADay,
        drugInstruction: instruction,
        dose: item.dose,
      });
      continue;
    } else {
      if (item.timesADay || item.instruction) {
        return { success: false, error: new BadInputError() };
      }
    }
    clone.push({ service: service, qty: item.qty, dateDo: item.dateDo });
  }
  if (!clone.length)
    return {
      success: false,
      error: new AppError("لطفا حداقل یک ردیف وارد کنید", 400),
    };
  return { success: true, items: clone };
};

export const createPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success, error } =
      await createPrescriptionSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const patient = await UserIdentity.findById(data.patient);
    if (!patient) return next(new NotFoundError("بیمار"));
    const {
      success: validated,
      items,
      error: validationError,
    } = await validateCreatePrescriptionInput({
      items: data.items,
    });
    if (!validated) return next(validationError);
    const prescription = await Prescription2.create({
      author: req.doctor._id,
      patient: patient._id,
    });
    for (let i = 0; i < items.length; ++i) {
      const item = items[i];
      await PrescriptionItem.create({
        prescription: prescription._id,
        service: item.service._id,
        drugInstruction: item.drugInstruction?._id,
        timesADay: item.timesADay?._id,
        dose: item.dose,
        dateDo: item.dateDo,
        qty: item.qty,
      });
    }
    res.status(200).json({ message: "createPrescription", data: prescription });
  },
);

export const editPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const prescription = await Prescription2.findOne({
      author: req.doctor._id,
      _id: nodeId,
    });
    if (!prescription) return next(new NotFoundError());
    const committed = await TaminPrescription2.exists({
      prescription: prescription._id,
    });
    if (committed)
      return next(new AppError("برای اصلاح از منوی مربوطه اقدام نمایید", 400));
    const { data, success } = await createPrescriptionSchema
      .pick({
        items: true,
      })
      .safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    console.log(data.items);
    const {
      success: validated,
      error,
      items,
    } = await validateCreatePrescriptionInput({
      items: data.items,
    });
    if (!validated) return next(error);
    await PrescriptionItem.deleteMany({ prescription: prescription._id });
    for (let i = 0; i < items.length; ++i) {
      const item = items[i];
      await PrescriptionItem.create({
        prescription: prescription._id,
        service: item.service._id,
        drugInstruction: item.drugInstruction?._id,
        timesADay: item.timesADay?._id,
        dose: item.dose,
        dateDo: item.dateDo,
        qty: item.qty,
      });
    }
    res.status(200).json({ message: "editPrescription" });
  },
);

export const deletePrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await Prescription2.findOne({
      author: req.doctor._id,
      _id: nodeId,
    }).populate({ path: "taminPrescriptions" });
    if (!node) return next(new NotFoundError());
    if (!!node.taminPrescriptions?.length)
      return next(
        new AppError(
          "این نسخه در تامین ثبت شده برای حذف از منوی مربوطه استفاده کنید",
          400,
        ),
      );
    await Prescription2.findByIdAndDelete(node._id);
    await PrescriptionItem.deleteMany({ prescription: node._id });
    res.status(200).json({ message: "deletePrescription" });
  },
);

const makeTaminItemsList = (items: ValidatedItems) => {
  const result: Record<string, unknown>[] = [];
  for (let i = 0; i < items.length; ++i) {
    const item = items[i];
    const element: Record<string, any> = {};
    element.srvId = {
      srvType: { srvType: item.service.srvType },
      srvCode: item.service.wsSrvCode,
    };
    if (item.service.parTarefGrp)
      element.srvId.parTarefGrp = { parGrpCode: item.service.parTarefGrp };
    element.srvQty = item.qty;
    if (item.timesADay)
      element.timesAday = { drugAmntId: Number(item.timesADay.drugAmntId) };
    if (item.drugInstruction)
      element.drugInstruction = {
        drugInstId: Number(item.drugInstruction.drugInstId),
      };
    if (Number(item.service.srvType) === 1) element.dose = item.dose;
    if (item.dateDo)
      element.dateDo = moment(new Date(item.dateDo)).format("jYYYYjMMjDD");
    result.push(element);
  }
  return result;
};

export const commitPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const prescription = await Prescription2.findOne({
      _id: nodeId,
      author: req.doctor._id,
    }).populate([
      { path: "patient" },
      {
        path: "items",
        populate: [
          { path: "service" },
          { path: "timesADay" },
          { path: "drugInstruction" },
        ],
      },
    ]);
    if (!prescription) return next(new NotFoundError());
    if (!prescription.items?.length)
      return next(new AppError("این نسخه خالی میباشد", 400));
    const committed = await TaminPrescription2.exists({
      prescription: prescription._id,
    });
    if (committed)
      return next(new AppError("این نسخه قبلا در تامین ثبت شده", 400));
    const cred = await DoctorTaminCred.findOneAndUpdate(
      { doctor: req.doctor._id },
      { doctor: req.doctor._id },
      { upsert: true, new: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());
    const grouped: Record<string, IPrescriptionItem[]> = {};
    for (let i = 0; i < prescription.items.length; ++i) {
      const item = prescription.items[i];
      grouped[item.service.srvType || ""] = [
        ...(grouped[item.service.srvType || ""] || []),
        item,
      ];
    }
    let failed: AppError | null = null;
    for (const srvType in grouped) {
      const serviceType = await TaminServiceType.findOne({
        srvType: Number(srvType),
      });
      if (!serviceType) return next(new ServerError());
      const prescType = await TaminPrescriptionType.findOne({
        prescTypeId: Number(serviceType.prescTypeId),
      });
      if (!prescType) {
        failed = new ServerError();
        continue;
      }
      const response = await makeTaminRequest({
        path: "https://ep-test.tamin.ir/api/v2/SendEpresc",
        method: "POST",
        token: cred.token,
        payload: {
          patient: "1234567891",
          mobile: "09129999999",
          prescType: { prescTypeId: Number(prescType.prescTypeId) },
          prescDate: moment(new Date()).format("jYYYYjMMjDD"),
          docId: "2000200092",
          docMobileNo: "09991111111",
          docNationalCode: "1234567891",
          comments: "",
          expireDate: "14030102",
          clientId: "1234567891",
          noteDetailEprscs: makeTaminItemsList(grouped[srvType]),
        },
      });
      if (!response.headers.get("content-type")?.includes("json")) {
        failed = new BadTaminResponseError();
        continue;
      }
      const data = (await response.json()) as TaminResponse;
      console.log(data);
      if (data.data?.result?.error_Code) {
        if (
          data.data?.result?.error_Code === "304" &&
          !!data.data.result.error_Msg
        ) {
          const taminId =
            data.data.result.error_Msg.match(/شناسه.*?(\d+)/)?.[1];
          const tracking =
            data.data.result.error_Msg.match(/کد رهگیری\s*(\d+)/)?.[1];
          console.log({ taminId, tracking });
          if (!taminId || !tracking) return next(new BadTaminResponseError());
          const dup = await TaminPrescription2.exists({
            taminId,
            tracking,
          });
          if (dup) {
            failed = new AppError(`نسخه تکراری است کد رهگیری ${tracking}`, 400);
            continue;
          }
          await TaminPrescription2.findOneAndUpdate(
            {
              prescription: prescription._id,
              prescType: prescType._id,
              serviceType: serviceType._id,
            },
            {
              prescription: prescription._id,
              tracking,
              taminId,
              prescType: prescType._id,
              serviceType: serviceType._id,
            },
            { upsert: true },
          );
        } else {
          failed = new AppError(
            `درخواست تامین ناموفق بود: ${
              data.data.result.error_Msg || "نامعلوم"
            }`,
            400,
          );
          continue;
        }
      } else {
        if (
          !data.data?.result?.head_EPRSC_ID ||
          !data.data.result.trackingCode
        ) {
          failed = new BadTaminResponseError();
          continue;
        }
        await TaminPrescription2.findOneAndUpdate(
          {
            prescription: prescription._id,
            prescType: prescType._id,
            serviceType: serviceType._id,
          },
          {
            prescription: prescription._id,
            taminId: data.data.result.head_EPRSC_ID,
            tracking: data.data.result.trackingCode,
            prescType: prescType._id,
            serviceType: serviceType._id,
          },
          { upsert: true },
        );
      }
    }
    if (!!failed) return next(failed);
    res.status(200).json({ message: "commitPrescription" });
  },
);

const editTaminPrescriptionItemsCleanUp = async ({
  existingItems,
  incomingItems,
  prescription,
}: {
  existingItems: IPrescriptionItem[];
  incomingItems: ValidatedItems;
  prescription: IPrescription2;
}) => {
  const toDelete = existingItems.filter(
    (el) =>
      !incomingItems.find(
        (e) => e.service._id.toString() === el.service._id.toString(),
      ),
  );
  for (let c = 0; c < toDelete.length; c++) {
    await Prescription.findByIdAndDelete(toDelete[c]._id);
  }
  for (let k = 0; k < incomingItems.length; k++) {
    await PrescriptionItem.findOneAndUpdate(
      {
        prescription: prescription._id,
        service: incomingItems[k].service,
      },
      {
        prescription: prescription._id,
        service: incomingItems[k].service._id,
        qty: incomingItems[k].qty,
        timesADay: incomingItems[k].timesADay?._id,
        dose: incomingItems[k].dose,
        repeat: incomingItems[k].repeat,
        dateDo: incomingItems[k].dateDo,
        drugInstruction: incomingItems[k].drugInstruction,
      },
      { upsert: true },
    );
  }
};

export const editTaminPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const prescription = await Prescription2.findOne({
      _id: nodeId,
      author: req.doctor._id,
    }).populate([
      { path: "patient" },
      { path: "items", populate: { path: "service" } },
      { path: "taminPrescriptions" },
    ]);
    if (!prescription?.taminPrescriptions?.length)
      return next(
        new AppError(
          "این نسخه قبلا در تامین ثبت نشده برای اصلاح از منوی مربوطه اقدام نمایید",
          400,
        ),
      );
    if (!prescription.items?.length)
      return next(new AppError("این نسخه خالی میباشد", 400));
    const { data, success } = await createPrescriptionSchema
      .pick({ items: true })
      .safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    const {
      success: validated,
      error: validationError,
      items,
    } = await validateCreatePrescriptionInput({ items: data.items });
    if (!validated) return next(validationError);
    const cred = await DoctorTaminCred.findOneAndUpdate(
      { doctor: req.doctor._id },
      { doctor: req.doctor._id },
      { upsert: true, new: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());
    type Grouped = {
      serviceType: ITaminServiceType;
      items: ValidatedItems;
    }[];
    const serviceTypes = await TaminServiceType.find();
    let groupingError: AppError | undefined;
    const grouped: Grouped = items.reduce((acc, el) => {
      const clone = [...acc];
      const index = acc.findIndex(
        (group) =>
          Number(group.serviceType.srvType) === Number(el.service.srvType),
      );
      if (index === -1) {
        const srvType = serviceTypes.find(
          (s) => Number(s.srvType) === Number(el.service.srvType),
        );
        if (!srvType) {
          groupingError = new ServerError();
          return acc;
        }
        clone.push({ serviceType: srvType, items: [el] });
      } else {
        clone[index] = { ...clone[index], items: [...clone[index].items, el] };
      }
      return clone;
    }, [] as Grouped);
    if (!!groupingError) return next(groupingError);
    let foundAnyChange = false;
    const failed: AppError[] = [];
    const previousTaminPrescriptions = await TaminPrescription2.find({
      prescription: prescription._id,
    }).populate({ path: "serviceType" });
    const editedTaminPrescriptions: ITaminPrescription2[] = [];
    for (let i = 0; i < grouped.length; ++i) {
      const existingItems = prescription.items?.filter(
        (el) =>
          Number(el.service.srvType) === Number(grouped[i].serviceType.srvType),
      );
      let changed = grouped[i].items.length !== existingItems.length;
      if (!changed) continue;
      for (let j = 0; j < existingItems.length; ++j) {
        const found = grouped[i].items.find(
          (service) =>
            service.service._id.toString() ===
            existingItems[j].service._id.toString(),
        );
        if (!found) {
          changed = true;
          break;
        }
        if (
          found.timesADay?._id.toString() !==
          existingItems[j].timesADay?._id.toString()
        ) {
          changed = true;
          break;
        }
        if (
          found.drugInstruction?._id.toString() !==
          existingItems[j].drugInstruction?._id.toString()
        ) {
          changed = true;
          break;
        }
        if (found.qty !== existingItems[j].qty) {
          changed = true;
          break;
        }
        if (found.dose !== existingItems[j].dose) {
          changed = true;
          break;
        }
      }
      if (!changed) continue;
      foundAnyChange = true;
      const taminPresc = await TaminPrescription2.findOne({
        prescription: prescription._id,
        serviceType: grouped[i].serviceType._id,
      });
      if (!taminPresc) {
        const prescType = await TaminPrescriptionType.findOne({
          prescTypeId: Number(grouped[i].serviceType.prescTypeId),
        });
        if (!prescType) return next(new ServerError());
        const response = await makeTaminRequest({
          path: "https://ep-test.tamin.ir/api/v2/SendEpresc",
          method: "POST",
          token: cred.token,
          payload: {
            patient: "1234567891",
            mobile: "09129999999",
            prescType: { prescTypeId: Number(prescType.prescTypeId) },
            prescDate: moment(new Date()).format("jYYYYjMMjDD"),
            docId: "2000200092",
            docMobileNo: "09991111111",
            docNationalCode: "1234567891",
            comments: "",
            expireDate: "14030102",
            clientId: "1234567891",
            noteDetailEprscs: makeTaminItemsList(grouped[i].items),
          },
        });
        if (!response.headers.get("content-type")?.includes("json")) {
          failed.push(new BadTaminResponseError());
          continue;
        }
        const data = (await response.json()) as TaminResponse;
        if (data.data?.result?.error_Code) {
          if (
            data.data?.result?.error_Code === "304" &&
            !!data.data.result.error_Msg
          ) {
            const taminId =
              data.data.result.error_Msg.match(/شناسه.*?(\d+)/)?.[1];
            const tracking =
              data.data.result.error_Msg.match(/کد رهگیری\s*(\d+)/)?.[1];
            console.log({ taminId, tracking });
            if (!taminId || !tracking) return next(new BadTaminResponseError());
            const dup = await TaminPrescription2.exists({
              taminId,
              tracking,
            });
            if (dup) {
              failed.push(
                new AppError(`نسخه تکراری است کد رهگیری ${tracking}`, 400),
              );
              continue;
            }
          } else {
            failed.push(
              new AppError(
                `درخواست تامین ناموفق بود: ${
                  data.data.result.error_Msg || "نامعلوم"
                }`,
                400,
              ),
            );
            continue;
          }
        } else {
          if (
            !data.data?.result?.head_EPRSC_ID ||
            !data.data.result.trackingCode
          ) {
            failed.push(new BadTaminResponseError());
            continue;
          }
        }
        const edited = await TaminPrescription2.findOneAndUpdate(
          {
            prescription: prescription._id,
            prescType: prescType._id,
            serviceType: grouped[i].serviceType._id,
          },
          {
            prescription: prescription._id,
            taminId: data.data.result.head_EPRSC_ID,
            tracking: data.data.result.trackingCode,
            prescType: prescType._id,
            serviceType: grouped[i].serviceType._id,
          },
          { upsert: true, new: true },
        );
        editedTaminPrescriptions.push(edited);
      } else {
        editedTaminPrescriptions.push(taminPresc);
        const response = await makeTaminRequest({
          path: `https://ep-test.tamin.ir/api/v2/ep/update/${taminPresc.taminId}/1234567891/2000200092`,
          method: "POST",
          token: cred.token,
          payload: makeTaminItemsList(grouped[i].items),
        });
        if (!response.headers.get("content-type")?.includes("json")) {
          console.log(await response.text());
          failed.push(new BadTaminResponseError());
          continue;
        }
        const responseData = await response.json();
        console.log(responseData);
        if (responseData.data.statusCode !== "200") {
          failed.push(new BadTaminResponseError());
          continue;
        }
      }
      await editTaminPrescriptionItemsCleanUp({
        prescription: prescription,
        existingItems,
        incomingItems: grouped[i].items,
      });
    }
    const toDeleteItems = prescription.items.filter(
      (el) =>
        !grouped.find(
          (g) => Number(g.serviceType.srvType) === Number(el.service.srvType),
        ),
    );
    if (toDeleteItems.length) foundAnyChange = true;
    const deletingServiceTypes = serviceTypes.filter((st) =>
      toDeleteItems.find(
        (el) => Number(el.service.srvType) === Number(st.srvType),
      ),
    );
    const toDelete = await TaminPrescription2.find({
      prescription: prescription._id,
      serviceType: deletingServiceTypes.map((el) => el._id),
    });
    console.log({ toDelete });
    for (let d = 0; d < toDelete.length; d++) {
      const response = await makeTaminRequest({
        path: `https://ep-test.tamin.ir/api/v2/ep/${toDelete[d].taminId}/1234567891/2000200092`,
        method: "POST",
        token: cred.token,
      });
      if (!response.headers.get("content-type")?.includes("json")) {
        console.log(await response.text());
        failed.push(new BadTaminResponseError());
        continue;
      }
      const data = await response.json();
      if (data.status !== 200) {
        failed.push(new AppError("عملیات با خطا مواجه شد", 400));
        continue;
      }
      await TaminPrescription2.findByIdAndDelete(toDelete[d]._id);
    }
    for (let y = 0; y < toDeleteItems.length; ++y) {
      await PrescriptionItem.findByIdAndDelete(toDeleteItems[y]._id);
    }
    if (!foundAnyChange) return next(new AppError("تغییری مشاهده نشد", 400));
    res.status(200).json({
      message: "editTaminPrescription",
      errors: failed.map((el) => el.message),
    });
  },
);

export const deleteTaminPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await Prescription2.findOne({
      _id: nodeId,
      author: req.doctor._id,
    }).populate({ path: "taminPrescriptions" });
    if (!node) return next(new NotFoundError());
    if (!node.taminPrescriptions?.length)
      return next(
        new AppError(
          "ین نسخه در تامین ثبت نشده لطفا از منوی مربوطه برای حذف استفاده کنید",
          400,
        ),
      );
    const cred = await DoctorTaminCred.findOneAndUpdate(
      { doctor: req.doctor._id },
      { doctor: req.doctor._id },
      { upsert: true, new: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());
    for (let i = 0; i < node.taminPrescriptions.length; ++i) {
      const response = await makeTaminRequest({
        path: `https://ep-test.tamin.ir/api/v2/ep/${node.taminPrescriptions[i].taminId}/1234567891/2000200092`,
        method: "POST",
        token: cred.token,
      });
      if (!response.headers.get("content-type")?.includes("json")) {
        console.log(await response.text());
        return next(new BadTaminResponseError());
      }
      const data = await response.json();
      if (data.status !== 200) {
        return next(new AppError("عملیات با خطا مواجه شد", 400));
      }
      await TaminPrescription2.findByIdAndDelete(
        node.taminPrescriptions[i]._id,
      );
    }
    await PrescriptionItem.deleteMany({ prescription: node._id });
    await Prescription2.findByIdAndDelete(node._id);
    res.status(200).json({ message: "deleteTaminPrescription" });
  },
);

export const getVisitPrescriptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await VisitPrescription.find({
      author: req.doctor._id,
    }).populate({ path: "patient" });
    res.status(200).json({ message: "getVisitPrescriptions", data });
  },
);

export const newVisitPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { patient } = req.body;
    if (!isValidObjectId(patient)) return next(new BadInputError());
    const p = await UserIdentity.findById(patient);
    if (!p) return next(new NotFoundError());
    const cred = await DoctorTaminCred.findOneAndUpdate(
      { doctor: req.doctor._id },
      { doctor: req.doctor._id },
      { upsert: true, new: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: "https://ep-test.tamin.ir/api/v2/SendEpresc",
      method: "POST",
      token: cred.token,
      payload: {
        patient: "1234567891",
        mobile: "09129999999",
        prescType: { prescTypeId: 3 },
        prescDate: moment(new Date()).format("jYYYYjMMjDD"),
        docId: "2000200092",
        docMobileNo: "09991111111",
        docNationalCode: "1234567891",
        comments: "",
        expireDate: "14030102",
        clientId: "1234567891",
        noteDetailEprscs: [],
      },
    });
    if (!response.headers.get("content-type")?.includes("json")) {
      return next(new BadTaminResponseError());
    }
    const data = (await response.json()) as TaminResponse;
    console.log(data);
    if (data.data?.result?.error_Code) {
      if (
        data.data?.result?.error_Code === "304" &&
        !!data.data.result.error_Msg
      ) {
        const taminId = data.data.result.error_Msg.match(/شناسه.*?(\d+)/)?.[1];
        const tracking =
          data.data.result.error_Msg.match(/کد رهگیری\s*(\d+)/)?.[1];
        console.log({ taminId, tracking });
        if (!taminId || !tracking) return next(new BadTaminResponseError());
        const dup = await TaminPrescription2.exists({
          taminId,
          tracking,
        });
        if (dup) {
          return next(
            new AppError(`نسخه تکراری است کد رهگیری ${tracking}`, 400),
          );
        }
        await VisitPrescription.create({
          patient: p._id,
          author: req.doctor._id,
          taminId,
          tracking,
        });
      } else {
        return next(
          new AppError(
            `درخواست تامین ناموفق بود: ${
              data.data.result.error_Msg || "نامعلوم"
            }`,
            400,
          ),
        );
      }
    } else {
      if (!data.data?.result?.head_EPRSC_ID || !data.data.result.trackingCode) {
        return next(new BadTaminResponseError());
      }
      await VisitPrescription.create({
        patient: p._id,
        taminId: data.data.result.head_EPRSC_ID,
        tracking: data.data.result.trackingCode,
        author: req.doctor._id,
      });
    }
    res.status(200).json({ message: "newVisitPrescription" });
  },
);

export const deleteVisitPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await VisitPrescription.findOne({
      author: req.doctor._id,
      _id: nodeId,
    });
    if (!node) return next(new NotFoundError());
    const cred = await DoctorTaminCred.findOneAndUpdate(
      { doctor: req.doctor._id },
      { doctor: req.doctor._id },
      { upsert: true, new: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());
    const response = await makeTaminRequest({
      path: `https://ep-test.tamin.ir/api/v2/ep/${node.taminId}/1234567891/2000200092`,
      method: "POST",
      token: cred.token,
    });
    if (!response.headers.get("content-type")?.includes("json")) {
      console.log(await response.text());
      return next(new BadTaminResponseError());
    }
    const data = await response.json();
    if (data.status !== 200) {
      return next(new AppError("عملیات با خطا مواجه شد", 400));
    }
    await VisitPrescription.findByIdAndDelete(node._id);
    res.status(200).json({ message: "deleteVisitPrescription" });
  },
);

export const getReferralBaseData: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const specs = await TaminSpec.find();
    const complaints = await TaminComplaint.find();
    const icds = await TaminIcid.find();
    res
      .status(200)
      .json({ message: "getTaminSpecs", data: { specs, complaints, icds } });
  },
);

const submitReferralPrescriptionSchema = z.strictObject({
  spec: z.string(),
  complaints: z.array(z.string()).nonempty(),
  icds: z.array(z.string()).nonempty(),
  patient: z.string(),
  description: z.string().optional(),
  quantity: z.number().int().min(1),
  referralDate: datish,
});

export const submitReferralPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success, error } =
      await submitReferralPrescriptionSchema.safeParseAsync(req.body);
    console.log(error);
    if (!success) return next(new BadInputError());
    if (
      !isValidObjectId(data.patient) ||
      !isValidObjectId(data.spec) ||
      !!data.complaints.some((el) => !isValidObjectId(el)) ||
      !!data.icds.some((el) => !isValidObjectId(el))
    )
      return next(new BadInputError());
    const spec = await TaminSpec.findById(data.spec);
    if (!spec) return next(new NotFoundError());
    const patient = await UserIdentity.findById(data.patient);
    if (!patient) return next(new NotFoundError());
    const complaints = await TaminComplaint.find({ _id: data.complaints });
    if (complaints.length !== data.complaints.length)
      return next(new NotFoundError());
    const icds = await TaminIcid.find({ _id: data.icds });
    if (icds.length !== data.icds.length) return next(new NotFoundError());
    const cred = await DoctorTaminCred.findOneAndUpdate(
      { doctor: req.doctor._id },
      { doctor: req.doctor._id },
      { upsert: true, new: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());

    console.log([
      {
        docSpecReferred: { specCode: spec.specCode },
        icd10s: icds.map((el) => ({ icdId: el.icdCode })),
        complaints: complaints.map((el) => ({ id: `${el.code}` })),
        message: data.description,
        quantity: data.quantity,
        referralHijriDate: moment(new Date(data.referralDate)).format(
          "jYYYYjMMjDD",
        ),
      },
    ]);
    console.log(icds.map((el) => ({ icdId: el.icdCode })));
    console.log(complaints.map((el) => ({ id: el.code })));
    const response = await makeTaminRequest({
      path: "https://ep-test.tamin.ir/api/v2/SendEpresc",
      method: "POST",
      token: cred.token,
      payload: {
        patient: "0018243460",
        mobile: "09129999999",
        prescType: {
          prescTypeId: 7,
        },
        prescDate: "14050201",
        docId: "2000200092",
        docMobileNo: "09991111111",
        docNationalCode: "1234567891",
        comments: "",
        expireDate: "14030719",
        clientId: "1234567891",
        noteDetailEprscs: [],
        noteDetailsReferralList: [
          {
            docSpecReferred: {
              specCode: spec.specCode,
            },
            icd10s: icds.map((el) => ({ icdId: el.icdCode })),
            complaints: complaints.map((el) => ({ id: `${el.code}` })),
            message: data.description || "",
            referralHijriDate: moment(new Date(data.referralDate)).format(
              "jYYYYjMMjDD",
            ),
            quantity: data.quantity,
          },
        ],
      },
      // payload: {
      //   patient: "1234567891",
      //   mobile: "09129999999",
      //   prescType: { prescTypeId: 7 },
      //   prescDate: moment(new Date()).format("jYYYYjMMjDD"),
      //   docId: "2000200092",
      //   docMobileNo: "09991111111",
      //   docNationalCode: "1234567891",
      //   comments: "",
      //   expireDate: "14030102",
      //   clientId: "1234567891",
      //   noteDetailEprscs: [],
      //   noteDetailsReferralList: [
      //     {
      //       docSpecReferred: { specCode: spec.specCode },
      //       icd10s: icds.map((el) => ({ icdId: el.icdCode })),
      //       complaints: complaints.map((el) => ({ id: `${el.code}` })),
      //       message: data.description || "",
      //       quantity: data.quantity,
      //       referralHijriDate: moment(new Date(data.referralDate)).format(
      //         "jYYYYjMMjDD",
      //       ),
      //     },
      //   ],
      // },
    });
    if (!response.headers.get("content-type")?.includes("json")) {
      return next(new BadTaminResponseError());
    }
    const responseData = (await response.json()) as TaminResponse;
    console.log(responseData);
    if (responseData.data?.result?.error_Code) {
      if (
        responseData.data?.result?.error_Code === "304" &&
        !!responseData.data.result.error_Msg
      ) {
        const taminId =
          responseData.data.result.error_Msg.match(/شناسه.*?(\d+)/)?.[1];
        const tracking =
          responseData.data.result.error_Msg.match(/کد رهگیری\s*(\d+)/)?.[1];
        console.log({ taminId, tracking });
        if (!taminId || !tracking) return next(new BadTaminResponseError());
        const dup = await ReferralPrescription.exists({
          taminId,
          tracking,
        });
        if (dup) {
          next(new AppError(`نسخه تکراری است کد رهگیری ${tracking}`, 400));
        }
        await ReferralPrescription.create({
          author: req.doctor._id,
          patient: patient._id,
          spec: spec._id,
          complaints: complaints.map((el) => el._id),
          icds: icds.map((el) => el._id),
          taminId,
          tracking,
          quantity: data.quantity,
          message: data.description,
          referralDate: data.referralDate,
        });
      } else {
        return next(
          new AppError(
            `درخواست تامین ناموفق بود: ${
              responseData.data.result.error_Msg || "نامعلوم"
            }`,
            400,
          ),
        );
      }
    } else {
      if (
        !responseData.data?.result?.head_EPRSC_ID ||
        !responseData.data.result.trackingCode
      ) {
        return next(new BadTaminResponseError());
      }
      await ReferralPrescription.create({
        author: req.doctor._id,
        patient: patient._id,
        spec: spec._id,
        complaints: complaints.map((el) => el._id),
        icds: icds.map((el) => el._id),
        taminId: responseData.data.result.head_EPRSC_ID,
        tracking: responseData.data.result.trackingCode,
        quantity: data.quantity,
        message: data.description,
        referralDate: data.referralDate,
      });
    }
    res.status(200).json({ message: "submitReferralPrescription" });
  },
);

// const mine = [
//   {
//     docSpecReferred: {
//       specCode: spec.specCode,
//     },
//     icd10s: icds.map((el) => ({ icdId: el.icdCode })),
//     complaints: complaints.map((el) => ({ id: `${el.code}` })),
//     message: data.description || "",
//     referralHijriDate: moment(new Date(data.referralDate)).format(
//       "jYYYYjMMjDD",
//     ),
//     quantity: data.quantity,
//   },
// ];

const test = {
  patient: "0018243460",
  mobile: "09129999999",
  prescType: {
    prescTypeId: 7,
  },
  prescDate: "14050201",
  expireDate: "14030102",
  docId: "2000200092",
  docMobileNo: "09991111111",
  docNationalCode: "1234567891",
  comments: "",
  clientId: "1234567891",
  noteDetailEprscs: [],
  noteDetailsReferralList: [
    {
      docSpecReferred: {
        specCode: "00100",
      },
      icd10s: [
        {
          icdId: "X46.49",
        },
        {
          icdId: "X46.51",
        },
      ],
      complaints: [
        {
          id: "704425001",
        },
      ],
      message: "ارجاع",
      referralHijriDate: "14050220",
      quantity: 3,
    },
  ],
};

export const getReferralPrescriptions: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const data = await ReferralPrescription.find({
      author: req.doctor._id,
    }).populate([
      { path: "patient" },
      { path: "spec" },
      { path: "complaints" },
      { path: "icds" },
    ]);
    res.status(200).json({ message: "getReferralPrescriptions", data });
  },
);
