import express from "express";

import * as publicController from "../Controllers/publicController";

const router = express.Router();

router.route("/blog").get(publicController.getBlogs);

router.route("/blog/:nodeId").get(publicController.getBlog);

export default router;
