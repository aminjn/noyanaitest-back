import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError from "../Lib/AppError";
import Speciality from "../Models/Speciality";
import Doctor from "../Models/Doctor";
import Part from "../Models/Part";
import Blog from "../Models/Blog";
import Symptom from "../Models/Symptom";
import Drug from "../Models/Drug";
import Disease from "../Models/Disease";
import {
  forgetImported,
  getOldImportJob,
  OLD_IMPORT_STEPS,
  OldImportStep,
  startOldImportJob,
} from "../Services/oldSiteImport";

// Old-site import (Services/oldSiteImport.ts): a background job the devtools
// page polls. POST /migrate/all runs every collection in dependency order;
// POST /migrate/<collection> runs one (with what it links to). Same service
// as the server script deploy/arvan/import-old.sh.

const startBody = z.object({
  filesBaseUrl: z.string().trim().max(500).optional(),
  downloadFiles: z.boolean().optional(),
});

const parseStart = (req: Request) => {
  const parsed = startBody.safeParse(req.body || {});
  const filesBaseUrl = parsed.success ? parsed.data.filesBaseUrl || undefined : undefined;
  if (!parsed.success || (filesBaseUrl && !/^https?:\/\/[^\s/]+/i.test(filesBaseUrl)))
    throw new AppError("آدرس فایل‌های سایت قدیم معتبر نیست", 400);
  return { filesBaseUrl, downloadFiles: parsed.success ? parsed.data.downloadFiles : undefined };
};

export const startImportAll: RequestHandler = catchAsync(async (req: Request, res: Response) => {
  const job = await startOldImportJob({ ...parseStart(req), source: "panel" });
  res.status(202).json({ message: "importAll", data: job });
});

export const getImportJob: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({ message: "importJob", data: await getOldImportJob() });
});

const importStep = (step: OldImportStep): RequestHandler =>
  catchAsync(async (req: Request, res: Response) => {
    const job = await startOldImportJob({ ...parseStart(req), only: [step], source: "panel" });
    res.status(202).json({ message: `import:${step}`, data: job });
  });

export const importDoctors = importStep("doctor");
export const importBlogs = importStep("blog");
export const importDiseases = importStep("disease");
export const importDrugs = importStep("drug");
export const importParts = importStep("part");
export const importSpecialities = importStep("speciality");
export const importSymptoms = importStep("symptom");
export const importUsers = importStep("user");
export const importSteps = OLD_IMPORT_STEPS;

export const dropDoctors: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Doctor.deleteMany({ old: { $exists: true, $ne: null } });
    await forgetImported("doctor");
    res.status(200).json({ message: "dropDoctors" });
  }
);

export const purgeDoctors: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Doctor.updateMany(
      { old: { $exists: true, $ne: null } },
      { $unset: { old: 1 } }
    );
    await forgetImported("doctor");
    res.status(200).json({ message: "purgeDoctors" });
  }
);

export const dropAllDoctors: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Doctor.deleteMany();
    await forgetImported("doctor");
    res.status(200).json({ message: "dropAllDoctors" });
  }
);

export const dropParts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Part.deleteMany({ old: { $exists: true, $ne: null } });
    await forgetImported("part");
    res.status(200).json({ message: "dropParts" });
  }
);

export const purgeParts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Part.updateMany(
      { old: { $exists: true, $ne: null } },
      { $unset: { old: 1 } }
    );
    await forgetImported("part");
    res.status(200).json({ message: "purgeParts" });
  }
);

export const dropAllParts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Part.deleteMany();
    await forgetImported("part");
    res.status(200).json({ message: "dropAllParts" });
  }
);

export const dropBlogs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Blog.deleteMany({ old: { $exists: true, $ne: null } });
    await forgetImported("blog");
    res.status(200).json({ message: "dropBlogs" });
  }
);

export const purgeBlogs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Blog.updateMany(
      { old: { $exists: true, $ne: null } },
      { $unset: { old: 1 } }
    );
    await forgetImported("blog");
    res.status(200).json({ message: "purgeBlogs" });
  }
);

export const dropAllBlogs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Blog.deleteMany();
    await forgetImported("blog");
    res.status(200).json({ message: "dropAllBlogs" });
  }
);

export const dropDiseases: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Disease.deleteMany({ old: { $exists: true, $ne: null } });
    await forgetImported("disease");
    res.status(200).json({ message: "dropDiseases" });
  }
);

export const purgeDiseases: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Disease.updateMany(
      { old: { $exists: true, $ne: null } },
      { $unset: { old: 1 } }
    );
    await forgetImported("disease");
    res.status(200).json({ message: "purgeDiseases" });
  }
);

export const dropAllDiseases: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Disease.deleteMany();
    await forgetImported("disease");
    res.status(200).json({ message: "dropAllDiseases" });
  }
);

export const dropDrugs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Drug.deleteMany({ old: { $exists: true, $ne: null } });
    await forgetImported("drug");
    res.status(200).json({ message: "dropDrugs" });
  }
);

export const purgeDrugs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Drug.updateMany(
      { old: { $exists: true, $ne: null } },
      { $unset: { old: 1 } }
    );
    await forgetImported("drug");
    res.status(200).json({ message: "purgeDrugs" });
  }
);

export const dropAllDrugs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Drug.deleteMany();
    await forgetImported("drug");
    res.status(200).json({ message: "dropAllDrugs" });
  }
);

export const dropSpecialities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Speciality.deleteMany({ old: { $exists: true, $ne: null } });
    await forgetImported("speciality");
    res.status(200).json({ message: "dropSpecialities" });
  }
);

export const purgeSpecialities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Speciality.updateMany(
      { old: { $exists: true, $ne: null } },
      { $unset: { old: 1 } }
    );
    await forgetImported("speciality");
    res.status(200).json({ message: "purgeSpecialities" });
  }
);

export const dropAllSpecialities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Speciality.deleteMany();
    await forgetImported("speciality");
    res.status(200).json({ message: "dropAllSpecialities" });
  }
);

export const dropSymptoms: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Symptom.deleteMany({ old: { $exists: true, $ne: null } });
    await forgetImported("symptom");
    res.status(200).json({ message: "dropSymptoms" });
  }
);

export const purgeSymptoms: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Symptom.updateMany(
      { old: { $exists: true, $ne: null } },
      { $unset: { old: 1 } }
    );
    await forgetImported("symptom");
    res.status(200).json({ message: "purgeSymptoms" });
  }
);

export const dropAllSymptoms: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Symptom.deleteMany();
    await forgetImported("symptom");
    res.status(200).json({ message: "deleteAllSymptoms" });
  }
);
