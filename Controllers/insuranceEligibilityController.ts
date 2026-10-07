import { NextFunction, Request, RequestHandler, Response } from "express";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError } from "../Lib/AppError";
import AppConfig from "../Models/AppConfig";
import AdminTaminCred from "../Models/AdminTaminCred";
import { getAppConfig } from "../Lib/appConfig";
import { TAMIN_END_USER_LOCKOUT } from "./featureGateController";
import {
  checkEligibility,
  eligibilityProviderIds,
  eligibilitySettingKey,
  eligibilitySettings,
} from "../Lib/insuranceEligibility";

// The super admin's «استعلام برخط بیمه» tab of the insurance hub
// (Lib/insuranceEligibility.ts): each provider on or off, and a test.

const providerState = async () => {
  const on = await eligibilitySettings();
  const adminToken = !!(await AdminTaminCred.findOne({}).select("token").lean<{ token?: string }>())?.token;
  return eligibilityProviderIds.map((id) => ({
    id,
    enabled: on[id],
    // Tamin answers nobody but the admin's sandbox test while the
    // end-user lockout is on (Controllers/featureGateController.ts)
    locked: id === "tamin" ? TAMIN_END_USER_LOCKOUT : false,
    // the provider can answer at all: Tamin through a Tamin connection,
    // Salamat not until its web service is contracted
    configured: id === "tamin",
    sandboxToken: id === "tamin" ? adminToken : false,
  }));
};

// GET /admin/insurance-eligibility
export const getEligibilitySettings: RequestHandler = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({ message: "getEligibilitySettings", data: { providers: await providerState() } });
});

const saveSchema = z.strictObject({ tamin: z.boolean().optional(), salamat: z.boolean().optional() });

// PUT /admin/insurance-eligibility {tamin?, salamat?}
export const saveEligibilitySettings: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const parsed = saveSchema.safeParse(req.body ?? {});
  if (!parsed.success) return next(new BadInputError());
  await getAppConfig();
  const set: Record<string, boolean> = {};
  for (const id of eligibilityProviderIds) if (typeof parsed.data[id] === "boolean") set[eligibilitySettingKey[id]] = parsed.data[id]!;
  if (Object.keys(set).length) await AppConfig.updateOne({ singleton: "SINGLETON" }, { $set: set });
  res.status(200).json({ message: "saveEligibilitySettings", data: { providers: await providerState() } });
});

const testSchema = z.strictObject({
  provider: z.enum(eligibilityProviderIds),
  nationalId: z.string().regex(/^\d{10}$/),
});

// POST /admin/insurance-eligibility/test {provider, nationalId} - one check
// with the admin sandbox credential, whether the provider is on or not
export const testEligibility: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const parsed = testSchema.safeParse(req.body ?? {});
  if (!parsed.success) return next(new BadInputError());
  const insurer = parsed.data.provider === "tamin" ? { name: "تامین اجتماعی", isBasic: true } : { name: "بیمه سلامت", isBasic: true };
  const result = await checkEligibility(insurer, { nationalId: parsed.data.nationalId }, { admin: true, force: true });
  res.status(200).json({ message: "testEligibility", data: result });
});
