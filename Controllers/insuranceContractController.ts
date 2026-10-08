import { NextFunction, Request, RequestHandler, Response } from "express";
import mongoose, { isValidObjectId } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import { escapeRegex } from "../Lib/helpers";
import InsuranceContract, { ContractProviderKind, IInsuranceContract } from "../Models/InsuranceContract";
import {
  cancelContract,
  decideContract,
  endContract,
  inviteProvider,
  isContractProviderKind,
  isEffective,
  providerActiveField,
  providerModelOf,
  providerNameOf,
  requestContract,
} from "../Lib/insuranceContracts";

// Both sides of an insurer ↔ provider contract (2026-10, Lib/insuranceContracts.ts):
// a doctor's, clinic's, hospital's, lab's or pharmacy's panel lists its
// insurers with the contract's status, asks a new insurer, answers an
// invitation and ends a contract; the insurer's panel answers the requests,
// invites providers and ends contracts. Every action is one step of the
// lifecycle; there is no free status field.

const day = z.union([z.string().trim().max(40), z.null()]).optional();

const requestSchema = z.strictObject({
  insurance: z.string().regex(/^[0-9a-fA-F]{24}$/),
  validFrom: day,
  validUntil: day,
  note: z.string().trim().max(500).optional(),
});

const inviteSchema = z.strictObject({
  kind: z.enum(["doctor", "clinic", "hospital", "paraClinic", "pharmacy"]),
  provider: z.string().regex(/^[0-9a-fA-F]{24}$/),
  validFrom: day,
  validUntil: day,
  note: z.string().trim().max(500).optional(),
});

const reasonSchema = z.object({ reason: z.string().trim().max(500).optional() });
const endSchema = z.object({ reason: z.string().trim().max(500).optional(), endDate: day });

const isDoc = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !(v instanceof mongoose.Types.ObjectId);

// a contract as both panels show it
const view = (c: IInsuranceContract & { insurance?: any; provider?: any }) => ({
  _id: String(c._id),
  status: c.status,
  effective: isEffective(c),
  initiatedBy: c.initiatedBy,
  reviewer: c.reviewer,
  source: c.source,
  note: c.note || "",
  validFrom: c.validFrom || null,
  validUntil: c.validUntil || null,
  endsAt: c.endsAt || null,
  endedAt: c.endedAt || null,
  endedBy: c.endedBy,
  endReason: c.endReason || "",
  rejectReason: c.rejectReason || "",
  activatedAt: c.activatedAt || null,
  createdAt: c.createdAt,
  insurance:
    isDoc(c.insurance)
      ? { _id: String(c.insurance._id), name: c.insurance.name || "", slug: c.insurance.slug, image: c.insurance.image }
      : null,
  providerKind: c.providerKind,
  provider:
    isDoc(c.provider)
      ? { _id: String(c.provider._id), name: providerNameOf(c.providerKind, c.provider), slug: c.provider.slug }
      : null,
});

// the open ones first (waiting, then active), then the history
const statusRank: Record<string, number> = { Pending: 0, Active: 1, Ended: 2, Rejected: 3, Cancelled: 4 };
const sortContracts = (rows: ReturnType<typeof view>[]) =>
  rows.sort((a, b) => (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) || +new Date(b.createdAt) - +new Date(a.createdAt));

const send = (res: Response, message: string, c?: IInsuranceContract | null) =>
  res.status(200).json({ message, data: c ? { _id: String(c._id), status: c.status } : undefined });

// ------------------------------------------------------- provider side

const providerOf = (req: Request, kind: ContractProviderKind) =>
  (req as unknown as Record<string, { _id: unknown } | undefined>)[kind];

export const providerSide = (kind: ContractProviderKind) => {
  const scope = (req: Request) => ({ providerKind: kind, provider: providerOf(req, kind)!._id });
  const guard = (req: Request, next: NextFunction) => {
    if (!providerOf(req, kind)) {
      next(new MiddlewareError());
      return false;
    }
    return true;
  };
  return {
    // GET - my insurers, with each contract's status (history included)
    list: catchAsync(async (req: Request, res: Response, next: NextFunction) => {
      if (!guard(req, next)) return;
      const rows = await InsuranceContract.find(scope(req))
        .populate({ path: "insurance", select: "name slug image" })
        .sort({ _id: -1 })
        .limit(300)
        .lean<IInsuranceContract[]>();
      res.status(200).json({
        message: "getMyInsurerContracts",
        data: sortContracts(rows.filter((r) => r.insurance).map((r) => view(r as never))),
      });
    }) as RequestHandler,
    // POST {insurance, validFrom?, validUntil?, note?} - ask an insurer
    request: catchAsync(async (req: Request, res: Response, next: NextFunction) => {
      if (!guard(req, next)) return;
      const parsed = requestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return next(new BadInputError());
      const c = await requestContract({ kind, provider: providerOf(req, kind)!._id as never, ...parsed.data });
      send(res, "requestInsurerContract", c);
    }) as RequestHandler,
    // POST :nodeId/approve - accept an insurer's invitation
    approve: catchAsync(async (req: Request, res: Response, next: NextFunction) => {
      if (!guard(req, next)) return;
      const c = await decideContract(req.params.nodeId, scope(req), "provider", "approve");
      send(res, "approveInsurerContract", c);
    }) as RequestHandler,
    // POST :nodeId/reject {reason}
    reject: catchAsync(async (req: Request, res: Response, next: NextFunction) => {
      if (!guard(req, next)) return;
      const parsed = reasonSchema.safeParse(req.body ?? {});
      if (!parsed.success) return next(new BadInputError());
      const c = await decideContract(req.params.nodeId, scope(req), "provider", "reject", parsed.data.reason);
      send(res, "rejectInsurerContract", c);
    }) as RequestHandler,
    // POST :nodeId/cancel - withdraw my own pending request
    cancel: catchAsync(async (req: Request, res: Response, next: NextFunction) => {
      if (!guard(req, next)) return;
      const c = await cancelContract(req.params.nodeId, scope(req), "provider");
      send(res, "cancelInsurerContract", c);
    }) as RequestHandler,
    // POST :nodeId/end {reason, endDate?}
    end: catchAsync(async (req: Request, res: Response, next: NextFunction) => {
      if (!guard(req, next)) return;
      const parsed = endSchema.safeParse(req.body ?? {});
      if (!parsed.success) return next(new BadInputError());
      const c = await endContract(req.params.nodeId, scope(req), "provider", parsed.data.reason, parsed.data.endDate);
      send(res, "endInsurerContract", c);
    }) as RequestHandler,
  };
};

