import express from "express";
import * as authController from "../Controllers/authController";
import * as adminWalletController from "../Controllers/adminWalletController";

// /api/v1/admin/wallet - one user's wallet: ledger and manual correction
// (2026-10). Reading follows the "Finance" access level - the same staff
// already read every user's rows in /admin/finance/transactions; a manual
// correction creates or removes money, so it stays full-admin only.
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
  authController.restrictTo("admin"),
  adminWalletController.adjustUserWallet,
);

export default router;
