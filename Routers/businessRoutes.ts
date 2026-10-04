import express, { RequestHandler } from "express";
import { makeBusinessController, OwnerOf } from "../Controllers/businessController";
import { makeFinanceController } from "../Controllers/financeSuiteController";
import * as uploadController from "../Controllers/uploadController";
import { mountAccounting } from "./accountingRoutes";
import { audioUpload, makeFinanceAiController } from "../Controllers/financeAiController";

// The accounting API under /<panel>/biz (2026-10): the same routes for every
// provider panel and for the super admin's platform books; only the access
// middleware and the owner differ.
export const businessRouter = ({
  ownerOf,
  read,
  write,
  approve,
}: {
  ownerOf: OwnerOf;
  read: RequestHandler[];
  write: RequestHandler[];
  // finalizing / reverting / deleting final vouchers and deciding finance
  // requests (the approveVouchers action); the writer's access when absent
  approve?: RequestHandler[];
}) => {
  const c = makeBusinessController(ownerOf);
  // mergeParams: the panel middleware reads the panel kind from :name
  const router = express.Router({ mergeParams: true });
  // the Nexxa-parity accounting under /acc (Routers/accountingRoutes.ts);
  // first, so its voucher routes take the old POST/PATCH/DELETE /vouchers
  mountAccounting(router, { ownerOf, read, write, ok: approve || write });
  router.get("/summary", ...read, c.getSummary);
  router.get("/accounts", ...read, c.getAccounts);
  router.post("/accounts", ...write, c.createAccount);
  router.patch("/accounts/:accountId", ...write, c.renameAccount);
  router.delete("/accounts/:accountId", ...write, c.deleteAccount);
  router.get("/vouchers", ...read, c.getVouchers);
  router.get("/vouchers/:voucherId", ...read, c.getVoucher);
  router.post("/quick", ...write, c.quickEntry);
  router.get("/ledger", ...read, c.getLedger);
  router.get("/trial-balance", ...read, c.getTrialBalance);
  router.get("/income-statement", ...read, c.getIncomeStatement);
  router.get("/balance-sheet", ...read, c.getBalanceSheet);
  // cash flow, cost centres and the year's budget (Lib/business/analysis.ts)
  router.get("/cash-flow", ...read, c.getCashFlow);
  router.get("/centers", ...read, c.getCenters);
  router.post("/centers", ...write, c.createCenter);
  router.patch("/centers/:centerId", ...write, c.updateCenter);
  router.get("/cost-centers", ...read, c.getCostCenterReport);
  router.get("/budget", ...read, c.getBudget);
  router.put("/budget/:year", ...write, c.saveBudget);
  // year-end close: the years, closing the next one, opening the last again
  router.get("/years", ...read, c.getYears);
  router.post("/years/:year/close", ...write, c.closeYear);
  router.post("/years/:year/reopen", ...write, c.reopenYear);
  // the quarterly VAT return: the report, settling a quarter, paying it
  router.get("/vat", ...read, c.getVat);
  router.post("/vat/:year/:quarter/settle", ...write, c.settleVat);
  router.post("/vat/:year/:quarter/pay", ...write, c.payVat);
  router.post("/vat/:year/:quarter/reopen", ...write, c.reopenVat);

  // the practice-finance suite (2026-10, «مالی و حسابداری»): dashboard,
  // invoices, receipts and payments with cheques, tills and banks,
  // expenses, insurance claims and their reports - same access as above
  const f = makeFinanceController(ownerOf);
  router.get("/finance/overview", ...read, f.overview);
  router.get("/finance/invoices", ...read, f.listInvoices);
  router.post("/finance/invoices", ...write, f.createInvoice);
  router.get("/finance/invoices/:invoiceId", ...read, f.getInvoice);
  router.patch("/finance/invoices/:invoiceId", ...write, f.updateInvoice);
  router.delete("/finance/invoices/:invoiceId", ...write, f.deleteInvoice);
  router.post("/finance/invoices/:invoiceId/issue", ...write, f.issueInvoice);
  router.post("/finance/invoices/:invoiceId/void", ...write, f.voidInvoice);
  router.post("/finance/invoices/:invoiceId/sms", ...write, f.smsInvoice);
  router.post("/finance/invoices/:invoiceId/moadian", ...write, f.moadianInvoice);
  router.get("/finance/payments", ...read, f.listPayments);
  router.post("/finance/payments", ...write, f.createPayment);
  router.post("/finance/payments/:paymentId/void", ...write, f.voidPayment);
  router.get("/finance/cheques", ...read, f.listCheques);
  router.post("/finance/cheques/:paymentId/status", ...write, f.chequeStatus);
  router.get("/finance/money", ...read, f.listMoney);
  router.post("/finance/money", ...write, f.createMoney);
  router.patch("/finance/money/:moneyId", ...write, f.updateMoney);
  router.get("/finance/money/:moneyId/lines", ...read, f.moneyLines);
  router.post("/finance/money/:moneyId/reconcile", ...write, f.reconcile);
  router.get("/finance/expense-accounts", ...read, f.expenseAccounts);
  router.get("/finance/expenses", ...read, f.listExpenses);
  router.post("/finance/expenses", ...write, f.createExpense);
  router.post("/finance/expenses/:expenseId/void", ...write, f.voidExpense);
  router.post("/finance/expenses/:expenseId/recurring", ...write, f.recurringActive);
  router.post("/finance/upload", ...write, uploadController.upload.any(), uploadController.saveUplaodsToBody({ name: "finance" }), f.upload);
  router.get("/finance/claims", ...read, f.listClaims);
  router.get("/finance/claims/candidates", ...read, f.claimCandidates);
  router.post("/finance/claims", ...write, f.createClaim);
  router.get("/finance/claims/:claimId", ...read, f.getClaim);
  router.patch("/finance/claims/:claimId", ...write, f.updateClaim);
  router.delete("/finance/claims/:claimId", ...write, f.deleteClaim);
  router.post("/finance/claims/:claimId/submit", ...write, f.submitClaim);
  router.post("/finance/claims/:claimId/deduct", ...write, f.deductClaim);
  router.post("/finance/claims/:claimId/reopen", ...write, f.reopenClaim);
  router.get("/finance/reports/breakdown", ...read, f.breakdown);
  router.get("/finance/reports/aging", ...read, f.aging);

  // the finance assistant (2026-10, Lib/business/financeAi.ts): Nexxa's AI
  // features on the panel's own books; every result is a draft
  const ai = makeFinanceAiController(ownerOf);
  router.get("/finance/ai/status", ...read, ai.status);
  router.post("/finance/ai/copilot", ...read, ai.copilot);
  router.post("/finance/ai/insight", ...read, ai.insight);
  router.get("/finance/ai/forecast", ...read, ai.forecast);
  router.get("/finance/ai/anomalies", ...read, ai.anomalies);
  router.post("/finance/ai/receipt", ...write, uploadController.upload.any(), uploadController.saveUplaodsToBody({ name: "finance" }), ai.receipt);
  router.post("/finance/ai/journal", ...write, ai.journal);
  router.post("/finance/ai/entry", ...write, ai.entry);
  router.post("/finance/ai/transcribe", ...write, audioUpload, ai.transcribe);
  router.post("/finance/ai/categorize", ...write, ai.categorize);
  router.post("/finance/ai/uncategorized", ...write, ai.uncategorized);
  router.post("/finance/ai/reclassify", ...write, ai.reclassify);
  router.post("/finance/ai/learn", ...write, ai.learn);
  return router;
};
