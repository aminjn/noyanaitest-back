import express, { RequestHandler } from "express";
import { OwnerOf } from "../Controllers/businessController";
import { makeInventoryController } from "../Controllers/inventoryController";

// The inventory and purchasing API under /<panel>/inv (2026-10): the same
// routes for the pharmacy, para-clinic, clinic and hospital panels; only the
// access middleware and the owner differ.
export const inventoryRouter = ({
  ownerOf,
  read,
  write,
}: {
  ownerOf: OwnerOf;
  read: RequestHandler[];
  write: RequestHandler[];
}) => {
  const c = makeInventoryController(ownerOf);
  // mergeParams: the panel middleware reads the panel kind from :name
  const router = express.Router({ mergeParams: true });
  router.get("/summary", ...read, c.getSummary);
  router.get("/pay-accounts", ...read, c.getPayAccounts);
  router.get("/items", ...read, c.getItems);
  router.post("/items", ...write, c.createItem);
  router.patch("/items/:itemId", ...write, c.updateItem);
  router.get("/items/:itemId/lots", ...read, c.getLots);
  router.post("/stock", ...write, c.stockEntry);
  router.get("/moves", ...read, c.getMoves);
  router.get("/suppliers", ...read, c.getSuppliers);
  router.post("/suppliers", ...write, c.createSupplier);
  router.patch("/suppliers/:supplierId", ...write, c.updateSupplier);
  router.get("/purchases", ...read, c.getPurchases);
  router.post("/purchases", ...write, c.createPurchase);
  router.get("/purchases/:purchaseId", ...read, c.getPurchase);
  router.patch("/purchases/:purchaseId", ...write, c.updatePurchase);
  router.post("/purchases/:purchaseId/receive", ...write, c.receivePurchase);
  router.post("/purchases/:purchaseId/pay", ...write, c.payPurchase);
  router.post("/purchases/:purchaseId/payments/:paymentId/void", ...write, c.voidPurchasePayment);
  router.post("/purchases/:purchaseId/cancel", ...write, c.cancelPurchase);
  return router;
};
