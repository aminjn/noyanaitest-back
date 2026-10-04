import express, { RequestHandler } from "express";
import { OwnerOf } from "../Controllers/businessController";
import { makePayrollController } from "../Controllers/payrollController";
import { makeFinanceAiController } from "../Controllers/financeAiController";

// The payroll API under /<panel>/payroll (2026-10): the same routes for every
// provider panel; only the access middleware and the owner differ.
export const payrollRouter = ({
  ownerOf,
  read,
  write,
}: {
  ownerOf: OwnerOf;
  read: RequestHandler[];
  write: RequestHandler[];
}) => {
  const c = makePayrollController(ownerOf);
  // mergeParams: the panel middleware reads the panel kind from :name
  const router = express.Router({ mergeParams: true });
  router.get("/employees", ...read, c.getEmployees);
  // the payslip assistant (Nexxa /api/ai/payslip): the engine's figures,
  // explained and checked by the AI (Lib/business/financeAi.ts)
  router.post("/ai/payslip", ...read, makeFinanceAiController(ownerOf).payslip);
  router.post("/employees", ...write, c.createEmployee);
  router.patch("/employees/:employeeId", ...write, c.updateEmployee);
  router.post("/employees/:employeeId/advance", ...write, c.advance);
  router.get("/pay-accounts", ...read, c.getPayAccounts);
  router.get("/years/:year", ...read, c.getYear);
  router.get("/runs", ...read, c.getRuns);
  router.post("/runs", ...write, c.createRun);
  router.get("/runs/:runId", ...read, c.getRun);
  router.patch("/runs/:runId", ...write, c.updateRun);
  router.post("/runs/:runId/post", ...write, c.postRun);
  router.post("/runs/:runId/pay", ...write, c.payRun);
  router.post("/runs/:runId/reopen", ...write, c.reopenRun);
  // the Tamin list disk of a month (workshop settings, check, zip)
  router.get("/settings", ...read, c.getSettings);
  router.put("/settings", ...write, c.saveSettings);
  router.get("/runs/:runId/disk-check", ...read, c.getDiskCheck);
  router.get("/runs/:runId/disk", ...read, c.getDisk);
  // and its salary tax list files (WP, WH) for my.tax.gov.ir
  router.get("/runs/:runId/tax-check", ...read, c.getTaxCheck);
  router.get("/runs/:runId/tax-disk", ...read, c.getTaxDisk);
  // عیدی و سنوات
  router.get("/bonus", ...read, c.getBonusRuns);
  router.post("/bonus", ...write, c.createBonusRun);
  router.patch("/bonus/:bonusId", ...write, c.updateBonusRun);
  router.post("/bonus/:bonusId/post", ...write, c.postBonusRun);
  router.post("/bonus/:bonusId/pay", ...write, c.payBonusRun);
  router.post("/bonus/:bonusId/reopen", ...write, c.reopenBonusRun);
  return router;
};
