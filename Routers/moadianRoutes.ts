import express, { RequestHandler } from "express";
import { OwnerOf } from "../Controllers/businessController";
import multer from "multer";
import { makeMoadianController } from "../Controllers/moadianController";

// the کارپوشه's export of purchase invoices: one spreadsheet, read in memory
const sheet = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

// The Moadian (electronic invoice) API under /<panel>/moadian (2026-10): the
// same routes for every provider panel and for Noyan's own link under
// /admin/finance/moadian; only the access middleware and the owner differ.
export const moadianRouter = ({ ownerOf, read, write }: { ownerOf: OwnerOf; read: RequestHandler[]; write: RequestHandler[] }) => {
  const c = makeMoadianController(ownerOf);
  // mergeParams: the panel middleware reads the panel kind from :name
  const router = express.Router({ mergeParams: true });
  router.get("/settings", ...read, c.getSettings);
  router.patch("/settings", ...write, c.saveSettings);
  router.post("/settings/key", ...write, c.makeKey);
  router.post("/settings/active", ...write, c.setActive);
  router.get("/invoices", ...read, c.getInvoices);
  router.post("/invoices/retry-rejected", ...write, c.retryRejected);
  router.get("/invoices/:invoiceId", ...read, c.getInvoice);
  router.post("/invoices/:invoiceId/retry", ...write, c.retry);
  router.post("/invoices/:invoiceId/buyer", ...write, c.buyer);
  router.post("/invoices/:invoiceId/cancel", ...write, c.cancel);
  // purchase invoices from the کارپوشه: import, list, pair
  router.get("/purchases", ...read, c.getPurchaseInvoices);
  router.post("/purchases/import", ...write, sheet.single("file"), c.importPurchaseInvoices);
  router.get("/purchases/expense-accounts", ...read, c.getExpenseAccounts);
  router.get("/purchases/:id/candidates", ...read, c.getPurchaseCandidates);
  router.post("/purchases/:id/match", ...write, c.matchPurchaseInvoice);
  return router;
};
