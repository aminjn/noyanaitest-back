import express, { RequestHandler } from "express";
import { OwnerOf } from "../Controllers/businessController";
import { makeKartablController, requireKartablModule } from "../Controllers/kartablController";

// The panel's «کارتابل» under /<panel>/kartabl (2026-10): the one approval
// queue of every provider panel (Controllers/kartablController.ts).
// `member` is the panel's access middleware with no action (the owner or
// any team member); the plan's accounting or crm module opens it.
export const kartablRouter = ({ ownerOf, member }: { ownerOf: OwnerOf; member: RequestHandler }) => {
  const k = makeKartablController(ownerOf);
  const router = express.Router({ mergeParams: true });
  router.use(member, requireKartablModule(ownerOf));
  router.get("/", k.list);
  router.get("/count", k.count);
  router.post("/:requestId/decide", k.decide);
  router.post("/:requestId/execute", k.execute);
  router.post("/:requestId/cancel", k.cancel);
  router.post("/:requestId/reopen", k.reopen);
  return router;
};
