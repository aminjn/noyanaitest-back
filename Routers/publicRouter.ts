import express from "express";

import * as publicController from "../Controllers/publicController";

const router = express.Router();

router.route("/site").get(publicController.getSite);

router.route("/blog").get(publicController.getBlogs);

router.route("/blog/:nodeId").get(publicController.getBlog);

router.route("/selectspeciality").get(publicController.getSpecialityOptions);

export default router;
