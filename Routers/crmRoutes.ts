import express, { RequestHandler } from "express";
import { OwnerOf } from "../Controllers/businessController";
import { makeCrmController } from "../Controllers/crmController";

// The CRM and SMS campaign API under /<panel>/crm (2026-10): the same routes
// for every provider panel; only the access middleware and the owner differ.
// `send` guards the one call that spends money: submitting a campaign.
export const crmRouter = ({
  ownerOf,
  read,
  write,
  send,
}: {
  ownerOf: OwnerOf;
  read: RequestHandler[];
  write: RequestHandler[];
  send: RequestHandler[];
}) => {
  const c = makeCrmController(ownerOf);
  // mergeParams: the panel middleware reads the panel kind from :name
  const router = express.Router({ mergeParams: true });
  router.get("/summary", ...read, c.getSummary);
  router.get("/contacts", ...read, c.getContacts);
  router.post("/contacts", ...write, c.createContact);
  router.get("/tags", ...read, c.getTags);
  router.get("/contacts/:contactId", ...read, c.getContact);
  router.patch("/contacts/:contactId", ...write, c.updateContact);
  router.post("/contacts/:contactId/activities", ...write, c.addActivity);
  router.patch("/activities/:activityId", ...write, c.updateActivity);
  router.get("/followups", ...read, c.getFollowUps);
  router.get("/campaigns", ...read, c.getCampaigns);
  router.post("/campaigns/estimate", ...read, c.estimate);
  router.post("/campaigns", ...write, c.createCampaign);
  router.patch("/campaigns/:campaignId", ...write, c.updateCampaign);
  router.post("/campaigns/:campaignId/submit", ...send, c.submitCampaign);
  router.post("/campaigns/:campaignId/cancel", ...write, c.cancelCampaign);
  return router;
};
