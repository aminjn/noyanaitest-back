import express from "express";
import * as authController from "../Controllers/authController";
import * as pro from "../Controllers/patientProController";
import { localizeResponse } from "../Lib/i18n/localizeResponse";
import { stripPrivateFields } from "../Lib/stripPrivateFields";

// «پرو» for patients (2026-10): /api/v1/pro. The super admin's side is
// mounted under /api/v1/admin/pro (Routers/adminRouter.ts), so it is
// audited like every admin write.
const router = express.Router();

router.get("/pricing", stripPrivateFields, localizeResponse, pro.getProPricing);
router.get("/me", authController.protect, localizeResponse, pro.getMyPro);
router.post("/purchase", authController.protect, pro.purchaseMyPro);
router.post("/quote/booking", authController.protect, pro.quoteBooking);

export const adminProRouter = express.Router();
const adminOnly = [authController.protect, authController.restrictTo("admin")];
const staffMay = (op: "readAll" | "update") => [
  authController.protect,
  authController.restrictTo("admin", "notadmin"),
  authController.hasPermission({ model: "Finance", op }),
];
adminProRouter.get("/plan", ...adminOnly, pro.adminGetProPlan);
adminProRouter.post("/plan", ...adminOnly, pro.adminUpdateProPlan);
adminProRouter.get("/subscribers", ...staffMay("readAll"), pro.adminListSubscribers);
adminProRouter.get("/user/:userId", ...staffMay("readAll"), pro.adminGetUserPro);
adminProRouter.post("/user/:userId/grant", ...staffMay("update"), pro.adminGrantPro);
adminProRouter.post("/subscription/:nodeId/cancel", ...staffMay("update"), pro.adminCancelProSubscription);

export default router;
