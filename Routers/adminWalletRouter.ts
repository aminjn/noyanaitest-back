import express from "express";
import * as authController from "../Controllers/authController";
import * as adminWalletController from "../Controllers/adminWalletController";

// /api/v1/admin/wallet - one user's wallet: ledger and manual correction
// (2026-10). Reading follows the "Finance" access level - the same staff
// already read every user's rows in /admin/finance/transactions. A manual
// correction creates or removes money: full admins, and (2026-10 owner
// decision) staff whose access level has Finance "update" - the finance
// team, as in Doctolib's / Stripe's back offices. Every correction keeps its
// trail: the ledger row carries adminBy + the written reason, and the admin
// audit log (Services/adminAudit.ts) records who did it, amount and direction.
const router = express.Router();

router.get(
  "/:userId",
  authController.protect,
  authController.restrictTo("admin", "notadmin"),
  authController.hasPermission({ model: "Finance", op: "readAll" }),
  adminWalletController.getUserWallet,
);
router.post(
  "/:userId/adjust",
  authController.protect,
  authController.restrictTo("admin", "notadmin"),
  authController.hasPermission({ model: "Finance", op: "update" }),
  adminWalletController.adjustUserWallet,
);

export default router;
