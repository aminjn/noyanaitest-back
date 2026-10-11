import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  MiddlewareError,
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
import { tehranMoment } from "../Lib/tehranTime";
import {
  editEpresc,
  EpItem,
  EpPrescType,
  getDoctorTaminToken,
  isSameTaminDay,
  patientForTamin,
  removeEpresc,
  requireDoctorIdentity,
  sendEpresc,
  SendEprescResult,
} from "../Lib/taminEp";
import TaminServiceType, {
  ITaminServiceType,
} from "../Models/TaminServiceType";
import TaminPrescription2, {
  ITaminPrescription2,
} from "../Models/Prescription/TaminPrescription2";
import TaminPrescriptionType, {
  ITaminPrescriptionType,
} from "../Models/TaminPrescriptionType";
import VisitPrescription from "../Models/VisitPrescription";
import TaminSpec from "../Models/TaminSpec";
import TaminPhIllness from "../Models/TaminPhIllness";
import TaminPhPlan from "../Models/TaminPhPlan";
import TaminComplaint from "../Models/TaminComplaint";
import TaminIcid from "../Models/TaminIdid";
import ReferralPrescription from "../Models/ReferralPrescription";
import DoctorShift from "../Models/DoctorShift";

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
        // Tamin ph-illness / ph-plan ids, comma-separated
        illnessId: z.string().max(200).regex(/^[\w,-]*$/).optional(),
        planId: z.string().max(200).regex(/^[\w,-]*$/).optional(),
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
    clone.push({
      service: service,
      qty: item.qty,
      dateDo: item.dateDo,
      // Physiotherapy ids (guide 3, note 9); ignored for other types.
      ...(Number(service.srvType) === 13
        ? { illnessId: item.illnessId, planId: item.planId }
        : {}),
    });
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
        illnessId: item.illnessId,
        planId: item.planId,
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
        illnessId: item.illnessId,
        planId: item.planId,
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

// noteDetailEprscs (guide section 3).
const makeTaminItemsList = (items: ValidatedItems): EpItem[] => {
  const result: EpItem[] = [];
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
    if (item.dose) element.dose = item.dose;
    if (item.repeat) element.repeat = item.repeat;
    if (item.dateDo)
      element.dateDo = tehranMoment(new Date(item.dateDo)).format("jYYYYjMMjDD");
    if (item.illnessId) element.illnessId = item.illnessId;
    if (item.planId) element.planId = item.planId;
    result.push(element);
  }
  return result;
};

// Visit (3) and medical-service (5) prescriptions can't be edited in Tamin
// (guide section 7).
const NON_EDITABLE_PRESC_TYPES = [3, 5];

const saveSent = async ({
  prescriptionId,
  prescTypeId,
  serviceTypeId,
  sent,
}: {
  prescriptionId: unknown;
  prescTypeId: unknown;
  serviceTypeId: unknown;
  sent: SendEprescResult;
}) => {
  if (sent.duplicate) {
    const dup = await TaminPrescription2.exists({
      taminId: sent.taminId,
      tracking: sent.tracking,
    });
    if (dup)
      throw new AppError(`نسخه تکراری است کد رهگیری ${sent.tracking}`, 400);
  }
  return TaminPrescription2.findOneAndUpdate(
    {
      prescription: prescriptionId,
      prescType: prescTypeId,
      serviceType: serviceTypeId,
    },
    {
      prescription: prescriptionId,
      taminId: sent.taminId,
      tracking: sent.tracking,
      prescType: prescTypeId,
      serviceType: serviceTypeId,
      createdAt: new Date(),
    },
    { upsert: true, new: true },
  );
};

const commitSchema = z
  .strictObject({ comments: z.string().max(500).optional() })
  .optional();

