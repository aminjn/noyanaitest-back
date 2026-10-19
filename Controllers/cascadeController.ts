import { NextFunction, Request, RequestHandler, Response } from "express";
import mongoose from "mongoose";
import catchAsync from "../Lib/catchAsync";
import AppError from "../Lib/AppError";
import { planCascade, runCascade } from "../Lib/cascadeDelete";
import { dropProviderContracts } from "../Lib/insuranceContracts";

// The super admin's full delete (2026-10): GET shows what goes with the
// record, table by table; DELETE removes all of it (Lib/cascadeDelete.ts).
// Only the record kinds listed here; the record itself must exist.
const kinds: Record<string, { model: string; contracts?: "doctor" }> = {
  doctorprofile: { model: "DoctorProfile", contracts: "doctor" },
};

const target = async (req: Request) => {
  const kind = kinds[req.params.kind];
  if (!kind) throw new AppError("این نوع رکورد را نمی‌شود این‌طور حذف کرد", 400);
  if (!mongoose.isValidObjectId(req.params.nodeId)) throw new AppError("رکورد پیدا نشد", 404);
  if (!(await mongoose.model(kind.model).exists({ _id: req.params.nodeId })))
    throw new AppError("رکورد پیدا نشد", 404);
  return kind;
};

export const preview: RequestHandler = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
  const kind = await target(req);
  const plan = await planCascade(kind.model, req.params.nodeId);
  res.status(200).json({ message: "cascadePreview", data: { rows: plan.rows } });
});

export const remove: RequestHandler = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
  const kind = await target(req);
  const plan = await planCascade(kind.model, req.params.nodeId);
  if (kind.contracts) await dropProviderContracts(kind.contracts, req.params.nodeId);
  const result = await runCascade(kind.model, req.params.nodeId, plan);
  res.status(200).json({ message: "cascadeRemove", data: { ...result, rows: plan.rows } });
});
