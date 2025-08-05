import express from "express";

import * as authController from "../Controllers/authController";
import * as financeController from "../Controllers/financeController";

const router = express.Router();

router.route("/").get(authController.protect, financeController.getMyBalance);

export default router;
