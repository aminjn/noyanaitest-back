import { businessRouter } from "./businessRoutes";
import { payrollRouter } from "./payrollRoutes";
import { crmRouter } from "./crmRoutes";
import { kartablRouter } from "./kartablRoutes";
import { moadianRouter } from "./moadianRoutes";
import { inventoryRouter } from "./inventoryRoutes";
import { ownerOfReq } from "../Controllers/businessController";
import express from "express";
import * as orgFinanceController from "../Controllers/orgFinanceController";

import * as authControler from "../Controllers/authController";
import * as clinicController from "../Controllers/clinicController";
import * as aclController from "../Controllers/aclController";
import * as activeCentreController from "../Controllers/activeCentreController";
import * as centerDoctorsController from "../Controllers/centerDoctorsController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";
import * as featureGateController from "../Controllers/featureGateController";

const router = express.Router({ mergeParams: true });

router.use(authControler.protect);

// Note on clinicController.requireLicenseModule(...) below (2026-09): it's
// chained right after every aclController.useClinic(...) call so req.clinic
// is already set, mirroring doctorRouter.ts's/pharmacyRouter.ts's own
// comment. Two deliberate omissions:
//  - "/" (getMyClinicProfile) - this is the baseline profile fetch the
//    whole panel shell depends on to even know who the clinic is, same
//    "always visible, never gated" treatment ClinicPanelSidebar itself
//    gives the "profile" link (show: true, no hasAccess check).
//  - "/license" and "/license/:nodeId" - gating the license catalog/purchase
//    routes behind a license module would be circular: a clinic with no
//    license (or whose default tier doesn't include "licenses") could never
//    reach the one page that lets them fix that.
// "/request" has no aclController.useClinic(...) at all, since it runs
// before a Clinic profile even exists, so there's no req.clinic yet to
// check a license against - left untouched.

router
  .route("/")
  .get(aclController.useClinic(), clinicController.getMyClinicProfile)
  .post(
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "clinic" }),
    clinicController.becomeAClinic,
  );

router.route("/request").get(clinicController.getMyBecomeClinicRequest);

// the centre switcher (2026-10, one account can own several clinics;
// Lib/activeCentre.ts): the centres this account can open, and the switch.
// Not behind useAcl: it is how the panel picks the centre useAcl resolves.
router.route("/centres").get(activeCentreController.getMyCentres("clinic"));
router
  .route("/centres/active")
  .post(uploadController.upload.none(), activeCentreController.setMyActiveCentre("clinic"));

router
  .route("/profile")
  .post(
    aclController.useClinic("mutateProfile"),
    clinicController.requireLicenseModule("profile"),
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "clinic" }),
    autoController.mutateCompoundFields([
      "tags",
      "insurances",
      "location",
      "services",
      "certificates",
    ]),
    clinicController.updateMyClinicProfile,
  );

router
  .route("/taminSpec")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useClinic(),
    clinicController.requireLicenseModule("prescriptions"),
    clinicController.getTaminSpecs,
  );

router
  .route("/tamin")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useClinic(),
    clinicController.requireLicenseModule("prescriptions"),
    clinicController.checkTaminClinicToken,
  )
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useClinic(),
    clinicController.requireLicenseModule("prescriptions"),
    clinicController.clinicTaminCallback,
  );

router
  .route("/tamin/token")
  .get(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useClinic(),
    clinicController.requireLicenseModule("prescriptions"),
    clinicController.getClinicTaminToken,
  );

router
  .route("/prescription")
  .post(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useClinic(),
    clinicController.requireLicenseModule("prescriptions"),
    uploadController.upload.none(),
    clinicController.getPrescriptions,
  )
  .put(
    featureGateController.blockTaminEndUserAccess, // [tamin-lockout]
    aclController.useClinic(),
    clinicController.requireLicenseModule("prescriptions"),
    uploadController.upload.none(),
    clinicController.submitTaminClinicPrescription,
  );

router
  .route("/license")
  .get(
    aclController.useClinic("readLicenses"),
    clinicController.getMyLicenseOverview,
  );

router
  .route("/license/modules")
  .get(aclController.useClinic(), clinicController.getMyLicenseModules);

// "See all plans" page (2026-09) - every isActive BaseClinicLicense
// regardless of isPrimary, gated the same as "/license" above. Registered
// before "/license/:nodeId" so "all" isn't swallowed as a nodeId.
router
  .route("/license/all")
  .get(
    aclController.useClinic("readLicenses"),
    clinicController.getActiveLicenses,
  );

// Dashboard-home widget fetch (2026-09) - the clinic's own currently
// assigned ClinicProfileLicense, gated like "/license" above. Registered
// before "/license/:nodeId" so "current" isn't swallowed as a nodeId.
router
  .route("/license/current")
  .get(
    aclController.useClinic("readLicenses"),
    clinicController.getMyCurrentLicense,
  );

// Purchasing a license isn't gated by requireLicenseModule or a specific
// action like "readLicenses" - this spends the clinic's own wallet balance,
// so a generic aclController.useClinic() presence check is enough, same as
// doctorRouter.ts's/pharmacyRouter.ts's own purchase route. Not gated by
// requireLicenseModule for the same circularity reason as "/license" above.
// The GET on the same path (a single plan's own detail page) is gated like
// "/license" above, since it's just another read of the catalog.
router
  .route("/license/:nodeId")
  .get(
    aclController.useClinic("readLicenses"),
    clinicController.getLicenseById,
  )
  .post(aclController.useClinic(true), clinicController.purchaseLicense);


