import express from "express";

import * as aclController from "../Controllers/aclController";
import * as uploadController from "../Controllers/uploadController";
import * as authController from "../Controllers/authController";
import * as prescriptionController from "../Controllers/prescriptionController";

const router = express.Router();

router.use(authController.protect, (req, res, next) => {
  console.log("hit");
  next();
});

export default router;
