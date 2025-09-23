import express from "express";

import * as publicController from "../Controllers/publicController";

import * as uploadController from "../Controllers/uploadController";

const router = express.Router();

router.route("/site").get(publicController.getSite);

router.route("/blog").get(publicController.getBlogs);

router.route("/blog/:nodeId").get(publicController.getBlog);

router.route("/selectspeciality").get(publicController.getSpecialityOptions);

router.route("/booking").get(publicController.getBookingPage);

router
  .route("/doctor/:nodeId/week")
  .get(publicController.getUpcomingWeekAvailabelSessions);

router
  .route("/doctor/:nodeId/day/:stamp")
  .get(publicController.getAvailableSessionsByDay);

router
  .route("/map")
  .post(uploadController.upload.none(), publicController.searchInMap);

export default router;
