import { businessRouter } from "./businessRoutes";
import { moadianRouter } from "./moadianRoutes";
import { adminPayrollYears } from "../Controllers/payrollController";
import { adminApproveCampaign, adminGetCampaign } from "../Controllers/crmController";
import { ownerOfReq } from "../Controllers/businessController";
import { RequestHandler } from "express";
import { AccessLevelModel } from "../Models/AccessLevel";
import { NotFoundError } from "../Lib/AppError";
import express from "express";
import * as seoController from "../Controllers/seoController";
import { devToolsAllowed, devToolsGuard } from "../Lib/devToolsGuard";

import * as authController from "../Controllers/authController";
import * as adminController from "../Controllers/adminController";
import * as adminTaminController from "../Controllers/adminTaminController";
import * as uploadController from "../Controllers/uploadController";
import * as callController from "../Controllers/callController";
import * as adminFinanceController from "../Controllers/adminFinanceController";
import adminFinanceRouter from "./adminFinanceRouter";
import * as adminSmsController from "../Controllers/adminSmsController";
import * as adminDeliveryController from "../Controllers/adminDeliveryController";
import * as withdrawalController from "../Controllers/withdrawalController";
import * as autoController from "../Controllers/autoController";
import * as paymentController from "../Controllers/paymentController";
import * as adminDashboardController from "../Controllers/adminDashboardController";
import * as adminEntityController from "../Controllers/adminEntityController";
import * as adminUserController from "../Controllers/adminUserController";
import * as adminAuditController from "../Controllers/adminAuditController";
import * as translationController from "../Controllers/translationController";
import * as adminRequestsController from "../Controllers/adminRequestsController";
import * as adminMapController from "../Controllers/adminMapController";
import adminSupportRouter from "./adminSupportRouter";
import adminProviderRouter from "./adminProviderRouter";
import adminReservationRouter from "./adminReservationRouter";
import adminWalletRouter from "./adminWalletRouter";
import adminCallRouter from "./adminCallRouter";

const router = express.Router();

// support desk: tickets, contact requests, review moderation, SMS log
router.use("/support", adminSupportRouter);
// appointments back office, a user's wallet, call rooms (2026-10)
router.use("/reservations", adminReservationRouter);
router.use("/wallet", adminWalletRouter);
router.use("/calls", adminCallRouter);
const smsAdminOnly = [authController.protect, authController.restrictTo("admin")];

// update permission on the request model that :kind names
const permissionByKind =
  (models: Record<string, AccessLevelModel>): RequestHandler =>
  (req, res, next) => {
    const model = models[req.params.kind];
    if (!model) return next(new NotFoundError());
    return authController.hasPermission({ model, op: "update" })(req, res, next);
  };

router
  .route("/")
  .get(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    adminController.getMyAccessLevel,
  );

// whether the developer-tools hub may be shown (Lib/devToolsGuard.ts)
router.get(
  "/devtools/allowed",
  authController.protect,
  authController.restrictTo("admin"),
  (_req, res) =>
    res.status(200).json({ message: "devToolsAllowed", data: { allowed: devToolsAllowed() } }),
);

router
  .route("/dashboard")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminDashboardController.getDashboard,
  );

router
  .route("/doctorjoin/:kind/:nodeId/decide")
  .post(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    permissionByKind({ clinic: "DoctorJoinClinic", hospital: "DoctorJoinHospital" }),
    adminEntityController.decideDoctorJoin,
  );
router
  .route("/becomepharmacy/:nodeId/approve")
  .post(
    authController.protect,
    // staff who may edit these requests may also approve them (the button
    // is on the same page)
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "BecomePharmacyRequest", op: "update" }),
    adminEntityController.approveBecomePharmacy,
  );
router
  .route("/becomeclinic/:nodeId/approve")
  .post(
    authController.protect,
    // staff who may edit these requests may also approve them (the button
    // is on the same page)
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "BecomeClinicRequest", op: "update" }),
    adminEntityController.approveBecomeClinic,
  );
router
  .route("/becomehospital/:nodeId/approve")
  .post(
    authController.protect,
    // staff who may edit these requests may also approve them (the button
    // is on the same page)
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "BecomeHospitalRequest", op: "update" }),
    adminEntityController.approveBecomeHospital,
  );
