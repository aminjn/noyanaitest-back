import express from "express";
import * as authController from "../Controllers/authController";
import * as adminWalletController from "../Controllers/adminWalletController";

// /api/v1/admin/wallet - one user's wallet: ledger and manual correction
// (2026-10). Money: full admins only.
const router = express.Router();

router.use(authController.protect, authController.restrictTo("admin"));

router.get("/:userId", adminWalletController.getUserWallet);
router.post("/:userId/adjust", adminWalletController.adjustUserWallet);

export default router;
