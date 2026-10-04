import express from "express";
import * as authController from "../Controllers/authController";
import * as support from "../Controllers/adminSupportController";
import * as reviewController from "../Controllers/reviewController";
import { AccessLevelModel, AccessOperation } from "../Models/AccessLevel";

// /admin/support/* (mounted in Routers/adminRouter.ts). Staff with the
// matching access level may use each route; full admins always may.
const router = express.Router();

const staff = [authController.protect, authController.restrictTo("admin", "notadmin")];
const can = (model: AccessLevelModel, op: AccessOperation) => [
  ...staff,
  authController.hasPermission({ model, op }),
];

router
  .route("/tickets")
  .get(...can("Ticket", "readAll"), support.listTickets)
  .post(...can("Ticket", "write"), support.openTicket);
router
  .route("/tickets/:nodeId")
  .get(...can("Ticket", "readOne"), support.getTicket)
  .patch(...can("Ticket", "update"), support.updateTicket);
router.post("/tickets/:nodeId/notes", ...can("Ticket", "update"), support.addTicketNote);
router.get("/staff", ...can("Ticket", "readAll"), support.listStaff);

router.post("/contact/:nodeId", ...can("ContactRequest", "update"), support.updateContactRequest);
router.post(
  "/contact/:nodeId/convert",
  ...can("ContactRequest", "update"),
  ...can("Ticket", "write"),
  support.convertContactRequest,
);

router.post("/comments/moderate", ...can("Comment", "update"), support.moderateComments);
// a provider's submitted article: publish, or reject with a reason
router.post("/blogs/moderate", ...can("Blog", "update"), support.moderateBlogs);
router.post(
  "/doctorfeedback/moderate",
  ...can("DoctorFeedback", "update"),
  support.moderateDoctorFeedback,
);
// take down a provider's public reply to a review (2026-10)
router.post("/comments/reply/remove", ...can("Comment", "update"), reviewController.removeCommentReply);
router.post(
  "/doctorfeedback/reply/remove",
  ...can("DoctorFeedback", "update"),
  reviewController.removeDoctorFeedbackReply,
);

// phone numbers of everyone who got an SMS: full admins only, like the SMS
// gateway settings
router.get(
  "/sms-log",
  authController.protect,
  authController.restrictTo("admin"),
  support.listSmsLog,
);

export default router;
