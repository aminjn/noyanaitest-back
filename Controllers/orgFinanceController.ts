import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { MiddlewareError } from "../Lib/AppError";
import { buildOrgFinance, financePage, OrgFinanceKind } from "../Lib/orgFinance";

// GET /<org>/finance for the lab, clinic, hospital and insurer panels
// (2026-10); see Lib/orgFinance.ts.
export const getMyOrgFinance = (kind: OrgFinanceKind): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const org = req[kind] as { _id: unknown; user?: unknown } | undefined;
    if (!org) return next(new MiddlewareError());
    const data = await buildOrgFinance(req, kind, org, financePage(req));
    res.status(200).json({ message: "getMyOrgFinance", data });
  });
