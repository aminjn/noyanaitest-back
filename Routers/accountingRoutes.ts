import express, { RequestHandler } from "express";
import multer from "multer";
import { OwnerOf } from "../Controllers/businessController";
import { makeAccountingController } from "../Controllers/accountingController";

// The Nexxa-parity accounting routes (2026-10), mounted under
// /<panel>/biz/acc by Routers/businessRoutes.ts (kept in their own file so
// the finance routes and these do not overwrite each other). read =
// readFinance, write = manageAccounting, ok = approveVouchers (the writer's
// access where a panel has no approver action).

const sheet = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

export const mountAccounting = (
  router: express.Router,
  { ownerOf, read, write, ok }: { ownerOf: OwnerOf; read: RequestHandler[]; write: RequestHandler[]; ok: RequestHandler[] },
) => {
  const a = makeAccountingController(ownerOf);
  // (2026-10) the older voucher routes go through the journal's own rules:
  // a hand-typed voucher is a draft first
  router.post("/vouchers", ...write, a.createVoucher);
  router.patch("/vouchers/:voucherId", ...write, a.updateVoucher);
  router.delete("/vouchers/:voucherId", ...write, a.deleteDraft);
  // journal and hand-typed vouchers: drafts by the writer, final by the approver
  router.get("/acc/journal", ...read, a.journal);
  router.get("/acc/vouchers/:voucherId", ...read, a.voucher);
  router.post("/acc/vouchers", ...write, a.createVoucher);
  router.patch("/acc/vouchers/:voucherId", ...write, a.updateVoucher);
  router.delete("/acc/vouchers/:voucherId/draft", ...write, a.deleteDraft);
  router.put("/acc/vouchers/:voucherId/attachments", ...write, a.attachments);
  router.post("/acc/vouchers/:voucherId/finalize", ...ok, a.finalize);
  router.post("/acc/vouchers/:voucherId/revert", ...ok, a.revert);
  router.delete("/acc/vouchers/:voucherId", ...ok, a.deleteVoucher);
  router.get("/acc/audit", ...read, a.audit);
  router.post("/acc/opening", ...ok, a.opening);
  router.post("/acc/opening/file", ...ok, sheet.single("file"), a.openingFile);
  router.post("/acc/coding", ...write, sheet.single("file"), a.coding);
  // the chart: group / total / detail, party kinds, deactivation
  router.post("/acc/accounts", ...write, a.createAccount);
  router.post("/acc/accounts/auto-link", ...write, a.autoLink);
  router.patch("/acc/accounts/:accountId", ...write, a.updateAccount);
  router.delete("/acc/accounts/:accountId", ...write, a.deleteAccount);
  // the تفصیلی register, statements and opening balances of parties
  router.get("/acc/parties", ...read, a.parties);
  router.get("/acc/parties/balances", ...read, a.partyBalances);
  router.post("/acc/parties", ...write, a.createParty);
  router.patch("/acc/parties/:partyId", ...write, a.updateParty);
  router.delete("/acc/parties/:partyId", ...write, a.deleteParty);
  router.post("/acc/parties/:partyId/opening", ...ok, a.partyOpening);
  // the books
  router.get("/acc/ledger", ...read, a.ledger);
  router.get("/acc/total-ledger", ...read, a.totalLedger);
  router.get("/acc/trial", ...read, a.trial);
  router.get("/acc/review", ...read, a.review);
  // cost centres as a tree and cost allocation
  router.get("/acc/centers", ...read, a.centersTree);
  router.post("/acc/centers", ...write, a.saveCenter);
  router.patch("/acc/centers/:centerId", ...write, a.saveCenter);
  router.delete("/acc/centers/:centerId", ...write, a.deleteCenter);
  router.get("/acc/allocations", ...read, a.allocations);
  router.post("/acc/allocations", ...write, a.saveAllocation);
  router.delete("/acc/allocations/:allocId", ...write, a.deleteAllocation);
  router.post("/acc/allocations/:allocId/run", ...write, a.runAllocation);
  // fixed assets
  router.get("/acc/assets", ...read, a.assets);
  router.get("/acc/assets/report", ...read, a.assetReport);
  router.get("/acc/assets/events", ...read, a.assetEvents);
  router.get("/acc/assets/groups", ...read, a.assetGroups);
  router.post("/acc/assets/groups", ...write, a.saveAssetGroup);
  router.post("/acc/assets/groups/seed", ...write, a.seedAssetGroups);
  router.delete("/acc/assets/groups/:groupId", ...write, a.deleteAssetGroup);
  router.post("/acc/assets/depreciate", ...write, a.depreciate);
  router.delete("/acc/assets/events/:eventId", ...write, a.deleteAssetEvent);
  router.get("/acc/assets/:assetId", ...read, a.asset);
  router.post("/acc/assets", ...write, a.createAsset);
  router.patch("/acc/assets/:assetId", ...write, a.updateAsset);
  router.delete("/acc/assets/:assetId", ...write, a.deleteAsset);
  router.post("/acc/assets/:assetId/dispose", ...write, a.dispose);
  router.post("/acc/assets/:assetId/revalue", ...write, a.revalue);
  router.post("/acc/assets/:assetId/transfer", ...write, a.transferAsset);
  router.post("/acc/assets/:assetId/maintenance", ...write, a.maintenance);
  // treasury: accounts, transfers, fees, petty cash, bank reconciliation,
  // cheque moves, cheque books, trust cheques, settings
  router.get("/acc/treasury", ...read, a.treasury);
  router.post("/acc/treasury", ...write, a.openTreasury);
  router.patch("/acc/treasury/:moneyId", ...write, a.updateTreasury);
  router.get("/acc/transfers", ...read, a.transfers);
  router.post("/acc/transfers", ...write, a.transfer);
  router.post("/acc/transfers/:voucherId/void", ...write, a.voidTransfer);
  router.post("/acc/bank-fee", ...write, a.bankFee);
  router.get("/acc/petty/:moneyId", ...read, a.petty);
  router.post("/acc/petty/:moneyId/charge", ...write, a.chargePetty);
  router.get("/acc/bank/:moneyId", ...read, a.bankRec);
  router.post("/acc/bank/:moneyId/preview", ...write, sheet.single("file"), a.statementPreview);
  router.post("/acc/bank/:moneyId/import", ...write, sheet.single("file"), a.statementImport);
  router.post("/acc/bank/:moneyId/auto-match", ...write, a.autoMatch);
  router.delete("/acc/bank/:moneyId/lines", ...write, a.clearStatement);
  router.post("/acc/bank-lines/:lineId/match", ...write, a.matchLine);
  router.post("/acc/bank-lines/:lineId/unmatch", ...write, a.unmatchLine);
  router.post("/acc/bank-lines/:lineId/ignore", ...write, a.ignoreLine);
  router.post("/acc/bank-lines/:lineId/book", ...write, a.bookLine);
  router.post("/acc/cheques/:paymentId/deposit", ...write, a.depositCheque);
  router.post("/acc/cheques/:paymentId/endorse", ...write, a.endorseCheque);
  router.post("/acc/cheques/:paymentId/revert", ...write, a.revertCheque);
  router.get("/acc/checkbooks", ...read, a.checkbooks);
  router.post("/acc/checkbooks", ...write, a.saveCheckbook);
  router.delete("/acc/checkbooks/:bookId", ...write, a.deleteCheckbook);
  router.get("/acc/trust", ...read, a.trust);
  router.post("/acc/trust", ...write, a.saveTrust);
  router.delete("/acc/trust/:trustId", ...write, a.releaseTrust);
  router.get("/acc/settings", ...read, a.settings);
  router.put("/acc/settings", ...write, a.saveSettings);
  // a finance request: anyone who reads may ask; it is decided in the
  // panel's «کارتابل» (Routers/kartablRoutes.ts)
  router.get("/acc/team", ...read, a.team);
  router.post("/acc/requests", ...read, a.createRequest);
  // tax (VAT + ماده‌ی ۱۶۹), data health, price list, proforma, quick sale,
  // settlements, Excel export
  router.get("/acc/seasonal", ...read, a.seasonal);
  router.get("/acc/health", ...read, a.health);
  router.get("/acc/prices", ...read, a.prices);
  router.post("/acc/prices", ...write, a.savePrice);
  router.delete("/acc/prices/:priceId", ...write, a.deletePrice);
  router.get("/acc/proformas", ...read, a.proformas);
  router.post("/acc/proformas", ...write, a.createProforma);
  router.post("/acc/proformas/:invoiceId/convert", ...write, a.convertProforma);
  router.post("/acc/quick-invoice", ...write, a.quickInvoice);
  router.get("/acc/settlements", ...read, a.settlements);
  router.post("/acc/settlements/receipt", ...write, a.allocateReceipt);
  router.post("/acc/xlsx", ...read, a.xlsx);
  // the profile's own entries and income grouping
  router.get("/acc/profile", ...read, a.profile);
  router.get("/acc/profile/entries", ...read, a.profileEntries);
  router.get("/acc/profile/income", ...read, a.profileIncome);
  router.post("/acc/profile/entries/:kind", ...write, a.profileEntry);
  router.post("/acc/profile/entries/:voucherId/void", ...write, a.voidProfileEntry);
};
