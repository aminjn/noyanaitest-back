import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { AccessError, BadInputError, NotFoundError } from "../Lib/AppError";
import BizRequest, { bizRequestKinds, bizRequestStatuses, IBizRequest } from "../Models/BizRequest";
import { BizOwner, ownerFilter } from "../Lib/business/coa";
import { ownerModules } from "../Lib/business/campaign";
import {
  cancelRequest,
  CRM_KINDS,
  decideRequest,
  executeRequest,
  FINANCE_KINDS,
  Grant,
  listRequests,
  myPendingCount,
  ownerUserOf,
  reopenRequest,
  teamOf,
  visibleKinds,
} from "../Lib/business/kartabl";
import { OwnerOf } from "./businessController";

// The panel's «کارتابل» API (2026-10, Lib/business/kartabl.ts), mounted at
// /<panel>/kartabl by every provider panel: one list of what waits for a
// decision - finance requests, treatment-plan / discount / credit
// approvals, returns and workflow steps - and its one-way actions. Any
// member of the panel reaches it (Routers/kartablRoutes.ts); what they see
// follows their access (finance kinds with readFinance, CRM kinds with
// readCrm, and always what they asked for or must decide); deciding is the
// current approver's or the owner's; «اجرا» (applying an approved item
// whose effect failed) needs the part's writing access.

const ok = (res: Response, message: string, data?: unknown, code = 200) => res.status(code).json({ message, ...(data !== undefined ? { data } : {}) });
const me = (req: Request) => String(req.user?._id || "");
const grantOf = (req: Request): Grant => (req.aclGrant === "FULL" ? "FULL" : ((req.aclGrant as Record<string, unknown> | null) ?? null));
const param = (req: Request, name: string) => {
  const v = String(req.params[name] || "");
  if (!/^[0-9a-f]{24}$/i.test(v)) throw new NotFoundError();
  return v;
};

const withOwner = (ownerOf: OwnerOf, fn: (owner: BizOwner, req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const owner = ownerOf(req);
    if (!owner?.id) return next(new NotFoundError());
    await fn(owner, req, res);
  });

// the plan's accounting or crm module opens it
export const requireKartablModule = (ownerOf: OwnerOf): RequestHandler =>
  catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
    const owner = ownerOf(req);
    if (!owner?.id) return next(new NotFoundError());
    const mods = await ownerModules(owner);
    if (!mods.includes("accounting") && !mods.includes("crm")) return next(new AccessError());
    next();
  });

// an item the viewer may see (else it does not exist for them)
const visible = async (owner: BizOwner, req: Request) => {
  const r = await BizRequest.findOne({ ...ownerFilter(owner), _id: param(req, "requestId") }).lean<IBizRequest>();
  if (!r) throw new NotFoundError();
  const user = me(req);
  const seen = visibleKinds(grantOf(req)).includes(r.kind) || r.chain.some((c) => String(c) === user) || String(r.requester || "") === user;
  if (!seen) throw new NotFoundError();
  return r;
};

export const makeKartablController = (ownerOf: OwnerOf) => ({
  list: withOwner(ownerOf, async (owner, req, res) => {
    const q = z
      .object({
        kind: z.enum(bizRequestKinds).optional(),
        status: z.enum([...bizRequestStatuses, "any"]).optional(),
        scope: z.enum(["mine", "all"]).default("mine"),
      })
      .safeParse(req.query);
    if (!q.success) throw new BadInputError();
    const grant = grantOf(req);
    const [data, team, top] = await Promise.all([
      listRequests(owner, { ...q.data, user: me(req), grant }),
      teamOf(owner),
      ownerUserOf(owner),
    ]);
    const g = (grant === "FULL" ? {} : grant || {}) as Record<string, unknown>;
    ok(res, "kartabl", {
      ...data,
      team,
      me: me(req),
      isOwner: top === me(req),
      // what the viewer may file and apply
      can: {
        finance: grant === "FULL" || !!g.readFinance,
        crm: grant === "FULL" || !!g.readCrm,
        approveFinance: grant === "FULL" || !!g.approveVouchers,
        manageCrm: grant === "FULL" || !!g.manageCrm,
      },
      profile: owner.kind,
    });
  }),
  count: withOwner(ownerOf, async (owner, req, res) => ok(res, "kartablCount", { pending: await myPendingCount(owner, me(req)) })),
  decide: withOwner(ownerOf, async (owner, req, res) => {
    const b = z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(500).optional() }).safeParse(req.body || {});
    if (!b.success) throw new BadInputError();
    const r = await visible(owner, req);
    ok(res, "kartablDecide", await decideRequest(owner, r._id, me(req), b.data.decision, b.data.note));
  }),
  execute: withOwner(ownerOf, async (owner, req, res) => {
    const r = await visible(owner, req);
    const grant = grantOf(req);
    const g = (grant === "FULL" ? {} : grant || {}) as Record<string, unknown>;
    const allowed =
      grant === "FULL" ||
      (FINANCE_KINDS.includes(r.kind) && !!g.approveVouchers) ||
      (CRM_KINDS.includes(r.kind) && !!g.manageCrm) ||
      (r.kind === "return" && (!!g.approveVouchers || !!g.manageCrm));
    if (!allowed) throw new AccessError();
    if (r.kind === "flow") throw new AppError("فقط درخواست تأییدشده اجرا می‌شود", 400);
    ok(res, "kartablExecute", await executeRequest(owner, String(r._id), me(req)));
  }),
  cancel: withOwner(ownerOf, async (owner, req, res) => {
    const r = await visible(owner, req);
    ok(res, "kartablCancel", await cancelRequest(owner, r._id, me(req)));
  }),
  reopen: withOwner(ownerOf, async (owner, req, res) => {
    const r = await visible(owner, req);
    ok(res, "kartablReopen", await reopenRequest(owner, r._id, me(req)));
  }),
});
