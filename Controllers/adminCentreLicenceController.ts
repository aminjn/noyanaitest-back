import { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";
import * as z from "zod";
import catchAsync from "../Lib/catchAsync";
import { fromTehranWallClock, tehranYmd } from "../Lib/tehranTime";
import AppError, { BadInputError, NotFoundError } from "../Lib/AppError";
import { escapeRegex } from "../Lib/helpers";
import { withCentreLicenceWrite } from "../Lib/centreLicenceLock";
import {
  CentreKind,
  centreKinds,
  centreLicenceNumberField,
  centreModel,
  centreVerified,
} from "../Lib/centreVerified";

// A centre's operating licence on its admin page (2026-10, owner decision):
// the number, issue and expiry dates, and whether the staff verified it -
// the verified tick of the centre card and page (Lib/centreVerified.ts).
// Only the staff write it (the centre's own profile form has no such
// fields); who verified it and when is kept.
//
//   GET /admin/<kind>/<id>/licence
//   PUT /admin/<kind>/<id>/licence  { number?, issuedAt?, expiresAt?, verified? }
//     (only what changed; null clears a date)

const kindOf = (value: string): CentreKind | null =>
  (centreKinds as readonly string[]).includes(value) ? (value as CentreKind) : null;

type LicenceDoc = {
  _id: unknown;
  name?: string;
  licence?: { verifiedAt?: Date; verifiedBy?: unknown; issuedAt?: Date; expiresAt?: Date };
} & Record<string, unknown>;

const viewOf = (kind: CentreKind, node: LicenceDoc, now = new Date()) => {
  const licence = node.licence || {};
  const expiresAt = licence.expiresAt ? new Date(licence.expiresAt) : null;
  return {
    kind,
    number: String(node[centreLicenceNumberField[kind]] || ""),
    issuedAt: licence.issuedAt || null,
    expiresAt,
    verifiedAt: licence.verifiedAt || null,
    verifiedBy: licence.verifiedBy || null,
    // the tick as the public sees it now
    verified: centreVerified(kind, node, now),
    expired: !!licence.verifiedAt && !!expiresAt && expiresAt.getTime() <= now.getTime(),
  };
};

const load = (kind: CentreKind, id: string) =>
  centreModel(kind)
    .findById(id)
    .select(["name", centreLicenceNumberField[kind], "licence"])
    .populate({ path: "licence.verifiedBy", select: "username phone" })
    .lean<LicenceDoc>();

export const getCentreLicence: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const kind = kindOf(req.params.kind);
    if (!kind || !isValidObjectId(req.params.nodeId)) return next(new NotFoundError());
    const node = await load(kind, req.params.nodeId);
    if (!node) return next(new NotFoundError());
    res.status(200).json({ message: "getCentreLicence", data: viewOf(kind, node) });
  },
);

const dateField = z
  .union([z.coerce.date(), z.null(), z.literal("")])
  .optional()
  .transform((v) => (v === "" ? null : v));

const licenceSchema = z.strictObject({
  number: z.string().trim().max(60).optional(),
  issuedAt: dateField,
  expiresAt: dateField,
  verified: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === true || v === "true")),
});

export const setCentreLicence: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const kind = kindOf(req.params.kind);
    const { nodeId } = req.params;
    if (!kind || !isValidObjectId(nodeId)) return next(new NotFoundError());
    const parsed = licenceSchema.safeParse(req.body || {});
    if (!parsed.success) return next(new BadInputError());
    const input = parsed.data;
    const Model = centreModel(kind);
    const numberField = centreLicenceNumberField[kind];
    const node = await Model.findById(nodeId).select([numberField, "licence"]).lean<LicenceDoc>();
    if (!node) return next(new NotFoundError());
    const now = new Date();
    const before = node.licence || {};
    // the record as it will be: what changed on top of what is saved
    const number = input.number !== undefined ? input.number : String(node[numberField] || "").trim();
    const issuedAt = input.issuedAt !== undefined ? input.issuedAt : before.issuedAt || null;
    // a licence is valid through its expiry day (Tehran): it ends at 23:59
    const expiresAt =
      input.expiresAt !== undefined
        ? input.expiresAt && fromTehranWallClock(tehranYmd(input.expiresAt), 23 * 60 + 59)
        : before.expiresAt || null;
    // a new number is a licence nobody has checked yet: the tick goes until
    // the staff verify it again (with its dates) - unless this same save
    // ticks "verified" for it
    const numberChanged = number !== String(node[numberField] || "").trim();
    const verified = input.verified !== undefined ? input.verified : !!before.verifiedAt && !numberChanged;
    if (issuedAt && expiresAt && new Date(issuedAt).getTime() >= new Date(expiresAt).getTime())
      return next(new AppError("تاریخ انقضای پروانه باید پس از تاریخ صدور آن باشد", 400));
    if (verified) {
      if (!number) return next(new AppError("برای تأیید، شماره‌ی پروانه را وارد کنید", 400));
      if (!expiresAt) return next(new AppError("برای تأیید، تاریخ انقضای پروانه را وارد کنید", 400));
      if (new Date(expiresAt).getTime() <= now.getTime())
        return next(new AppError("پروانه‌ی منقضی‌شده را نمی‌توان تأیید کرد", 400));
    }
    // one licence, one centre of a kind
    if (number) {
      const twin = await Model.findOne({
        _id: { $ne: node._id },
        [numberField]: { $regex: `^\\s*${escapeRegex(number)}\\s*$`, $options: "i" },
      })
        .select("name")
        .lean<{ name?: string }>();
      if (twin)
        return next(new AppError(`این شماره‌ی پروانه برای «${twin.name || ""}» ثبت شده است`, 400));
    }
    const changed =
      number !== String(node[numberField] || "").trim() ||
      String(issuedAt ? new Date(issuedAt).getTime() : "") !== String(before.issuedAt ? new Date(before.issuedAt).getTime() : "") ||
      String(expiresAt ? new Date(expiresAt).getTime() : "") !== String(before.expiresAt ? new Date(before.expiresAt).getTime() : "");
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};
    if (number) $set[numberField] = number;
    else $unset[numberField] = 1;
    if (issuedAt) $set["licence.issuedAt"] = issuedAt;
    else $unset["licence.issuedAt"] = 1;
    if (expiresAt) $set["licence.expiresAt"] = expiresAt;
    else $unset["licence.expiresAt"] = 1;
    // verifying (or saving changes to a verified licence) is this staff
    // member's check, now
    if (verified && (!before.verifiedAt || changed || input.verified === true)) {
      $set["licence.verifiedAt"] = now;
      if (req.user?._id) $set["licence.verifiedBy"] = req.user._id;
    }
    if (!verified) {
      $unset["licence.verifiedAt"] = 1;
      $unset["licence.verifiedBy"] = 1;
    }
    // the one authorised writer of the licence (Lib/centreLicenceLock.ts)
    await withCentreLicenceWrite(() =>
      Model.updateOne(
        { _id: node._id },
        { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) },
      ),
    );
    const after = await load(kind, nodeId);
    res.status(200).json({ message: "setCentreLicence", data: after ? viewOf(kind, after, now) : null });
  },
);
