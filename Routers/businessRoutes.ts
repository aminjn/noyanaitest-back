import express, { RequestHandler } from "express";
import { makeBusinessController, OwnerOf } from "../Controllers/businessController";

// The accounting API under /<panel>/biz (2026-10): the same routes for every
// provider panel and for the super admin's platform books; only the access
// middleware and the owner differ.
export const businessRouter = ({
  ownerOf,
  read,
  write,
}: {
  ownerOf: OwnerOf;
  read: RequestHandler[];
  write: RequestHandler[];
}) => {
  const c = makeBusinessController(ownerOf);
  // mergeParams: the panel middleware reads the panel kind from :name
  const router = express.Router({ mergeParams: true });
  router.get("/summary", ...read, c.getSummary);
  router.get("/accounts", ...read, c.getAccounts);
  router.post("/accounts", ...write, c.createAccount);
  router.patch("/accounts/:accountId", ...write, c.renameAccount);
  router.delete("/accounts/:accountId", ...write, c.deleteAccount);
  router.get("/vouchers", ...read, c.getVouchers);
  router.post("/vouchers", ...write, c.createVoucher);
  router.get("/vouchers/:voucherId", ...read, c.getVoucher);
  router.patch("/vouchers/:voucherId", ...write, c.updateVoucher);
  router.delete("/vouchers/:voucherId", ...write, c.deleteVoucher);
  router.post("/quick", ...write, c.quickEntry);
  router.get("/ledger", ...read, c.getLedger);
  router.get("/trial-balance", ...read, c.getTrialBalance);
  router.get("/income-statement", ...read, c.getIncomeStatement);
  router.get("/balance-sheet", ...read, c.getBalanceSheet);
  // year-end close: the years, closing the next one, opening the last again
  router.get("/years", ...read, c.getYears);
  router.post("/years/:year/close", ...write, c.closeYear);
  router.post("/years/:year/reopen", ...write, c.reopenYear);
  return router;
};