router
  .route("/becomeParaClinic/:nodeId/approve")
  .post(
    authController.protect,
    // staff who may edit these requests may also approve them (the button
    // is on the same page)
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "BecomeParaClinicRequest", op: "update" }),
    adminEntityController.approveBecomeParaClinic,
  );
router
  .route("/becomeinsurance/:nodeId/approve")
  .post(
    authController.protect,
    // staff who may edit these requests may also approve them (the button
    // is on the same page)
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "BecomeInsuranceRequest", op: "update" }),
    adminEntityController.approveBecomeInsurance,
  );
router
  .route("/becomedoctor/:nodeId/approve")
  .post(
    authController.protect,
    // staff who may edit these requests may also approve them (the button
    // is on the same page)
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "BecomeDoctorRequest", op: "update" }),
    adminEntityController.approveBecomeDoctor,
  );

router
  .route("/entity/:kind/:nodeId")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminEntityController.getEntityOverview,
  );

// ---- one provider-verification queue (become / addition / join) ----
// Staff see the kinds their access level can read; each row links to that
// kind's own page, where it is approved. Reject (with a reason the applicant
// is told) and reopen are one-way and live here for every kind.
const staff = [authController.protect, authController.restrictTo("admin", "notadmin")];
const staffMaySeo = (op: "readAll" | "update") => [
  authController.protect,
  authController.restrictTo("admin", "notadmin"),
  authController.hasPermission({ model: "PageMeta", op }),
];
router.get("/requests", ...staff, adminRequestsController.listRequests);
// automatic SEO templates (2026-10): same right as the per-page SEO entries
router.get("/seo/templates", ...staffMaySeo("readAll"), seoController.listSeoTemplates);
router.put("/seo/template", ...staffMaySeo("update"), seoController.saveSeoTemplate);
router.delete("/seo/template", ...staffMaySeo("update"), seoController.resetSeoTemplate);
router.get("/seo/preview", ...staffMaySeo("readAll"), seoController.previewSeo);
router.get("/requests/counts", ...staff, adminRequestsController.countRequests);
router.post("/requests/:group/:kind/:nodeId/reject", ...staff, adminRequestsController.rejectRequest);
router.post("/requests/:group/:kind/:nodeId/reopen", ...staff, adminRequestsController.reopenRequest);
router.post(
  "/requests/:group/:kind/:nodeId/processing",
  ...staff,
  adminRequestsController.markRequestProcessing,
);

router
  .route("/inbox")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminDashboardController.getInbox,
  );

// User management. Listing/viewing follows the "User" access level so
// staff with it can use the page; changing roles and forcing a logout are
// full-admin only.
router
  .route("/users")
  .get(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "User", op: "readAll" }),
    adminUserController.listUsers,
  )
  .post(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "User", op: "write" }),
    adminUserController.createUser,
  );

router
  .route("/users/:nodeId")
  .get(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "User", op: "readOne" }),
    adminUserController.getUser,
  )
  .patch(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "User", op: "update" }),
    adminUserController.updateUser,
  )
  .delete(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "User", op: "delete" }),
    adminUserController.deleteUser,
  );

router
  .route("/users/:nodeId/status")
  .post(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "User", op: "update" }),
    adminUserController.setUserStatus,
  );

router
  .route("/users/:nodeId/identity/reset")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminUserController.resetUserIdentity,
  );

router
  .route("/users/:nodeId/role")
  .patch(
    authController.protect,
    authController.restrictTo("admin"),
    uploadController.upload.none(),
    adminUserController.setUserRole,
  );

router
  .route("/users/:nodeId/logout")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminUserController.logoutUserEverywhere,
  );

// UI text dictionary (all languages); same permission as the old
// TextContent dictionary.
router
  .route("/texts")
  .get(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "TextContent", op: "readAll" }),
    translationController.getAllTexts,
  )
  .patch(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "TextContent", op: "update" }),
    translationController.updateText,
  );

// Site languages on/off - full admin only.
router
  .route("/locales")
  .patch(
    authController.protect,
    authController.restrictTo("admin"),
    translationController.updateEnabledLocales,
  );

router
  .route("/audit")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminAuditController.listAuditLogs,
  );

router
  .route("/doctorprofile/:nodeId")
  .put(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.clearUserFromDoctorProfile,
  );

router
  .route("/clinic/:nodeId")
  .put(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.clearUserFromClinic,
  );