// -------------------------------------------------------- insurer side

const insurerScope = (req: Request) => ({ insurance: req.insurance!._id });

// GET /insurance/contract - every contract of this insurer
export const getMyContracts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const rows = await InsuranceContract.find(insurerScope(req))
      .populate({ path: "provider", select: "name firstName lastName slug" })
      .sort({ _id: -1 })
      .limit(1000)
      .lean<IInsuranceContract[]>();
    res.status(200).json({
      message: "getMyContracts",
      data: sortContracts(rows.filter((r) => r.provider).map((r) => view(r as never))),
    });
  },
);

// GET /insurance/contract/providers?kind=&q= - providers to invite: on the
// site, found by name, with the contract each already has with this insurer
export const searchProviders: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const kind = req.query.kind;
    if (!isContractProviderKind(kind)) return next(new BadInputError());
    const q = String(req.query.q || "").trim().slice(0, 60);
    if (q.length < 2) return res.status(200).json({ message: "searchProviders", data: [] });
    const rx = new RegExp(escapeRegex(q), "i");
    const filter =
      kind === "doctor"
        ? { $or: [{ firstName: rx }, { lastName: rx }, { medicalSystemCode: q }] }
        : { name: rx };
    const rows = await providerModelOf(kind)
      .find({ ...filter, [providerActiveField[kind]]: true, status: { $ne: "suspended" } })
      .select("name firstName lastName slug city")
      .populate({ path: "city", select: "name" })
      .limit(20)
      .lean<Record<string, any>[]>();
    const open = await InsuranceContract.find({
      ...insurerScope(req),
      providerKind: kind,
      provider: { $in: rows.map((r) => r._id) },
      open: true,
    })
      .select("provider status")
      .lean<{ provider: unknown; status: string }[]>();
    const statusOf = new Map(open.map((o) => [String(o.provider), o.status]));
    res.status(200).json({
      message: "searchProviders",
      data: rows.map((r) => ({
        _id: String(r._id),
        name: providerNameOf(kind, r),
        slug: r.slug,
        city: r.city?.name || "",
        contract: statusOf.get(String(r._id)) || null,
      })),
    });
  },
);

// POST /insurance/contract {kind, provider, validFrom?, validUntil?, note?}
export const invite: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const parsed = inviteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError());
    const c = await inviteProvider({ insurance: req.insurance._id as never, ...parsed.data });
    send(res, "inviteProvider", c);
  },
);

export const approveRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const c = await decideContract(req.params.nodeId, insurerScope(req), "insurer", "approve");
    send(res, "approveContract", c);
  },
);

export const rejectRequest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const parsed = reasonSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError());
    const c = await decideContract(req.params.nodeId, insurerScope(req), "insurer", "reject", parsed.data.reason);
    send(res, "rejectContract", c);
  },
);

export const cancelInvite: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const c = await cancelContract(req.params.nodeId, insurerScope(req), "insurer");
    send(res, "cancelContract", c);
  },
);

export const endMyContract: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.insurance) return next(new MiddlewareError());
    const parsed = endSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(new BadInputError());
    const c = await endContract(req.params.nodeId, insurerScope(req), "insurer", parsed.data.reason, parsed.data.endDate);
    send(res, "endContract", c);
  },
);

// ----------------------------------------------------------------- admin

// POST /admin/insurancecontract/:nodeId/approve - the admin confirms a
// provider's request to an insurer that has no panel (the requests queue;
// rejecting and reopening are the queue's own actions)
export const adminApprove: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!isValidObjectId(req.params.nodeId)) return next(new NotFoundError());
    const c = await decideContract(req.params.nodeId, {}, "admin", "approve");
    send(res, "adminApproveContract", c);
  },
);