// Sends one Tamin prescription per service type (each service type maps to
// a prescription type - drugs, lab, imaging, physio...).
export const commitPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const parsed = await commitSchema.safeParseAsync(
      req.body && Object.keys(req.body).length ? req.body : undefined,
    );
    if (!parsed.success) return next(new BadInputError());
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
    const { token, cred } = await getDoctorTaminToken(req.doctor._id);
    const identity = await requireDoctorIdentity(req.doctor._id, cred);
    const patient = await patientForTamin(prescription.patient);
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
      try {
        const sent = await sendEpresc({
          token,
          identity,
          patient,
          prescTypeId: Number(prescType.prescTypeId) as EpPrescType,
          items: makeTaminItemsList(grouped[srvType]),
          comments: parsed.data?.comments,
        });
        await saveSent({
          prescriptionId: prescription._id,
          prescTypeId: prescType._id,
          serviceTypeId: serviceType._id,
          sent,
        });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        failed = err;
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
    // the items are their own documents (Prescription2.items is virtual)
    await PrescriptionItem.findByIdAndDelete(toDelete[c]._id);
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
        illnessId: incomingItems[k].illnessId,
        planId: incomingItems[k].planId,
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
    const { token, cred } = await getDoctorTaminToken(req.doctor._id);
    const identity = await requireDoctorIdentity(req.doctor._id, cred);
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
    for (let i = 0; i < grouped.length; ++i) {
      const existingItems = prescription.items?.filter(
        (el) =>
          Number(el.service.srvType) === Number(grouped[i].serviceType.srvType),
      );
      let changed = grouped[i].items.length !== existingItems.length;
      for (let j = 0; !changed && j < existingItems.length; ++j) {
        const found = grouped[i].items.find(
          (service) =>
            service.service._id.toString() ===
            existingItems[j].service._id.toString(),
        );
        changed =
          !found ||
          found.timesADay?._id.toString() !==
            existingItems[j].timesADay?._id.toString() ||
          found.drugInstruction?._id.toString() !==
            existingItems[j].drugInstruction?._id.toString() ||
          found.qty !== existingItems[j].qty ||
          (found.dose || "") !== (existingItems[j].dose || "") ||
          (found.illnessId || "") !== (existingItems[j].illnessId || "") ||
          (found.planId || "") !== (existingItems[j].planId || "") ||
          (found.dateDo?.getTime?.() || 0) !==
            (existingItems[j].dateDo?.getTime?.() || 0);
      }
      if (!changed) continue;
      foundAnyChange = true;
      const prescType = await TaminPrescriptionType.findOne({
        prescTypeId: Number(grouped[i].serviceType.prescTypeId),
      });
      if (!prescType) return next(new ServerError());
      const taminPresc = await TaminPrescription2.findOne({
        prescription: prescription._id,
        serviceType: grouped[i].serviceType._id,
      });
      try {
        if (!taminPresc) {
          // A service type that wasn't on the prescription yet - send it as
          // a new Tamin prescription.
          const sent = await sendEpresc({
            token,
            identity,
            patient: await patientForTamin(prescription.patient),
            prescTypeId: Number(prescType.prescTypeId) as EpPrescType,
            items: makeTaminItemsList(grouped[i].items),
          });
          await saveSent({
            prescriptionId: prescription._id,
            prescTypeId: prescType._id,
            serviceTypeId: grouped[i].serviceType._id,
            sent,
          });
        } else {
          if (NON_EDITABLE_PRESC_TYPES.includes(Number(prescType.prescTypeId)))
            throw new AppError(
              `نسخه ${prescType.prescTypeDesc || ""} در تامین قابل ویرایش نیست؛ آن را حذف و دوباره ثبت کنید`,
              400,
            );
          if (taminPresc.editedAt)
            throw new AppError(
              `نسخه با کد رهگیری ${taminPresc.tracking} قبلا یک بار ویرایش شده و تامین ویرایش دوباره را نمی‌پذیرد`,
              400,
            );
          await editEpresc({
            token,
            identity,
            taminId: taminPresc.taminId,
            items: makeTaminItemsList(grouped[i].items),
          });
          await TaminPrescription2.findByIdAndUpdate(taminPresc._id, {
            editedAt: new Date(),
          });
        }
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        failed.push(err);
        continue;
      }
      await editTaminPrescriptionItemsCleanUp({
        prescription: prescription,
        existingItems,
        incomingItems: grouped[i].items,
      });
    }
    // Service types removed entirely -> remove their Tamin prescriptions.
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
    const keptServiceTypes = new Set<string>();
    for (let d = 0; d < toDelete.length; d++) {
      try {
        if (!isSameTaminDay(toDelete[d].createdAt))
          throw new AppError(
            `نسخه با کد رهگیری ${toDelete[d].tracking} فقط تا پایان روز ثبت قابل حذف از تامین بود`,
            400,
          );
        await removeEpresc({ token, identity, taminId: toDelete[d].taminId });
        await TaminPrescription2.findByIdAndDelete(toDelete[d]._id);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        failed.push(err);
        keptServiceTypes.add(String(toDelete[d].serviceType));
      }
    }
    const kept = serviceTypes.filter((st) =>
      keptServiceTypes.has(st._id.toString()),
    );
    for (let y = 0; y < toDeleteItems.length; ++y) {
      const stillInTamin = kept.some(
        (st) => Number(st.srvType) === Number(toDeleteItems[y].service.srvType),
      );
      if (!stillInTamin)
        await PrescriptionItem.findByIdAndDelete(toDeleteItems[y]._id);
    }
    if (!foundAnyChange) return next(new AppError("تغییری مشاهده نشد", 400));
    res.status(200).json({
      message: "editTaminPrescription",
      errors: failed.map((el) => el.message),
    });
  },
);

