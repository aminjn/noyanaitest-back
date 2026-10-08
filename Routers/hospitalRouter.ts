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
import * as hospitalController from "../Controllers/hospitalController";
import * as aclController from "../Controllers/aclController";
import * as activeCentreController from "../Controllers/activeCentreController";
import * as centerDoctorsController from "../Controllers/centerDoctorsController";
import * as uploadController from "../Controllers/uploadController";
import * as autoController from "../Controllers/autoController";

const router = express.Router({ mergeParams: true });

router.use(authControler.protect);

// Note on hospitalController.requireLicenseModule(...) below (2026-09): it's
// chained right after every aclController.useHospital(...) call so req.hospital
// is already set, mirroring doctorRouter.ts's/pharmacyRouter.ts's own
// comment. Two deliberate omissions:
//  - "/" (getMyHospitalProfile) - this is the baseline profile fetch the
//    whole panel shell depends on to even know who the hospital is, same
//    "always visible, never gated" treatment HospitalPanelSidebar itself
//    gives the "profile" link (show: true, no hasAccess check).
//  - "/license" and "/license/:nodeId" - gating the license catalog/purchase
//    routes behind a license module would be circular: a hospital with no
//    license (or whose default tier doesn't include "licenses") could never
//    reach the one page that lets them fix that.
// "/request" has no aclController.useHospital(...) at all, since it runs
// before a Hospital profile even exists, so there's no req.hospital yet to
// check a license against - left untouched.

router
  .route("/")
  .get(aclController.useHospital(), hospitalController.getMyHospitalProfile)
  .post(
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "hospital" }),
    hospitalController.becomeAHospital,
  );

router.route("/request").get(hospitalController.getMyBecomeHospitalRequest);

// the centre switcher (2026-10, one account can own several hospitals;
// Lib/activeCentre.ts): the centres this account can open, and the switch.
// Not behind useAcl: it is how the panel picks the centre useAcl resolves.
router.route("/centres").get(activeCentreController.getMyCentres("hospital"));
router
  .route("/centres/active")
  .post(uploadController.upload.none(), activeCentreController.setMyActiveCentre("hospital"));

router
  .route("/profile")
  .post(
    aclController.useHospital("mutateProfile"),
    hospitalController.requireLicenseModule("profile"),
    uploadController.upload.any(),
    uploadController.saveUplaodsToBody({ name: "hospital" }),
    autoController.mutateCompoundFields([
      "tags",
      "insurances",
      "location",
      "services",
      "certificates",
    ]),
    hospitalController.updateMyHospitalProfile,
  );

router
  .route("/license")
  .get(
    aclController.useHospital("readLicenses"),
    hospitalController.getMyLicenseOverview,
  );

router
  .route("/license/modules")
  .get(aclController.useHospital(), hospitalController.getMyLicenseModules);

// "See all plans" page (2026-09) - every isActive BaseHospitalLicense
// regardless of isPrimary, gated the same as "/license" above. Registered
// before "/license/:nodeId" so "all" isn't swallowed as a nodeId.
router
  .route("/license/all")
  .get(
    aclController.useHospital("readLicenses"),
    hospitalController.getActiveLicenses,
  );

// Dashboard-home widget fetch (2026-09) - the hospital's own currently
// assigned HospitalProfileLicense, gated like "/license" above. Registered
// before "/license/:nodeId" so "current" isn't swallowed as a nodeId.
router
  .route("/license/current")
  .get(
    aclController.useHospital("readLicenses"),
    hospitalController.getMyCurrentLicense,
  );

// Purchasing a license isn't gated by requireLicenseModule or a specific
// action like "readLicenses" - this spends the hospital's own wallet balance,
// so a generic aclController.useHospital() presence check is enough, same as
// doctorRouter.ts's/pharmacyRouter.ts's own purchase route. Not gated by
// requireLicenseModule for the same circularity reason as "/license" above.
// The GET on the same path (a single plan's own detail page) is gated like
// "/license" above, since it's just another read of the catalog.
router
  .route("/license/:nodeId")
  .get(
    aclController.useHospital("readLicenses"),
    hospitalController.getLicenseById,
  )
  .post(aclController.useHospital(true), hospitalController.purchaseLicense);


// the center's own doctors: members + join requests (owner only)
router
  .route("/reservation/stats")
  .get(aclController.useHospital(), centerDoctorsController.getMyVisitStats("hospital"));

// the centre's agenda: visits at the offices its doctors linked to it
router
  .route("/reservation")
  .get(aclController.useHospital("readReservations"), centerDoctorsController.getMyReservations("hospital"));
router
  .route("/doctor/search")
  .get(aclController.useHospital(true), centerDoctorsController.searchDoctorsToInvite("hospital"));
router
  .route("/doctor/invite")
  .post(aclController.useHospital(true), centerDoctorsController.inviteDoctor("hospital"));
