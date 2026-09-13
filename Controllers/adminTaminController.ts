import { NextFunction, Request, RequestHandler, Response } from "express";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { MissingTaminTokenError, BadInputError } from "../Lib/AppError";
import makeTaminRequest from "../Lib/MakeTamjinRequest";
import { createCodeVerifier, toCodeChallenge } from "../Lib/helpers";
import AdminTaminCred from "../Models/AdminTaminCred";
import AdminClinicTaminCred from "../Models/AdminClinicTaminCred";

// Admin-only Tamin sandbox test console (2026-09)
// -----------------------------------------------------------------------
// Real doctor/pharmacy/clinic/paraClinic accounts can no longer reach
// Tamin directly (see Controllers/featureGateController.ts). This file is
// the replacement surface for internal testing: one dispatcher endpoint
// per org type, each taking `{ action, payload }` and switching to the
// matching Tamin call - same shape as adminController.snappTest, which
// already does this for Lib/snappClient.ts.
//
// Every Tamin path/payload below is copied as-is from the real
// controllers (doctorController.ts, pharmacyController.ts,
// clinicController.ts, paraClinicController.ts, prescriptionController.ts)
// - including their hardcoded sandbox test identifiers
// (patient "1234567891", doctor "2000200092", pharmacy "0000000920",
// paraClinic "0000007303", etc.), since those were already fake
// sandbox-only values in production, not real per-org data. `payload`
// from the admin caller is spread on top of those defaults so a tester can
// override any field without needing to know every default.
//
// Credentials come from AdminTaminCred / AdminClinicTaminCred - admin-wide
// singletons wholly independent of any real DoctorTaminCred/
// ClinicTaminToken, resolved with an empty filter
// (`findOneAndUpdate({}, {}, { upsert: true })`) so there's ever only one
// row per model. Pharmacy and paraClinic share the doctor-shaped
// AdminTaminCred, mirroring how their real controllers already borrow
// "any" DoctorTaminCred via `findOne()` with no filter.

const exchangeCode = async ({
  code,
  verifier,
  redirectUri,
}: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<string> => {
  const response = await fetch(
    "https://account-pilot.tamin.ir/auth/server/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        client_id: "portal-js",
        code,
        code_verifier: verifier,
      }).toString(),
    },
  );
  if (!response.headers.get("content-type")?.includes("json")) {
    throw new AppError("جواب دریافتی از سامانه معتبر نبود", 400);
  }
  const resData = await response.json();
  if (!resData.access_token)
    throw new AppError("جواب دریافتی از سامانه معتبر نبود", 400);
  return resData.access_token as string;
};

// ---------------------------------------------------------------- Doctor

const doctorTaminTestActions = [
  "getChallenge",
  "exchangeCode",
  "getTokenDate",
  "patientPrivilege",
  "sendEpresc",
  "reloadPrescription",
] as const;

const doctorTaminTestSchema = z.strictObject({
  action: z.enum(doctorTaminTestActions),
  payload: z.record(z.string(), z.any()).optional(),
});

