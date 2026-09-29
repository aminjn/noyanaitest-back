import express from "express";

import * as authController from "../Controllers/authController";
import * as adminController from "../Controllers/adminController";
import * as adminTaminController from "../Controllers/adminTaminController";
import * as uploadController from "../Controllers/uploadController";
import * as callController from "../Controllers/callController";
import * as autoController from "../Controllers/autoController";
import * as paymentController from "../Controllers/paymentController";
import * as adminDashboardController from "../Controllers/adminDashboardController";
import * as adminEntityController from "../Controllers/adminEntityController";
import * as adminUserController from "../Controllers/adminUserController";
import * as adminAuditController from "../Controllers/adminAuditController";
import * as translationController from "../Controllers/translationController";

const router = express.Router();

router
  .route("/")
  .get(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    adminController.getMyAccessLevel,
  );

router
  .route("/dashboard")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminDashboardController.getDashboard,
  );

router
  .route("/becomepharmacy/:nodeId/approve")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminEntityController.approveBecomePharmacy,
  );
router
  .route("/becomeclinic/:nodeId/approve")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminEntityController.approveBecomeClinic,
  );
router
  .route("/becomehospital/:nodeId/approve")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminEntityController.approveBecomeHospital,
  );
router
  .route("/becomeParaClinic/:nodeId/approve")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminEntityController.approveBecomeParaClinic,
  );
router
  .route("/becomeinsurance/:nodeId/approve")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminEntityController.approveBecomeInsurance,
  );
router
  .route("/becomedoctor/:nodeId/approve")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminEntityController.approveBecomeDoctor,
  );

router
  .route("/entity/:kind/:nodeId")
  .get(
    authController.protect,
    authController.restrictTo("admin"),
    adminEntityController.getEntityOverview,
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
  );

router
  .route("/users/:nodeId")
  .get(
    authController.protect,
    authController.restrictTo("admin", "notadmin"),
    authController.hasPermission({ model: "User", op: "readOne" }),
    adminUserController.getUser,
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
    authController.restrictTo("admin"),
    uploadController.upload.none(),
    autoController.mutateCompoundFields(["participantIds"]),
    callController.createCall,
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
    adminTaminController.testDoctorTamin,
  );

router
  .route("/tamin/pharmacy/test")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminTaminController.testPharmacyTamin,
  );

router
  .route("/tamin/clinic/test")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
    adminTaminController.testClinicTamin,
  );

router
  .route("/tamin/paraClinic/test")
  .post(
    authController.protect,
    authController.restrictTo("admin"),
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

export default router;