router
  .route("/hospital/:nodeId")
  .put(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.clearUserFromHospital,
  );

router
  .route("/insurance/:nodeId")
  .put(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.clearUserFromInsurance,
  );

// providers: suspend / reactivate, panel owner set / clear, doctor schedule
router.use(adminProviderRouter);

router
  .route("/notification/bulk")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["users"]),
    adminController.createNotifications,
  );

router
  .route("/call/create")
  .post(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "CallRoom", op: "write" }),
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["participantIds"]),
    callController.createCall,
  );

router.post(
  "/addition/:kind/:nodeId/create",
  authController.protect,
  authController.restrictTo("admin", "notadmin"),
  permissionByKind({
    clinic: "ClinicAdditionRequest",
    hospital: "HospitalAdditionRequest",
    insurance: "InsuranceAdditionRequest",
    pharmacy: "PharmacyAdditionRequest",
  }),
  adminEntityController.createFromAddition,
);

// ---- SMS gateway settings (super admin) ----
router.get("/sms/settings", ...smsAdminOnly, adminSmsController.getSmsSettings);
router.post(
  "/sms/settings",
  ...smsAdminOnly,
  uploadController.upload.none(),
  adminSmsController.saveSmsSettings,
);
router.get(
  "/sms/localizedPatterns",
  ...smsAdminOnly,
  adminSmsController.getLocalizedSmsPatterns,
);
router.post(
  "/sms/localizedPatterns",
  ...smsAdminOnly,
  adminSmsController.saveLocalizedSmsPatterns,
);
router.post(
  "/sms/test",
  ...smsAdminOnly,
  uploadController.upload.none(),
  adminSmsController.testSms,
);

// ---- delivery (Tapsi flat fee, default origin) - super admin ----
router.get(
  "/delivery/settings",
  ...smsAdminOnly,
  adminDeliveryController.getDeliverySettingsAdmin,
);
router.post(
  "/delivery/settings",
  ...smsAdminOnly,
  uploadController.upload.none(),
  adminDeliveryController.saveDeliverySettingsAdmin,
);

// ---- money pages (2026-09): orders, wallet ledger, gateway payments ----
// Full admins, and staff whose access level grants Order / Finance
// (2026-10: money work can be delegated, each action still audited).
const staffMay = (model: AccessLevelModel, op: "readAll" | "update") => [
  authController.protect,
  authController.restrictTo("admin", "notadmin"),
  authController.hasPermission({ model, op }),
];
router.get("/finance/orders", ...staffMay("Order", "readAll"), adminFinanceController.listOrders);
router.get(
  "/finance/transactions",
  ...staffMay("Finance", "readAll"),
  adminFinanceController.listTransactions,
);
router.get("/finance/payments", ...staffMay("Finance", "readAll"), adminFinanceController.listPayments);
router.get(
  "/finance/withdrawals",
  ...staffMay("Finance", "readAll"),
  withdrawalController.adminListWithdrawals,
);
router.post(
  "/finance/withdrawals/:nodeId/decide",
  ...staffMay("Finance", "update"),
  uploadController.upload.none(),
  withdrawalController.adminDecideWithdrawal,
);
router.post(
  "/finance/payments/:nodeId/resolve",
  ...staffMay("Finance", "update"),
  adminFinanceController.resolvePayment,
);
// the platform's own books (2026-10, Lib/business): commission, VAT, what
// is owed to users and providers
router.use(
  "/finance/biz",
  businessRouter({
    ownerOf: ownerOfReq("platform"),
    read: staffMay("Finance", "readAll"),
    write: staffMay("Finance", "update"),
  }),
);
// Noyan's own Moadian link (2026-10, Lib/moadian): its key and memory id,
// and the invoices it issues to providers (plans, campaign SMS, the
// monthly commission)
router.use(
  "/finance/moadian",
  moadianRouter({
    ownerOf: ownerOfReq("platform"),
    read: staffMay("Finance", "readAll"),
    write: staffMay("Finance", "update"),
  }),
);
// the payroll rules of each Jalali year (2026-10, Lib/business/payroll.ts):
// minimum wage, allowances, insurance shares and the salary-tax brackets
router.get("/finance/payroll-years", ...staffMay("Finance", "readAll"), adminPayrollYears.list);
router.put("/finance/payroll-years/:year", ...staffMay("Finance", "update"), adminPayrollYears.save);
router.delete("/finance/payroll-years/:year", ...staffMay("Finance", "update"), adminPayrollYears.remove);
// SMS campaigns (2026-10, Lib/business/campaign.ts): the request's detail
// and its approval; reject and reopen are the queue's (/requests)
router.get("/campaigns/:id", ...staffMay("Advertisement", "readAll"), adminGetCampaign);
router.post("/campaigns/:id/approve", ...staffMay("Advertisement", "update"), adminApproveCampaign);
// order detail + actions, invoices, subscriptions (Routers/adminFinanceRouter.ts)
router.use("/finance", adminFinanceRouter);