// Mirrors doctorController.ts: checkTaminToken/taminCb/getTokenDate
// (OAuth), inquiryPatientPrivilege (deserve-info), and the SendEpresc call
// every commit path (commitPrescription/prescriptionController.
// commitPrescription/newVisitPrescription/submitReferralPrescription) ends
// up making, plus reloadPrescriptionFromTamin. Deliberately raw/passthrough
// rather than reading/writing Prescription/Prescription2 - this is a Tamin
// API tester, not a re-implementation of the local drafting workflow.
export const testDoctorTamin: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success, error } =
      await doctorTaminTestSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError(error.message));
    const payload = data.payload || {};
    const cred = await AdminTaminCred.findOneAndUpdate(
      {},
      {},
      { upsert: true, new: true },
    );

    const result = await (async () => {
      switch (data.action) {
        case "getChallenge": {
          const verifier = createCodeVerifier();
          const challenge = await toCodeChallenge(verifier);
          await AdminTaminCred.findByIdAndUpdate(cred._id, {
            verifier,
            challenge,
          });
          return { challenge };
        }
        case "exchangeCode": {
          if (!cred.verifier)
            throw new AppError("ابتدا چالش (challenge) را دریافت کنید", 400);
          if (!payload.code || !payload.redirectUri)
            throw new BadInputError("code و redirectUri الزامی است");
          const token = await exchangeCode({
            code: payload.code,
            verifier: cred.verifier,
            redirectUri: payload.redirectUri,
          });
          await AdminTaminCred.findByIdAndUpdate(cred._id, {
            token,
            tokenRefreshedAt: new Date(),
          });
          return { ok: true };
        }
        case "getTokenDate":
          return { tokenRefreshedAt: cred.tokenRefreshedAt };
        case "patientPrivilege": {
          if (!cred.token) throw new MissingTaminTokenError();
          if (!payload.nationalCode)
            throw new BadInputError("nationalCode الزامی است");
          const response = await makeTaminRequest({
            path: `https://ep-test.tamin.ir/api/v2/patients/deserve-info/${1234567891}/${2000200092}/${2000200092}/${payload.nationalCode}`,
            method: "GET",
            token: cred.token,
          });
          return await response.json();
        }
        case "sendEpresc": {
          if (!cred.token) throw new MissingTaminTokenError();
          const response = await makeTaminRequest({
            path: "https://ep-test.tamin.ir/api/v2/SendEpresc",
            method: "POST",
            token: cred.token,
            payload: {
              patient: "1234567891",
              mobile: "09129999999",
              prescType: { prescTypeId: 1 },
              prescDate: "14030101",
              docId: "2000200092",
              docMobileNo: "09991111111",
              docNationalCode: "1234567891",
              comments: "",
              expireDate: "14030102",
              clientId: "1234567891",
              noteDetailEprscs: [],
              ...payload,
            },
          });
          return await response.json();
        }
        case "reloadPrescription": {
          if (!cred.token) throw new MissingTaminTokenError();
          if (!payload.tracking)
            throw new BadInputError("tracking الزامی است");
          const response = await makeTaminRequest({
            path: `https://ep-test.tamin.ir/api/v2/ep/${payload.tracking}/${1234567891}/${2000200092}/detail`,
            method: "GET",
            token: cred.token,
          });
          return await response.json();
        }
      }
    })();

    res.status(200).json({ message: "testDoctorTamin", data: result });
  },
);

// -------------------------------------------------------------- Pharmacy

const pharmacyTaminTestActions = [
  "getPrescription",
  "preCheckPrescription",
  "submitPrescription",
  "getSubmittedPrescInfo",
  "removePrescription",
  "referrPresc",
  "getDrugEquiv",
  "getAdditiveDrugs",
] as const;

const pharmacyTaminTestSchema = z.strictObject({
  action: z.enum(pharmacyTaminTestActions),
  payload: z.record(z.string(), z.any()).optional(),
});

// Mirrors pharmacyController.ts's own `/tamin` and `/taminn` raw-passthrough
// routes almost verbatim (those already just spread req.body over a few
// sandbox defaults, gated only by aclController.usePharmacy()/useAcl() +
// requireLicenseModule("tamin") - this is the same thing, gated by
// authController.restrictTo("admin") instead and reading AdminTaminCred
// instead of DoctorTaminCred.findOne()).
export const testPharmacyTamin: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success, error } =
      await pharmacyTaminTestSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError(error.message));
    const payload = data.payload || {};
    const cred = await AdminTaminCred.findOneAndUpdate(
      {},
      {},
      { upsert: true, new: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());
    const token = cred.token;

    const result = await (async () => {
      switch (data.action) {
        case "getPrescription": {
          const response = await makeTaminRequest({
            path: `https://ap-test.tamin.ir/api/Pharmacy/DrugEpresc/GetActivePresc?patientNationalCode=${
              payload.patientNationalCode || "1234567891"
            }&trackingCode=${payload.trackingCode || ""}&PhaId=0000000920`,
            method: "GET",
            token,
          });
          return await response.json();
        }
        case "preCheckPrescription": {
          const response = await makeTaminRequest({
            path: "https://ap-test.tamin.ir/api/Pharmacy/DrugStore/PreCheckElectronicPresc",
            method: "POST",
            token,
            payload: {
              userInformation: {
                phaid: "0000000920",
                nationalCode: "1234567891",
                clientIp: "string",
              },
              patientNatCode: "1234567891",
              patientMobileNo: "09125475461",
              ...payload,
            },
          });
          return await response.json();
        }
        case "submitPrescription": {
          const response = await makeTaminRequest({
            path: "https://ap-test.tamin.ir/api/Pharmacy/DrugStore/PostPresc",
            method: "POST",
            token,
            payload: {
              userInformation: {
                phaid: "0000000920",
                nationalCode: "1234567891",
                clientIp: "string",
              },
              patientNatCode: "1234567891",
              patientMobileNo: "09125475461",
              ...payload,
            },
          });
          return await response.json();
        }
        case "getSubmittedPrescInfo": {
          const response = await makeTaminRequest({
            path: `https://ap-test.tamin.ir/api/Pharmacy/DrugStore/RequestByRegisterID?PhaId=0000000920&reqId=${payload.reqid || ""}`,
            method: "GET",
            token,
          });
          return await response.json();
        }
        case "removePrescription": {
          const response = await makeTaminRequest({
            path: "https://ap-test.tamin.ir/api/Pharmacy/DrugStore/RemovePresc",
            method: "POST",
            token,
            payload: { userInformation: { phaId: "0000000920" }, ...payload },
          });
          return await response.json();
        }
        case "referrPresc": {
          const response = await makeTaminRequest({
            path: "https://ap-test.tamin.ir/api/Pharmacy/DrugStore/RefferrRequest",
            method: "POST",
            token,
            payload: { userInformation: { phaId: "0000000920" }, ...payload },
          });
          return await response.json();
        }
        case "getDrugEquiv": {
          const response = await makeTaminRequest({
            path: "https://darmanapi.tamin.ir/api/Provider/GetDrugEquivalnet",
            method: "POST",
            token,
            payload: {
              drugCode: "00077",
              count: "10",
              PhaId: "0000000920",
              ...payload,
            },
          });
          return await response.json();
        }
        case "getAdditiveDrugs": {
          const response = await makeTaminRequest({
            path: "https://ap-test.tamin.ir/api/Pharmacy/Provider/GetAdditiveDrugs?PhaId=0000000920",
            method: "GET",
            token,
          });
          return await response.json();
        }
      }
    })();

    res.status(200).json({ message: "testPharmacyTamin", data: result });
  },
);