const notSameDayError = (tracking: string) =>
  new AppError(
    `نسخه با کد رهگیری ${tracking} فقط تا پایان روز ثبت قابل حذف از تامین بود`,
    400,
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
          "این نسخه در تامین ثبت نشده لطفا از منوی مربوطه برای حذف استفاده کنید",
          400,
        ),
      );
    // Tamin only accepts removals on the registration day (guide 6) - check
    // all of them first so a prescription isn't left half-removed.
    const stale = node.taminPrescriptions.find(
      (t) => !isSameTaminDay(t.createdAt),
    );
    if (stale) return next(notSameDayError(stale.tracking));
    const { token, cred } = await getDoctorTaminToken(req.doctor._id);
    const identity = await requireDoctorIdentity(req.doctor._id, cred);
    for (let i = 0; i < node.taminPrescriptions.length; ++i) {
      await removeEpresc({
        token,
        identity,
        taminId: node.taminPrescriptions[i].taminId,
      });
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

// Visit prescription: prescType 3 with no items (guide 17).
export const newVisitPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { patient } = req.body;
    if (!isValidObjectId(patient)) return next(new BadInputError());
    const p = await UserIdentity.findById(patient);
    if (!p) return next(new NotFoundError());
    const { token, cred } = await getDoctorTaminToken(req.doctor._id);
    const identity = await requireDoctorIdentity(req.doctor._id, cred);
    const sent = await sendEpresc({
      token,
      identity,
      patient: await patientForTamin(p),
      prescTypeId: 3,
    });
    if (sent.duplicate) {
      const dup = await VisitPrescription.exists({
        taminId: sent.taminId,
        tracking: sent.tracking,
      });
      if (dup)
        return next(
          new AppError(`نسخه تکراری است کد رهگیری ${sent.tracking}`, 400),
        );
    }
    await VisitPrescription.create({
      patient: p._id,
      author: req.doctor._id,
      taminId: sent.taminId,
      tracking: sent.tracking,
    });
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
    if (!isSameTaminDay(node.createdAt))
      return next(notSameDayError(node.tracking));
    const { token, cred } = await getDoctorTaminToken(req.doctor._id);
    const identity = await requireDoctorIdentity(req.doctor._id, cred);
    await removeEpresc({ token, identity, taminId: node.taminId });
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

// Physiotherapy illness types and treatment plans (illnessId / planId on
// physio items - guide 3, note 9).
export const getPhysioBaseData: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const [illnesses, plans] = await Promise.all([
      TaminPhIllness.find().select("illnessId illnessDesc").lean(),
      TaminPhPlan.find().select("planId planDesc planCode").lean(),
    ]);
    res
      .status(200)
      .json({ message: "getPhysioBaseData", data: { illnesses, plans } });
  },
);

