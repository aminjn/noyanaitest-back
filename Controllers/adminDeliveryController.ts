import { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import catchAsync from "../Lib/catchAsync";
import { BadInputError } from "../Lib/AppError";
import DeliverySettings, {
  DEFAULT_TAPSI_FLAT_FEE,
  DEFAULT_TIPAX_AUTO_CONFIRM_DAYS,
  DEFAULT_TIPAX_SEND_DAYS,
  DEFAULT_TIPAX_TRACKING_URL,
} from "../Models/DeliverySettings";
import City from "../Models/Geo/City";

// Super admin: how cart orders are shipped (Lib/delivery.ts) - the Tapsi
// flat fee until its API is connected, and the city pharmacies without one
// ship from.

// GET /admin/delivery/settings
export const getDeliverySettingsAdmin: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const saved = await DeliverySettings.findOne({ singleton: "SINGLETON" })
      .populate({ path: "defaultOriginCity", select: "name" })
      .populate({ path: "updatedBy", select: "phone username" })
      .lean();
    const tehran = await City.findOne({ name: "تهران" }).select("name").lean();
    res.status(200).json({
      message: "getDeliverySettings",
      data: {
        tapsiFlatFee: saved?.tapsiFlatFee ?? DEFAULT_TAPSI_FLAT_FEE,
        defaultOriginCity: saved?.defaultOriginCity || null,
        // Tipax delivery confirmation (2026-10, Services/shipmentDeliveryService.ts)
        tipaxAutoConfirmDays: saved?.tipaxAutoConfirmDays ?? DEFAULT_TIPAX_AUTO_CONFIRM_DAYS,
        // a prepared Tipax parcel never sent is cancelled and refunded after it
        tipaxSendDays: saved?.tipaxSendDays ?? DEFAULT_TIPAX_SEND_DAYS,
        tipaxTrackingUrl: saved?.tipaxTrackingUrl || DEFAULT_TIPAX_TRACKING_URL,
        // what an unset origin falls back to
        fallbackOriginCity: tehran || null,
        updatedAt: saved?.updatedAt || null,
        updatedBy: saved?.updatedBy || null,
      },
    });
  },
);

const saveSchema = z.strictObject({
  tapsiFlatFee: z.coerce.number().int().min(0).max(100_000_000).optional(),
  // "" clears it (back to Tehran)
  defaultOriginCity: z
    .union([z.literal(""), z.string().regex(/^[0-9a-fA-F]{24}$/)])
    .optional(),
  tipaxAutoConfirmDays: z.coerce.number().int().min(1).max(30).optional(),
  tipaxSendDays: z.coerce.number().int().min(1).max(14).optional(),
  // "" goes back to the default; {code} is the waybill number
  tipaxTrackingUrl: z
    .union([z.literal(""), z.string().trim().max(300).regex(/^https?:\/\/\S+$/i)])
    .optional(),
});

// POST /admin/delivery/settings
export const saveDeliverySettingsAdmin: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { data, success } = saveSchema.safeParse(req.body || {});
    if (!success) return next(new BadInputError());
    const $set: Record<string, unknown> = {
      updatedBy: req.user?._id,
      updatedAt: new Date(),
    };
    const $unset: Record<string, 1> = {};
    if (data.tapsiFlatFee !== undefined) $set.tapsiFlatFee = data.tapsiFlatFee;
    if (data.tipaxAutoConfirmDays !== undefined)
      $set.tipaxAutoConfirmDays = data.tipaxAutoConfirmDays;
    if (data.tipaxSendDays !== undefined) $set.tipaxSendDays = data.tipaxSendDays;
    if (data.tipaxTrackingUrl === "") $unset.tipaxTrackingUrl = 1;
    else if (data.tipaxTrackingUrl) $set.tipaxTrackingUrl = data.tipaxTrackingUrl;
    if (data.defaultOriginCity === "") $unset.defaultOriginCity = 1;
    else if (data.defaultOriginCity) {
      if (!(await City.exists({ _id: data.defaultOriginCity })))
        return next(new BadInputError());
      $set.defaultOriginCity = data.defaultOriginCity;
    }
    await DeliverySettings.findOneAndUpdate(
      { singleton: "SINGLETON" },
      { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
      { upsert: true },
    );
    res.status(200).json({ message: "saveDeliverySettings" });
  },
);