// the centre withdraws an invite the doctor has not answered
router
  .route("/doctor/invite/:nodeId")
  .delete(aclController.useHospital(true), centerDoctorsController.withdrawInvite("hospital"));
// the centre's own departments (wards, for a hospital)
router
  .route("/department")
  .post(aclController.useHospital(true), centerDoctorsController.createMyDepartment("hospital"));
router
  .route("/department/:nodeId")
  .patch(aclController.useHospital(true), centerDoctorsController.updateMyDepartment("hospital"))
  .delete(aclController.useHospital(true), centerDoctorsController.deleteMyDepartment("hospital"));

router
  .route("/doctor")
  .get(aclController.useHospital(true), centerDoctorsController.getMyDoctors("hospital"));
router
  .route("/doctor/request/:nodeId")
  .post(aclController.useHospital(true), centerDoctorsController.answerJoinRequest("hospital"));
router
  .route("/doctor/:nodeId")
  // which department a member works in
  .patch(aclController.useHospital(true), centerDoctorsController.setMemberDepartment("hospital"))
  .delete(aclController.useHospital(true), centerDoctorsController.removeMyDoctor("hospital"));

// wallet, income, license spend and transactions (Lib/orgFinance.ts)
router
  .route("/finance")
  .get(aclController.useHospital("readFinance"), orgFinanceController.getMyOrgFinance("hospital"));

// published reviews and the average score (read-only)
router
  .route("/review")
  .get(aclController.useHospital("readReviews"), orgFinanceController.getMyOrgReviews("hospital"));
// the owner answers a published review publicly, once
router
  .route("/review/:nodeId/reply")
  .post(aclController.useHospital(true), uploadController.upload.none(), orgFinanceController.replyToMyOrgReview("hospital"));

// Noyan Business accounting (2026-10, Lib/business): the hospital's own books.
// Read with readFinance, write with manageAccounting; the plan's
// "accounting" module opens it.
router.use(
  "/biz",
  businessRouter({
    ownerOf: ownerOfReq("hospital"),
    read: [aclController.useHospital("readFinance"), hospitalController.requireLicenseModule("accounting")],
    write: [aclController.useHospital("manageAccounting"), hospitalController.requireLicenseModule("accounting")],
    approve: [aclController.useHospital("approveVouchers"), hospitalController.requireLicenseModule("accounting")],
  }),
);

// Noyan Business inventory and purchasing (2026-10, Lib/business/inventory.ts
// and purchase.ts): stock, batches, suppliers and purchases. Read with
// readInventory, write with manageInventory; the plan's "inventory" module
// opens it.
router.use(
  "/inv",
  inventoryRouter({
    ownerOf: ownerOfReq("hospital"),
    read: [aclController.useHospital("readInventory"), hospitalController.requireLicenseModule("inventory")],
    write: [aclController.useHospital("manageInventory"), hospitalController.requireLicenseModule("inventory")],
  }),
);

// Noyan Business payroll (2026-10, Lib/business/payroll.ts): employees, the
// month's payslips with insurance and tax, and their payments. Read with
// readPayroll, write with managePayroll; the plan's "payroll" module opens it.
router.use(
  "/payroll",
  payrollRouter({
    ownerOf: ownerOfReq("hospital"),
    read: [aclController.useHospital("readPayroll"), hospitalController.requireLicenseModule("payroll")],
    write: [aclController.useHospital("managePayroll"), hospitalController.requireLicenseModule("payroll")],
  }),
);

// Noyan Business CRM and SMS campaigns (2026-10, Lib/business/crm.ts and
// campaign.ts): patients and customers, follow-ups, campaigns. Read with
// readCrm, write with manageCrm, submit a campaign with sendCampaigns; the
// plan's "crm" module opens it.
router.use(
  "/crm",
  crmRouter({
    ownerOf: ownerOfReq("hospital"),
    read: [aclController.useHospital("readCrm"), hospitalController.requireLicenseModule("crm")],
    write: [aclController.useHospital("manageCrm"), hospitalController.requireLicenseModule("crm")],
    send: [aclController.useHospital("sendCampaigns"), hospitalController.requireLicenseModule("crm")],
  }),
);

// the panel's one approval queue («کارتابل», 2026-10): finance requests,
// sales approvals, returns and workflow steps (Routers/kartablRoutes.ts)
router.use("/kartabl", kartablRouter({ ownerOf: ownerOfReq("hospital"), member: aclController.useHospital() }));

// Noyan Business Moadian (2026-10, Lib/moadian): the electronic invoice
// link (key, memory id, item ids) and the invoices made from paid visits
// and sales. Read with readMoadian, change with manageMoadian; the plan's
// "moadian" module opens it.
router.use(
  "/moadian",
  moadianRouter({
    ownerOf: ownerOfReq("hospital"),
    read: [aclController.useHospital("readMoadian"), hospitalController.requireLicenseModule("moadian")],
    write: [aclController.useHospital("manageMoadian"), hospitalController.requireLicenseModule("moadian")],
  }),
);

export default router;
