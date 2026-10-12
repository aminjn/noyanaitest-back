import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import { importKinds, childKinds, kindChildren, kindFields, IMPORT_MAX_BYTES } from "../Lib/providerImport/catalog";
import ProviderImport from "../Models/ProviderImport";
import ProviderImportTemplate from "../Models/ProviderImportTemplate";
import {
  aiSplitNames,
  analyseStored,
  parseMapping,
  previewMapping,
  removeImport,
  resetBuiltinTemplate,
  saveUpload,
  startJob,
} from "../Services/providerImport";

// Super admin's bulk provider import (Services/providerImport.ts):
//   POST   /admin/import/providers/upload     multipart `file` -> the record lists found + a suggested mapping
//   GET    /admin/import/providers            history
//   GET    /admin/import/providers/catalog    our fields per profile type
//   GET    /admin/import/providers/:id        one import (progress, reports)
//   GET    /admin/import/providers/:id/source the file's lists again (reopening an upload)
//   POST   /admin/import/providers/:id/preview {mapping} -> the first records mapped, with problems
//   POST   /admin/import/providers/validate   {importId, mapping} -> dry run (background)
//   POST   /admin/import/providers            {importId, mapping} -> the run (background)
//   DELETE /admin/import/providers/:id        drops the stored file
//   POST   /admin/import/providers/:id/ai-split {field, chunks} -> names joined with no separator, split by the AI
//   GET/POST /admin/import/templates, DELETE /admin/import/templates/:id,
//   POST   /admin/import/templates/:id/reset  a built-in template back to what ships

const LIST_SELECT = "fileName size status native template fileDeleted progress createdAt startedAt finishedAt createdBy error validation.totals report.totals";

const ipOf = (req: Request) => {
  const fwd = req.headers["x-forwarded-for"];
  return (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0].trim() || req.socket.remoteAddress;
};

export const uploadImport: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const file = (req as Request & { file?: { buffer: Buffer; originalname: string; size: number } }).file;
  if (!file?.buffer?.length) return next(new BadInputError("فایلی بارگذاری نشد"));
  if (file.size > IMPORT_MAX_BYTES) return next(new AppError("حجم فایل بیش از ۲۰ مگابایت است", 413));
  const data = await saveUpload(file.buffer, Buffer.from(file.originalname, "latin1").toString("utf8"), req.user?._id);
  res.status(201).json({ message: "uploadImport", data });
});

export const getCatalog: RequestHandler = (_req, res) => {
  res.status(200).json({
    message: "importCatalog",
    data: {
      kinds: importKinds,
      childKinds,
      fields: kindFields,
      children: kindChildren,
      maxBytes: IMPORT_MAX_BYTES,
    },
  });
};

export const listImports: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  const data = await ProviderImport.find()
    .sort({ createdAt: -1 })
    .limit(50)
    .select(LIST_SELECT)
    .populate({ path: "createdBy", select: "firstName lastName phone" })
    .lean();
  res.status(200).json({ message: "listImports", data });
});

const idParam = (req: Request) => {
  const { nodeId } = req.params;
  if (!isValidObjectId(nodeId)) throw new NotFoundError();
  return nodeId;
};

export const getImport: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const row = await ProviderImport.findById(idParam(req)).populate({ path: "createdBy", select: "firstName lastName phone" }).lean();
  if (!row) return next(new NotFoundError());
  res.status(200).json({ message: "getImport", data: row });
});

export const getSource: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const id = idParam(req);
  const row = await ProviderImport.findById(id).lean();
  if (!row) return next(new NotFoundError());
  res.status(200).json({ message: "getSource", data: { import: row, ...(await analyseStored(id)) } });
});

export const previewImport: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const data = await previewMapping(idParam(req), req.body?.mapping);
  res.status(200).json({ message: "previewImport", data });
});

const runBody = z.object({ importId: z.string(), mapping: z.unknown(), template: z.string().max(120).optional() });

const run = (mode: "validate" | "apply"): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const parsed = runBody.safeParse(req.body);
    if (!parsed.success || !isValidObjectId(parsed.data.importId)) return next(new BadInputError());
    const data = await startJob(parsed.data.importId, parsed.data.mapping, mode, req.user as never, {
      ip: ipOf(req),
      path: req.originalUrl.split("?")[0],
      template: parsed.data.template,
    });
    res.status(202).json({ message: mode === "apply" ? "applyImport" : "validateImport", data });
  });

export const validateImport = run("validate");
export const applyImport = run("apply");

export const deleteImport: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  await removeImport(idParam(req));
  res.status(200).json({ message: "deleteImport" });
});

// ------------------------------------------------------------ templates

export const listTemplates: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  // built-in ones first
  const data = await ProviderImportTemplate.find().sort({ builtin: -1, updatedAt: -1 }).lean();
  res.status(200).json({ message: "listImportTemplates", data });
});

const templateBody = z.object({ name: z.string().trim().min(1).max(120), mapping: z.unknown() });

// saving under an existing name replaces that template
export const saveTemplate: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const parsed = templateBody.safeParse(req.body);
  if (!parsed.success) return next(new BadInputError("نام الگو لازم است"));
  const mapping = parseMapping(parsed.data.mapping);
  const data = await ProviderImportTemplate.findOneAndUpdate(
    { name: parsed.data.name },
    { $set: { mapping }, $setOnInsert: { name: parsed.data.name, ...(req.user?._id ? { createdBy: req.user._id } : {}) } },
    { upsert: true, new: true },
  );
  res.status(200).json({ message: "saveImportTemplate", data });
});

// a built-in template (the DrDr contract's) is not deleted: it is reset
export const deleteTemplate: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const id = idParam(req);
  const row = await ProviderImportTemplate.findById(id).select("builtin").lean();
  if (!row) return next(new NotFoundError());
  if (row.builtin) return next(new AppError("الگوی داخلی حذف نمی‌شود؛ می‌توانید آن را به حالت پیش‌فرض برگردانید", 400));
  await ProviderImportTemplate.deleteOne({ _id: id });
  res.status(200).json({ message: "deleteImportTemplate" });
});

export const resetTemplate: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const data = await resetBuiltinTemplate(idParam(req));
  res.status(200).json({ message: "resetImportTemplate", data });
});

const aiSplitBody = z.object({ field: z.enum(["services", "diseases"]), chunks: z.array(z.string().max(300)).max(60) });

export const aiSplit: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  idParam(req);
  const parsed = aiSplitBody.safeParse(req.body);
  if (!parsed.success) return next(new BadInputError());
  const data = await aiSplitNames(parsed.data.chunks, parsed.data.field);
  res.status(200).json({ message: "aiSplitImport", data });
});
