import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError } from "../Lib/AppError";
import AppConfig from "../Models/AppConfig";
import DoctorTaminCred from "../Models/DoctorTaminCred";
import { getAppConfig } from "../Lib/appConfig";
import { taminEpConfigSummary, taminEpEnv } from "../Lib/taminEp";

// Super admin «تامین اجتماعی» > «اتصال نسخه‌نویسی پزشک» (2026-10): the
// client id and redirect address of the doctor e-prescription login
// (Lib/taminEp.ts), stored in AppConfig with the .env as fallback. The
// environment (production | test) is TAMIN_EP_ENV in .env only, so a
// click can't point real prescriptions at the sandbox.

const summary = async () => {
  const config = await getAppConfig();
  return {
    ...(await taminEpConfigSummary()),
    // what is saved here (empty = .env / derived default)
    taminEpClientId: config.taminEpClientId || "",
    taminEpRedirectUri: config.taminEpRedirectUri || "",
    siteBaseUrl: config.siteBaseUrl || "",
    // doctors with a live session of this environment
    connectedDoctors: await DoctorTaminCred.countDocuments({
      token: { $exists: true },
      environment: taminEpEnv,
    }),
  };
};

// GET /admin/tamin/ep-settings
export const getTaminEpSettings: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({ message: "getTaminEpSettings", data: await summary() });
});

const saveSchema = z.strictObject({
  taminEpClientId: z.string().trim().max(200).regex(/^[\w.:-]*$/).optional(),
  // Tamin wants a static https address without query params (the test
  // environment also takes http://localhost)
  taminEpRedirectUri: z
    .string()
    .trim()
    .max(300)
    .refine(
      (v) =>
        v === "" ||
        ((/^https:\/\/[^\s?#]+$/i.test(v) || (taminEpEnv === "test" && /^http:\/\/localhost[^\s?#]*$/i.test(v))) &&
          !/[?#]/.test(v)),
    )
    .optional(),
});

// POST /admin/tamin/ep-settings {taminEpClientId?, taminEpRedirectUri?}
export const saveTaminEpSettings: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { data, success } = saveSchema.safeParse(req.body || {});
  if (!success) return next(new BadInputError());
  const $set: Record<string, string> = {};
  if (data.taminEpClientId !== undefined) $set.taminEpClientId = data.taminEpClientId;
  if (data.taminEpRedirectUri !== undefined) $set.taminEpRedirectUri = data.taminEpRedirectUri.replace(/\/+$/, "");
  await getAppConfig();
  if (Object.keys($set).length) await AppConfig.updateOne({ singleton: "SINGLETON" }, { $set });
  res.status(200).json({ message: "saveTaminEpSettings", data: await summary() });
});
