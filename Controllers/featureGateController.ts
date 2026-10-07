import { NextFunction, Request, RequestHandler, Response } from "express";
import { FeatureTemporarilyDisabledError } from "../Lib/AppError";

// Tamin end-user lockout (2026-09)
// -----------------------------------------------------------------------
// The entire Tamin/e-prescription integration (doctor prescriptions +
// referrals + visits, pharmacy fill/lookup, clinic referral flow,
// paraClinic sessions) only talks to Tamin's SANDBOX API right now. It is
// not safe to expose to real doctor/pharmacy/clinic/paraClinic users yet.
//
// Rather than deleting or rewriting any of that route/controller/model
// code, this single middleware is inserted as the FIRST handler on every
// route in that surface (see doctorRouter.ts, pharmacyRouter.ts,
// clinicRouter.ts, paraClinicRouter.ts - every route touched is marked
// with a "// [tamin-lockout]" comment right above it). It always rejects
// with a 403 before authController.protect/aclController.use<Org>() even
// run, so no session/license state matters.
//
// Equivalent functionality for internal testing lives in
// adminTaminRouter.ts, which calls the same controller logic directly
// (bypassing this gate) using admin-only sandbox credentials.
//
// TO RE-ENABLE FOR REAL USERS: once Tamin is production-ready, delete the
// `blockTaminEndUserAccess` line from each marked route below - nothing
// else needs to change.
// The same lockout as a flag, for code that reaches Tamin outside a route
// (2026-10: the live insurance eligibility adapter, Lib/insuranceEligibility
// .ts, reads it and answers "locked" for every real user while it is on).
// Set it to false together with removing the route lines above.
export const TAMIN_END_USER_LOCKOUT = true;

export const blockTaminEndUserAccess: RequestHandler = (
  _req: Request,
  _res: Response,
  next: NextFunction,
) => next(new FeatureTemporarilyDisabledError());