// the center's own doctors: members + join requests (owner only)
router
  .route("/reservation/stats")
  .get(aclController.useClinic(), centerDoctorsController.getMyVisitStats("clinic"));

// the centre's agenda: visits at the offices its doctors linked to it
router
  .route("/reservation")
  .get(aclController.useClinic("readReservations"), centerDoctorsController.getMyReservations("clinic"));
router
  .route("/doctor/search")
  .get(aclController.useClinic(true), centerDoctorsController.searchDoctorsToInvite("clinic"));
router
  .route("/doctor/invite")
  .post(aclController.useClinic(true), centerDoctorsController.inviteDoctor("clinic"));
// the centre withdraws an invite the doctor has not answered
router
  .route("/doctor/invite/:nodeId")
  .delete(aclController.useClinic(true), centerDoctorsController.withdrawInvite("clinic"));
// the centre's own departments (wards, for a hospital)
router
  .route("/department")
  .post(aclController.useClinic(true), centerDoctorsController.createMyDepartment("clinic"));
router
  .route("/department/:nodeId")
  .patch(aclController.useClinic(true), centerDoctorsController.updateMyDepartment("clinic"))
  .delete(aclController.useClinic(true), centerDoctorsController.deleteMyDepartment("clinic"));

router
  .route("/doctor")
  .get(aclController.useClinic(true), centerDoctorsController.getMyDoctors("clinic"));
router
  .route("/doctor/request/:nodeId")
  .post(aclController.useClinic(true), centerDoctorsController.answerJoinRequest("clinic"));
router
  .route("/doctor/:nodeId")
  // which department a member works in
  .patch(aclController.useClinic(true), centerDoctorsController.setMemberDepartment("clinic"))
  .delete(aclController.useClinic(true), centerDoctorsController.removeMyDoctor("clinic"));

// wallet, income, license spend and transactions (Lib/orgFinance.ts)
router
  .route("/finance")
  .get(aclController.useClinic("readFinance"), orgFinanceController.getMyOrgFinance("clinic"));

// published reviews and the average score (read-only)
router
  .route("/review")
  .get(aclController.useClinic("readReviews"), orgFinanceController.getMyOrgReviews("clinic"));
// the owner answers a published review publicly, once
router
  .route("/review/:nodeId/reply")
  .post(aclController.useClinic(true), uploadController.upload.none(), orgFinanceController.replyToMyOrgReview("clinic"));

// Noyan Business accounting (2026-10, Lib/business): the clinic's own books.
// Read with readFinance, write with manageAccounting; the plan's
// "accounting" module opens it.
router.use(
  "/biz",
  businessRouter({
    ownerOf: ownerOfReq("clinic"),
    read: [aclController.useClinic("readFinance"), clinicController.requireLicenseModule("accounting")],
    write: [aclController.useClinic("manageAccounting"), clinicController.requireLicenseModule("accounting")],
    approve: [aclController.useClinic("approveVouchers"), clinicController.requireLicenseModule("accounting")],
  }),
);

// Noyan Business inventory and purchasing (2026-10, Lib/business/inventory.ts
// and purchase.ts): stock, batches, suppliers and purchases. Read with
// readInventory, write with manageInventory; the plan's "inventory" module
// opens it.
router.use(
  "/inv",
  inventoryRouter({
    ownerOf: ownerOfReq("clinic"),
    read: [aclController.useClinic("readInventory"), clinicController.requireLicenseModule("inventory")],
    write: [aclController.useClinic("manageInventory"), clinicController.requireLicenseModule("inventory")],
  }),
);

// Noyan Business payroll (2026-10, Lib/business/payroll.ts): employees, the
// month's payslips with insurance and tax, and their payments. Read with
// readPayroll, write with managePayroll; the plan's "payroll" module opens it.
router.use(
  "/payroll",
  payrollRouter({
    ownerOf: ownerOfReq("clinic"),
    read: [aclController.useClinic("readPayroll"), clinicController.requireLicenseModule("payroll")],
    write: [aclController.useClinic("managePayroll"), clinicController.requireLicenseModule("payroll")],
  }),
);

// Noyan Business CRM and SMS campaigns (2026-10, Lib/business/crm.ts and
// campaign.ts): patients and customers, follow-ups, campaigns. Read with
// readCrm, write with manageCrm, submit a campaign with sendCampaigns; the
// plan's "crm" module opens it.
router.use(
  "/crm",
  crmRouter({
    ownerOf: ownerOfReq("clinic"),
    read: [aclController.useClinic("readCrm"), clinicController.requireLicenseModule("crm")],
    write: [aclController.useClinic("manageCrm"), clinicController.requireLicenseModule("crm")],
    send: [aclController.useClinic("sendCampaigns"), clinicController.requireLicenseModule("crm")],
  }),
);

// the panel's one approval queue («کارتابل», 2026-10): finance requests,
// sales approvals, returns and workflow steps (Routers/kartablRoutes.ts)
router.use("/kartabl", kartablRouter({ ownerOf: ownerOfReq("clinic"), member: aclController.useClinic() }));

// Noyan Business Moadian (2026-10, Lib/moadian): the electronic invoice
// link (key, memory id, item ids) and the invoices made from paid visits
// and sales. Read with readMoadian, change with manageMoadian; the plan's
// "moadian" module opens it.
router.use(
  "/moadian",
  moadianRouter({
    ownerOf: ownerOfReq("clinic"),
    read: [aclController.useClinic("readMoadian"), clinicController.requireLicenseModule("moadian")],
    write: [aclController.useClinic("manageMoadian"), clinicController.requireLicenseModule("moadian")],
  }),
);

export default router;
