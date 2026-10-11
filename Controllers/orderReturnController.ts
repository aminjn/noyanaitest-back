import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import AppError, { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import UserFile from "../Models/UserFile";
import { orderRefundReasons, orderReturnReasons, returnConditions } from "../Models/OrderReturn";
import { sniffExtension } from "./uploadController";
import {
  approveEscalation,
  cancelReturn,
  escalateReturn,
  markReturnShipped,
  receiveReturn,
  refundOrderLine,
  requestReturn,
  sellerDecideReturn,
  ServiceResult,
} from "../Services/orderReturnService";

// The returns flow's endpoints (2026-10, Services/orderReturnService.ts):
// the buyer's (/user), the seller's (/pharmacy, /paraClinic - the lab only
// refunds, a performed test is not sent back) and support's (/admin).

const send = (res: Response, next: NextFunction, result: ServiceResult, message: string) =>
  result.ok ? res.status(200).json({ message, data: result.data ?? null }) : next(new AppError(result.error, result.status));

// ---------------------------------------------------------------- buyer

const requestSchema = z.strictObject({
  model: z.enum(["products", "productPackages"]),
  line: z.string(),
  qty: z.coerce.number().int().min(1).max(1000),
  reason: z.enum(orderReturnReasons),
  note: z.string().trim().max(1000).optional(),
  photos: z.array(z.string()).max(6).optional(),
  unopened: z.boolean().optional(),
});

// POST /user/order/:nodeId/returns
export const requestMyReturn: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  const { nodeId } = req.params;
  if (!isValidObjectId(nodeId)) return next(new NotFoundError());
  const parsed = requestSchema.safeParse(req.body || {});
  if (!parsed.success) return next(new BadInputError());
  const d = parsed.data;
  const result = await requestReturn({
    orderId: nodeId,
    user: req.user._id,
    model: d.model,
    lineId: d.line,
    qty: d.qty,
    reason: d.reason,
    note: d.note,
    photos: d.photos,
    unopened: d.unopened,
  });
  send(res, next, result, "requestMyReturn");
});

