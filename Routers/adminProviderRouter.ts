import express from "express";
import * as authController from "../Controllers/authController";
import * as adminProviderController from "../Controllers/adminProviderController";
import * as adminCentreLicenceController from "../Controllers/adminCentreLicenceController";

// Provider back office routes (Controllers/adminProviderController.ts),
// mounted inside Routers/adminRouter.ts so they sit under /api/v1/admin and
// its audit log. Paths start with the provider's segment (PUT
// /admin/<kind>/<id>/...) so the audit row targets that record.
const router = express.Router();
const kinds = adminProviderController.providerKindPattern;
const staff = [authController.protect, authController.restrictTo("admin", "notadmin")];

// suspend (reason required, the owner is notified) / reactivate
router.put(
  `/:kind(${kinds})/:nodeId/status`,
  ...staff,
  adminProviderController.providerPermission("update"),
  adminProviderController.setProviderStatus,
);

// set ({user}) or clear ({user: null}) the panel owner
router.put(
  `/:kind(${kinds})/:nodeId/owner`,
  ...staff,
  adminProviderController.providerPermission("update"),
  adminProviderController.setProviderOwner,
);

// clear the owner (the older PUT /admin/<kind>/<id> form), for every kind:
// the doctor / clinic / hospital / insurance copies in adminRouter.ts only
// unset the field, so the same action behaved differently by kind
router.put(
  `/:kind(${kinds})/:nodeId`,
  ...staff,
  adminProviderController.providerPermission("update"),
  adminProviderController.setProviderOwner,
);

// a centre's operating licence: the verified tick (2026-10,
// Controllers/adminCentreLicenceController.ts) - read with readOne, set with
// update; the centre itself never writes it
const centres = "clinic|hospital|pharmacy|paraClinic|insurance";
router.get(
  `/:kind(${centres})/:nodeId/licence`,
  ...staff,
  adminProviderController.providerPermission("readOne"),
  adminCentreLicenceController.getCentreLicence,
);
router.put(
  `/:kind(${centres})/:nodeId/licence`,
  ...staff,
  adminProviderController.providerPermission("update"),
  adminCentreLicenceController.setCentreLicence,
);

// the doctor's schedule and access, read-only ("why can't I book?")
router.get(
  "/:kind(doctorprofile)/:nodeId/schedule",
  ...staff,
  adminProviderController.providerPermission("readOne"),
  adminProviderController.getDoctorSchedule,
);

export default router;