// ---------------------------------------------------------------- Clinic

const clinicTaminTestActions = [
  "getChallenge",
  "exchangeCode",
  "getTokenDate",
  "getPrescriptions",
  "submitPrescription",
] as const;

const clinicTaminTestSchema = z.strictObject({
  action: z.enum(clinicTaminTestActions),
  payload: z.record(z.string(), z.any()).optional(),
});

// Mirrors clinicController.ts: checkTaminClinicToken/clinicTaminCallback/
// getClinicTaminToken (OAuth, own credential shape - AdminClinicTaminCred
// instead of AdminTaminCred, same as ClinicTaminToken vs DoctorTaminCred in
// the real routes) and getPrescriptions/submitTaminClinicPrescription (the
// referral lookup/submit flow).
export const testClinicTamin: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success, error } =
      await clinicTaminTestSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError(error.message));
    const payload = data.payload || {};
    const cred = await AdminClinicTaminCred.findOneAndUpdate(
      {},
      {},
      { upsert: true, new: true },
    );

    const result = await (async () => {
      switch (data.action) {
        case "getChallenge": {
          const verifier = createCodeVerifier();
          const challenge = await toCodeChallenge(verifier);
          await AdminClinicTaminCred.findByIdAndUpdate(cred._id, {
            verifier,
            challenge,
          });
          return { challenge };
        }
        case "exchangeCode": {
          if (!cred.verifier)
            throw new AppError("ابتدا چالش (challenge) را دریافت کنید", 400);
          if (!payload.code || !payload.redirectUri)
            throw new BadInputError("code و redirectUri الزامی است");
          const token = await exchangeCode({
            code: payload.code,
            verifier: cred.verifier,
            redirectUri: payload.redirectUri,
          });
          await AdminClinicTaminCred.findByIdAndUpdate(cred._id, {
            token,
            tokenRefreshedAt: new Date(),
          });
          return { ok: true };
        }
        case "getTokenDate":
          return { tokenRefreshedAt: cred.tokenRefreshedAt };
        case "getPrescriptions": {
          if (!cred.token) throw new MissingTaminTokenError();
          const response = await makeTaminRequest({
            path: `https://darmanapi.tamin.ir/api/ParaClinic/ParaEPresc/RequestList?patientNationalCode=1234567891&trackingCode=${payload.trackingCode || ""}&parID=0000007303`,
            method: "GET",
            token: cred.token,
          });
          return await response.json();
        }
        case "submitPrescription": {
          if (!cred.token) throw new MissingTaminTokenError();
          const response = await makeTaminRequest({
            path: "https://darmanapi.tamin.ir/api/ParaClinic/ParaEPresc/RequestParPresc",
            method: "POST",
            token: cred.token,
            payload: {
              userInformation: {
                parID: "0000007303",
                nationalCode: "1234567891",
              },
              nationalcode: "1234567891",
              docMDID: "2000200092",
              ...payload,
            },
          });
          return await response.json();
        }
      }
    })();

    res.status(200).json({ message: "testClinicTamin", data: result });
  },
);