// Doctor referral (prescType 7, guide 3 note 6): the referral date is the
// validity of the referral - from tomorrow up to three months ahead - and
// at most 3 referrals.
const MAX_REFERRAL_QUANTITY = 3;
const submitReferralPrescriptionSchema = z.strictObject({
  spec: z.string(),
  complaints: z.array(z.string()).nonempty(),
  icds: z.array(z.string()).nonempty(),
  patient: z.string(),
  description: z.string().optional(),
  quantity: z.number().int().min(1).max(MAX_REFERRAL_QUANTITY),
  referralDate: datish,
});

const referralDateIsValid = (date: Date) => {
  const day = tehranMoment(date).startOf("day");
  const tomorrow = tehranMoment().add(1, "day").startOf("day");
  const limit = tehranMoment().add(3, "jMonth").endOf("day");
  return !day.isBefore(tomorrow) && !day.isAfter(limit);
};

export const submitReferralPrescription: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.doctor) return next(new MiddlewareError());
    const { data, success } =
      await submitReferralPrescriptionSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError());
    if (
      !isValidObjectId(data.patient) ||
      !isValidObjectId(data.spec) ||
      !!data.complaints.some((el) => !isValidObjectId(el)) ||
      !!data.icds.some((el) => !isValidObjectId(el))
    )
      return next(new BadInputError());
    if (!referralDateIsValid(new Date(data.referralDate)))
      return next(
        new AppError(
          "تاریخ ارجاع باید بین فردا تا حداکثر سه ماه آینده باشد",
          400,
        ),
      );
    const spec = await TaminSpec.findById(data.spec);
    if (!spec) return next(new NotFoundError());
    const patient = await UserIdentity.findById(data.patient);
    if (!patient) return next(new NotFoundError());
    const complaints = await TaminComplaint.find({ _id: data.complaints });
    if (complaints.length !== data.complaints.length)
      return next(new NotFoundError());
    const icds = await TaminIcid.find({ _id: data.icds });
    if (icds.length !== data.icds.length) return next(new NotFoundError());
    const { token, cred } = await getDoctorTaminToken(req.doctor._id);
    const identity = await requireDoctorIdentity(req.doctor._id, cred);
    const taminPatient = await patientForTamin(patient);
    const sent = await sendEpresc({
      token,
      identity,
      patient: taminPatient,
      prescTypeId: 7,
      referrals: [
        {
          docSpecReferred: { specCode: spec.specCode },
          // Codes are sent as strings (guide 3, note 6).
          icd10s: icds.map((el) => ({ icdId: String(el.icdCode) })),
          complaints: complaints.map((el) => ({ id: String(el.code) })),
          message: data.description || "",
          referralHijriDate: tehranMoment(new Date(data.referralDate)).format(
            "jYYYYjMMjDD",
          ),
          quantity: data.quantity,
        },
      ],
    });
    if (sent.duplicate) {
      const dup = await ReferralPrescription.exists({
        taminId: sent.taminId,
        tracking: sent.tracking,
      });
      if (dup)
        return next(
          new AppError(`نسخه تکراری است کد رهگیری ${sent.tracking}`, 400),
        );
    }
    await ReferralPrescription.create({
      author: req.doctor._id,
      patient: patient._id,
      spec: spec._id,
      complaints: complaints.map((el) => el._id),
      icds: icds.map((el) => el._id),
      taminId: sent.taminId,
      tracking: sent.tracking,
      quantity: data.quantity,
      message: data.description,
      referralDate: data.referralDate,
    });
    res.status(200).json({ message: "submitReferralPrescription" });
  },
);

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