router
  .route("/call/:nodeId/end")
  .post(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "CallRoom", op: "update" }),
    callController.adminEndCall,
  );

router
  .route("/tamin/serviceType")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminServiceTypes,
  );

router
  .route("/tamin/prescriptionType")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminPrescriptionTypes,
  );

router
  .route("/tamin/service")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminServices,
  );

router
  .route("/tamin/parTaref")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminParTarefs,
  );

router
  .route("/tamin/drugUsage")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminDrugUsages,
  );

router
  .route("/tamin/drugInstruction")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminDrugInstructions,
  );

router
  .route("/tamin/drugAmount")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminDrugAmounts,
  );

router
  .route("/tamin/phPlan")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminPhPlans,
  );

router
  .route("/tamin/phIllness")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminPhIllnesses,
  );

router
  .route("/tamin/icid")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminIcids,
  );

router
  .route("/tamin/complaint")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminComplaints,
  );

router
  .route("/tamin/spec")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.refreshTaminSpecs,
  );

// ---- Snapp integration test page (2026-09) ----
// JSON bodies only (app.ts's global express.json()) - no uploadController
// needed since these never take file fields, unlike most other admin routes
// above.
router
  .route("/snapp/test")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    // balance/price/status reads stay open; rides and payments are real
    devToolsGuard((req) =>
      ["requestRide", "cancelRide", "payment"].includes(req.body?.action),
    ),
    adminController.snappTest,
  );

// Tamin sandbox test console (2026-09) - see
// Controllers/adminTaminController.ts and Controllers/featureGateController.ts.
// Same shape as "/snapp/test" right above: one dispatcher route per org
// type, `{ action, payload }` in, the matching Tamin sandbox response out.
router
  .route("/tamin/doctor/test")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    devToolsGuard(),
    adminTaminController.testDoctorTamin,
  );

router
  .route("/tamin/pharmacy/test")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    devToolsGuard(),
    adminTaminController.testPharmacyTamin,
  );

router
  .route("/tamin/clinic/test")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    devToolsGuard(),
    adminTaminController.testClinicTamin,
  );

router
  .route("/tamin/paraClinic/test")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    devToolsGuard(),
    adminTaminController.testParaClinicTamin,
  );

// ---- SEP (Saman) online payment test page (2026-09) ----
// Starts a real wallet top-up for the logged-in admin through the normal
// gateway flow - see paymentController.adminStartSepTest.
router
  .route("/sep/test")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    paymentController.adminGetSepTest,
  )
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    devToolsGuard(),
    paymentController.adminStartSepTest,
  );

router
  .route("/snapp/delivery")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.adminGetDeliveryStatus,
  )
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminController.adminDispatchDelivery,
  );

// ---- NexaMap (super admin only): settings with a write-only key, status,
// the divisions import and the providers' batch geocode (background jobs,
// polled through /map/jobs/:kind) ----
const mapAdminOnly = [authController.protect, authController.restrictTo("admin")];
router
  .route("/map/settings")
  .get(...mapAdminOnly, adminMapController.getMapSettings)
  .post(...mapAdminOnly, adminMapController.saveMapSettings);
router.post("/map/test", ...mapAdminOnly, adminMapController.testMapConnection);
router.get("/map/status", ...mapAdminOnly, adminMapController.getMapStatus);
router.get("/map/jobs/:kind", ...mapAdminOnly, adminMapController.getMapJobStatus);
router.post("/map/divisions/sync", ...mapAdminOnly, adminMapController.syncDivisions);
router.post("/map/geocode/batch", ...mapAdminOnly, adminMapController.batchGeocodeProviders);

export default router;
