import express, { RequestHandler } from "express";
import { OwnerOf } from "../Controllers/businessController";
import multer from "multer";
import { makeCrmController } from "../Controllers/crmController";
import { makeCrmEngageController } from "../Controllers/crmEngageController";

// an imported patient list: one CSV / Excel file, read in memory
const sheet = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

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
  const e = makeCrmEngageController(ownerOf);
  // mergeParams: the panel middleware reads the panel kind from :name
  const router = express.Router({ mergeParams: true });
  router.get("/summary", ...read, c.getSummary);
  router.get("/dashboard", ...read, e.getDashboard);
  router.get("/team", ...read, e.getTeam);
  router.get("/contacts", ...read, c.getContacts);
  router.get("/contacts/export", ...read, c.exportContacts);
  router.post("/contacts", ...write, c.createContact);
  router.post("/contacts/import/preview", ...write, sheet.single("file"), e.importPreview);
  router.post("/contacts/import", ...write, sheet.single("file"), e.importContacts);
  router.post("/contacts/bulk-tag", ...write, e.bulkTag);
  router.get("/tags", ...read, c.getTags);
  router.get("/tag-options", ...read, e.getTagOptions);
  router.post("/tag-options", ...write, e.createTag);
  router.get("/contacts/:contactId", ...read, c.getContact);
  router.patch("/contacts/:contactId", ...write, c.updateContact);
  router.post("/contacts/:contactId/activities", ...write, c.addActivity);
  // a one-off SMS spends money: sendCampaigns
  router.post("/contacts/:contactId/sms", ...send, e.sendToContact);
  router.patch("/activities/:activityId", ...write, e.updateFollowUp);
  router.get("/followups", ...read, e.getFollowUps);
  router.post("/followups", ...write, e.createFollowUp);
  router.get("/segments", ...read, e.getSegments);
  router.post("/segments/count", ...read, e.countSegment);
  router.post("/segments", ...write, e.saveSegment);
  router.patch("/segments/:segmentId", ...write, e.saveSegment);
  router.delete("/segments/:segmentId", ...write, e.deleteSegment);
  router.get("/templates", ...read, e.getTemplates);
  router.post("/templates/preview", ...read, e.previewTemplate);
  router.post("/templates", ...write, e.saveTemplate);
  router.patch("/templates/:templateId", ...write, e.saveTemplate);
  router.post("/templates/:templateId/submit", ...write, e.submitTemplate);
  router.delete("/templates/:templateId", ...write, e.deleteTemplate);
  router.get("/automations", ...read, e.getAutomations);
  router.post("/automations", ...write, e.createAutomation);
  router.get("/automations/:automationId", ...read, e.getAutomation);
  router.patch("/automations/:automationId", ...write, e.updateAutomation);
  // switching one on lets it spend money: sendCampaigns
  router.post("/automations/:automationId/toggle", ...send, e.toggleAutomation);
  router.delete("/automations/:automationId", ...write, e.deleteAutomation);
  router.get("/campaigns", ...read, c.getCampaigns);
  router.get("/campaigns/:campaignId", ...read, c.getCampaign);
  router.post("/campaigns/estimate", ...read, c.estimate);
  router.post("/campaigns", ...write, c.createCampaign);
  router.patch("/campaigns/:campaignId", ...write, c.updateCampaign);
  router.post("/campaigns/:campaignId/submit", ...send, c.submitCampaign);
  router.post("/campaigns/:campaignId/cancel", ...write, c.cancelCampaign);
  return router;
};
