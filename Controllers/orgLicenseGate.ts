import { NextFunction, Request, RequestHandler, Response } from "express";
import * as doctorController from "./doctorController";
import * as clinicController from "./clinicController";
import * as hospitalController from "./hospitalController";
import * as pharmacyController from "./pharmacyController";
import * as paraClinicController from "./paraClinicController";
import * as insuranceController from "./InsuracneController";
import { PathNotFoundError } from "../Lib/AppError";

// The shared /acl/:name and /blog/:name routers serve every org panel; the
// plan module ("secretaries", "articles") was checked only in the frontend.
// This picks the right org's gate from :name. Must sit after useAcl(...),
// which puts the org on req[name].
type Gate = (mod: never) => RequestHandler;
const gates: Record<string, Gate> = {
  doctor: doctorController.requireLicenseModule as Gate,
  clinic: clinicController.requireLicenseModule as Gate,
  hospital: hospitalController.requireLicenseModule as Gate,
  pharmacy: pharmacyController.requireLicenseModule as Gate,
  paraClinic: paraClinicController.requireLicenseModule as Gate,
  insurance: insuranceController.requireLicenseModule as Gate,
};

export const requireOrgLicenseModule =
  (mod: "secrataries" | "articles"): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    const gate = gates[req.params.name];
    if (!gate) return next(new PathNotFoundError());
    return gate(mod as never)(req, res, next);
  };
