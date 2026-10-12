import express, { NextFunction, Request, Response } from "express";
import multer from "multer";
import AppError from "../Lib/AppError";
import { IMPORT_MAX_BYTES } from "../Lib/providerImport/catalog";
import * as authController from "../Controllers/authController";
import * as providerImportController from "../Controllers/providerImportController";

// Bulk provider import (Controllers/providerImportController.ts): the super
// admin only - it writes public pages of every provider type at once.
const router = express.Router();
router.use(authController.protect, authController.restrictTo("admin"));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMPORT_MAX_BYTES, files: 1 } });
const uploadFile = (req: Request, res: Response, next: NextFunction) =>
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if ((err as { code?: string }).code === "LIMIT_FILE_SIZE") return next(new AppError("حجم فایل بیش از ۲۰ مگابایت است", 413));
    next(new AppError("فایلی بارگذاری نشد", 400));
  });

router.get("/templates", providerImportController.listTemplates);
router.post("/templates", providerImportController.saveTemplate);
router.delete("/templates/:nodeId", providerImportController.deleteTemplate);
router.post("/templates/:nodeId/reset", providerImportController.resetTemplate);

router.post("/providers/upload", uploadFile, providerImportController.uploadImport);
router.get("/providers/catalog", providerImportController.getCatalog);
router.post("/providers/validate", providerImportController.validateImport);
router
  .route("/providers")
  .get(providerImportController.listImports)
  .post(providerImportController.applyImport);
router.get("/providers/:nodeId/source", providerImportController.getSource);
router.post("/providers/:nodeId/preview", providerImportController.previewImport);
router.post("/providers/:nodeId/ai-split", providerImportController.aiSplit);
router
  .route("/providers/:nodeId")
  .get(providerImportController.getImport)
  .delete(providerImportController.deleteImport);

export default router;