// ------------------------------------------------------------ ParaClinic

const paraClinicTaminTestActions = [
  "getPrescriptions",
  "precheckPrescription",
  "submitPrescription",
  "getPrescription",
  "deletePrescription",
  "registerDiagnosis",
  "registerPhysioSession",
] as const;

const paraClinicTaminTestSchema = z.strictObject({
  action: z.enum(paraClinicTaminTestActions),
  payload: z.record(z.string(), z.any()).optional(),
});

// Mirrors paraClinicController.ts's own `/tamin`, `/taminn`, `/tamin/physio`
// and `/tamin/session` routes, which (like pharmacy's) already borrow "any"
// DoctorTaminCred via findOne() with no filter - here that's
// AdminTaminCred instead, same singleton testDoctorTamin/testPharmacyTamin
// use.
export const testParaClinicTamin: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success, error } =
      await paraClinicTaminTestSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError(error.message));
    const payload = data.payload || {};
    const cred = await AdminTaminCred.findOneAndUpdate(
      {},
      {},
      { upsert: true, new: true },
    );
    if (!cred.token) return next(new MissingTaminTokenError());
    const token = cred.token;

    const result = await (async () => {
      switch (data.action) {
        case "getPrescriptions": {
          const response = await makeTaminRequest({
            path: `https://ap-test.tamin.ir/api/ParaClinic/ParaEPresc/RequestList?patientNationalCode=${
              payload.patientNationalCode || "1234567891"
            }&trackingCode=${payload.trackingCode || ""}&parID=0000007303`,
            method: "GET",
            token,
          });
          return await response.json();
        }
        case "precheckPrescription": {
          const response = await makeTaminRequest({
            path: "https://ap-test.tamin.ir/api/ParaClinic/ParaEPresc/PreCheckEPresc",
            method: "POST",
            token,
            payload: { userInformation: { parID: "0000007303" }, ...payload },
          });
          return await response.json();
        }
        case "submitPrescription": {
          const response = await makeTaminRequest({
            path: `https://ap-test.tamin.ir/api/ParaClinic/ParaEPresc/RequestParPresc${
              payload.physio ? "_Physio" : ""
            }`,
            method: "POST",
            token,
            payload: {
              userInformation: {
                parID: "0000007303",
                nationalCode: "1234567891",
                clientIp: "",
              },
              nationalcode: "1234567891",
              doC_MDID: "2000200092",
              tecH_MDID: "",
              patienT_MOBILE: "",
              asnad: false,
              ...payload,
            },
          });
          return await response.json();
        }
        case "getPrescription": {
          const response = await makeTaminRequest({
            path: `https://ap-test.tamin.ir/api/ParaClinic/ParaEPresc/RequestByRegisterID?parID=0000007303&requestID=${payload.requestID || ""}`,
            method: "GET",
            token,
          });
          return await response.json();
        }
        case "deletePrescription": {
          const response = await makeTaminRequest({
            path: "https://ap-test.tamin.ir/api/ParaClinic/ParaEPresc/DeleteParPresc",
            method: "POST",
            token,
            payload: { userInformation: { parID: "0000007303" }, ...payload },
          });
          return await response.json();
        }
        case "registerDiagnosis": {
          const response = await makeTaminRequest({
            path: "https://ap-test.tamin.ir/api/ParaClinic/ParaEPresc/RegisterTheDiagnosis",
            method: "POST",
            token,
            payload: {
              userInformation: { parID: "0000007303" },
              ISNORMAL: false,
              ST_DOCID: "0000101575",
              ...payload,
            },
          });
          return await response.json();
        }
        case "registerPhysioSession": {
          const response = await makeTaminRequest({
            path: "https://ap-test.tamin.ir/api/ParaClinic/ParaEPresc/RegisterSession_Physio",
            method: "POST",
            token,
            payload,
          });
          return await response.json();
        }
      }
    })();

    res.status(200).json({ message: "testParaClinicTamin", data: result });
  },
);
