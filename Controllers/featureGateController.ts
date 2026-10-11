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
// 2026-10 (owner decision, "only the doctor for now"): the doctor
// e-prescription (Prescription2 drafting/commit/edit/delete, visit and
// referral prescriptions, eligibility, Tamin login and settings) talks to
// Tamin's production API through Lib/taminEp.ts and is open again - its
// routes carry `taminDoctorEPrescriptionGate` instead, which only blocks
// while TAMIN_DOCTOR_EP_LOCKOUT is true (the switch to close it again).
// The legacy v1 doctor prescription routes (/doctor/presc,
// /doctor/presc/:nodeId, /doctor/presc/tamin/:nodeId), which still
// hardcode sandbox values, keep `blockTaminEndUserAccess`, together with
// the pharmacy, clinic and paraClinic surfaces.
//
// TO RE-ENABLE FOR REAL USERS: once Tamin is production-ready, delete the
// `blockTaminEndUserAccess` line from each marked route below - nothing
// else needs to change.
// The same lockout as a flag, for code that reaches Tamin outside a route
// (2026-10: the live insurance eligibility adapter, Lib/insuranceEligibility
// .ts, reads it and answers "locked" for every real user while it is on).
// Set it to false together with removing the route lines above.
// It still covers pharmacy, clinic, paraClinic and the live insurance
// eligibility adapter (which calls the sandbox) - not the doctor
// e-prescription, which has its own switch below.
export const TAMIN_END_USER_LOCKOUT = true;

// The doctor e-prescription surface (2026-10: open, production API).
export const TAMIN_DOCTOR_EP_LOCKOUT = false;

export const blockTaminEndUserAccess: RequestHandler = (
  _req: Request,
  _res: Response,
  next: NextFunction,
) => next(new FeatureTemporarilyDisabledError());

// On every doctor e-prescription route (doctorRouter.ts, marked
// "[tamin-doctor-ep]"): passes while TAMIN_DOCTOR_EP_LOCKOUT is false.
export const taminDoctorEPrescriptionGate: RequestHandler = (
  _req: Request,
  _res: Response,
  next: NextFunction,
) => (TAMIN_DOCTOR_EP_LOCKOUT ? next(new FeatureTemporarilyDisabledError()) : next());
