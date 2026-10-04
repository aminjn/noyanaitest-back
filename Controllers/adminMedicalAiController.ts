import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId, Model } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import { BadInputError, NotFoundError } from "../Lib/AppError";
import AppError from "../Lib/AppError";
import Disease from "../Models/Disease";
import Drug from "../Models/Drug";
import Symptom from "../Models/Symptom";
import {
  checkMedicalFields,
  contentAiProvider,
  draftMedicalFields,
  MedicalKind,
} from "../Services/medicalContentAi";

// AI draft / AI check of an encyclopedia page (Services/medicalContentAi.ts).
// Both read the saved record plus the admin's unsaved form values and save
// nothing: the form fills the drafts in and the admin presses "Save".

const MODELS: Record<MedicalKind, Model<any>> = {
  disease: Disease,
  drug: Drug,
  symptom: Symptom,
};

// the saved record (when the page exists) with the form's unsaved text on top
const recordOf = async (req: Request): Promise<Record<string, unknown>> => {
  const kind = req.params.kind as MedicalKind;
  const model = MODELS[kind];
  if (!model) throw new NotFoundError();
  const { id } = req.params;
  let saved: Record<string, unknown> = {};
  if (id !== "new") {
    if (!isValidObjectId(id)) throw new NotFoundError();
    const doc = await model.findById(id).lean();
    if (!doc) throw new NotFoundError();
    saved = doc as Record<string, unknown>;
  }
  const form = req.body?.record;
  if (form !== undefined && (typeof form !== "object" || Array.isArray(form) || form === null))
    throw new BadInputError();
  const merged: Record<string, unknown> = { ...saved };
  for (const [key, value] of Object.entries((form || {}) as Record<string, unknown>))
    if (typeof value === "string") merged[key] = value;
  if (typeof merged.name !== "string" || !merged.name.trim())
    throw new AppError("برای استفاده از هوش مصنوعی ابتدا نام را وارد کنید", 400);
  return merged;
};

// GET /admin/medical/ai/status - whether the buttons can work
export const medicalAiStatus: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  const p = await contentAiProvider();
  res.status(200).json({
    message: "medicalAiStatus",
    data: { configured: !!p, provider: p?.kind, model: p?.model },
  });
});

// POST /admin/medical/:kind/:id/ai-draft {record?} -> {drafts, skipped}
export const medicalAiDraft: RequestHandler = catchAsync(
  async (req: Request, res: Response, _next: NextFunction) => {
    const record = await recordOf(req);
    const result = await draftMedicalFields(req.params.kind as MedicalKind, record);
    res.status(200).json({ message: "medicalAiDraft", data: result });
  },
);

// POST /admin/medical/:kind/:id/ai-check {record?} -> {issues}
export const medicalAiCheck: RequestHandler = catchAsync(
  async (req: Request, res: Response, _next: NextFunction) => {
    const record = await recordOf(req);
    const issues = await checkMedicalFields(req.params.kind as MedicalKind, record);
    res.status(200).json({ message: "medicalAiCheck", data: { issues } });
  },
);