// POST /user/returns/photo (multipart: file) - a photo of the item, kept
// private (NotPublic, UserFile "Order") until the request links it to the
// order; returns its id for the request's photos
export const uploadMyReturnPhoto: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  const file = req.file;
  if (!file?.buffer?.length) return next(new BadInputError());
  const declared = (file.originalname.split(".").pop() || "").toLowerCase();
  const ext = sniffExtension(file.buffer, declared);
  if (!ext || !["png", "jpg", "jpeg", "webp"].includes(ext)) return next(new AppError("فقط تصویر پذیرفته می‌شود", 400));
  const name = `Return-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await fs.writeFile(path.join(process.cwd(), "NotPublic", name), file.buffer);
  const doc = await UserFile.create({ chatPath: "Order", readers: [req.user._id], file: name });
  res.status(200).json({ message: "uploadMyReturnPhoto", data: { _id: doc._id } });
});

// POST /user/returns/:returnId/cancel
export const cancelMyReturn: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  send(res, next, await cancelReturn(req.params.returnId, req.user._id), "cancelMyReturn");
});

const shipSchema = z.strictObject({ trackingCode: z.string().trim().max(200).optional() });

// POST /user/returns/:returnId/ship {trackingCode}
export const shipMyReturn: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  const parsed = shipSchema.safeParse(req.body || {});
  if (!parsed.success) return next(new BadInputError());
  send(res, next, await markReturnShipped(req.params.returnId, { kind: "buyer", user: req.user._id }, parsed.data.trackingCode), "shipMyReturn");
});

const escalateSchema = z.strictObject({ note: z.string().trim().max(1000).optional() });

// POST /user/returns/:returnId/escalate {note}
export const escalateMyReturn: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  const parsed = escalateSchema.safeParse(req.body || {});
  if (!parsed.success) return next(new BadInputError());
  send(res, next, await escalateReturn(req.params.returnId, req.user._id, parsed.data.note), "escalateMyReturn");
});

// --------------------------------------------------------------- seller

type SellerKind = "pharmacy" | "paraClinic";
const sellerOfReq = (req: Request, kind: SellerKind) => {
  const org = kind === "pharmacy" ? req.pharmacy : req.paraClinic;
  return org ? { kind, id: org._id } : null;
};

const decideSchema = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().max(500).optional(),
});

// POST /pharmacy/returns/:returnId/decide {decision, reason}
export const decideReturn = (kind: SellerKind): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const seller = sellerOfReq(req, kind);
    if (!req.user || !seller) return next(new MiddlewareError());
    const parsed = decideSchema.safeParse(req.body || {});
    if (!parsed.success) return next(new BadInputError());
    send(
      res,
      next,
      await sellerDecideReturn(req.params.returnId, seller, parsed.data.decision, req.user._id, parsed.data.reason),
      "decideReturn",
    );
  });

// POST /pharmacy/returns/:returnId/pickup {trackingCode} - the courier was sent
export const pickupReturn = (kind: SellerKind): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const seller = sellerOfReq(req, kind);
    if (!req.user || !seller) return next(new MiddlewareError());
    const parsed = shipSchema.safeParse(req.body || {});
    if (!parsed.success) return next(new BadInputError());
    send(
      res,
      next,
      await markReturnShipped(req.params.returnId, { kind: "seller", user: req.user._id, seller }, parsed.data.trackingCode),
      "pickupReturn",
    );
  });

const receiveSchema = z.strictObject({ condition: z.enum(returnConditions).optional() });

// POST /pharmacy/returns/:returnId/receive {condition} - the goods are back
export const receiveSellerReturn = (kind: SellerKind): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const seller = sellerOfReq(req, kind);
    if (!req.user || !seller) return next(new MiddlewareError());
    const parsed = receiveSchema.safeParse(req.body || {});
    if (!parsed.success) return next(new BadInputError());
    send(
      res,
      next,
      await receiveReturn(req.params.returnId, { kind: "seller", user: req.user._id, seller }, parsed.data.condition),
      "receiveReturn",
    );
  });

const refundSchema = z.strictObject({
  model: z.enum(["products", "productPackages", "tests"]),
  line: z.string(),
  qty: z.coerce.number().int().min(1).max(1000),
  reason: z.enum(orderRefundReasons),
  note: z.string().trim().min(3).max(1000),
});

// POST /paraClinic/order/:nodeId/refund - the lab refunds a test it did
export const refundSellerLine = (kind: SellerKind): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const seller = sellerOfReq(req, kind);
    if (!req.user || !seller) return next(new MiddlewareError());
    const parsed = refundSchema.safeParse(req.body || {});
    if (!parsed.success) return next(new AppError("دلیل بازپرداخت را بنویسید (دست‌کم ۳ حرف)", 400));
    const d = parsed.data;
    if ((kind === "paraClinic") !== (d.model === "tests")) return next(new NotFoundError());
    send(
      res,
      next,
      await refundOrderLine({
        orderId: req.params.nodeId,
        model: d.model,
        lineId: d.line,
        qty: d.qty,
        reason: d.reason,
        note: d.note,
        actor: { kind: "seller", user: req.user._id },
        seller,
      }),
      "refundSellerLine",
    );
  });

// ---------------------------------------------------------------- admin

// POST /admin/finance/orders/:nodeId/refund - support refunds a delivered
// line (goods not returned) or a performed test
export const adminRefundLine: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  const parsed = refundSchema.safeParse(req.body || {});
  if (!parsed.success) return next(new AppError("دلیل بازپرداخت را بنویسید (دست‌کم ۳ حرف)", 400));
  const d = parsed.data;
  send(
    res,
    next,
    await refundOrderLine({
      orderId: req.params.nodeId,
      model: d.model,
      lineId: d.line,
      qty: d.qty,
      reason: d.reason,
      note: d.note,
      actor: { kind: "admin", user: req.user._id },
    }),
    "adminRefundLine",
  );
});

// POST /admin/finance/returns/:returnId/receive {condition} - support
// records the goods back with the seller (the seller does not answer)
export const adminReceiveReturn: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  const parsed = receiveSchema.safeParse(req.body || {});
  if (!parsed.success) return next(new BadInputError());
  send(res, next, await receiveReturn(req.params.returnId, { kind: "admin", user: req.user._id }, parsed.data.condition), "adminReceiveReturn");
});

// POST /admin/requests/return/:kind/:nodeId/approve - the queue's approve
export const adminApproveReturnEscalation: RequestHandler = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new MiddlewareError());
  send(res, next, await approveEscalation(req.params.nodeId, req.user._id), "approveReturnEscalation");
});
