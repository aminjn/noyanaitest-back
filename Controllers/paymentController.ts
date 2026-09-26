import { NextFunction, Request, RequestHandler, Response } from "express";
import z from "zod";
import { isValidObjectId } from "mongoose";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  MiddlewareError,
  NotFoundError,
  OnlinePaymentNotAvailableError,
} from "../Lib/AppError";
import GatewayPayment from "../Models/GatewayPayment";
import {
  getSepSettings,
  handleSepCallback,
  SEP_CALLBACK_PATH,
  startSepPayment,
} from "../Services/paymentService";
import { SepCallbackPayload } from "../Lib/sepClient";

// Online payment endpoints (2026-09, SEP/Saman) - see
// Services/paymentService.ts for the flow and its safety rules.

// Lets the frontend decide whether to show online-payment options at all.
export const getPaymentConfig: RequestHandler = catchAsync(
  async (req: Request, res: Response) => {
    const sep = await getSepSettings();
    res.status(200).json({
      message: "getPaymentConfig",
      data: { sepEnabled: sep.ready, minAmount: sep.minAmount },
    });
  },
);

const chargeWalletSchema = z.strictObject({
  amount: z.coerce.number().int().positive(),
  returnPath: z.string().max(1000).optional(),
});

// Wallet top-up: returns the SEP payment page URL to send the browser to.
export const chargeWallet: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, error, success } = await chargeWalletSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError(error.message));
    const sep = await getSepSettings();
    if (!sep.ready) return next(new OnlinePaymentNotAvailableError());
    if (data.amount < sep.minAmount)
      return next(
        new AppError(
          `حداقل مبلغ شارژ کیف پول ${sep.minAmount.toLocaleString("fa-IR")} تومان است`,
          400,
        ),
      );
    const { payment, redirectUrl } = await startSepPayment({
      user: req.user,
      amount: data.amount,
      purpose: "walletCharge",
      returnPath: data.returnPath,
    });
    res.status(200).json({
      message: "chargeWallet",
      data: { payment: payment._id, redirectUrl },
    });
  },
);

// SEP redirects the shopper's browser here (form POST, or GET query string
// if GetMethod was used). Public on purpose: it's a cross-site top-level
// POST, so the auth cookie may not be sent - the payment is identified by
// ResNum instead. Always ends by redirecting the browser to the frontend
// result page, never with a JSON error.
export const sepCallback: RequestHandler = async (
  req: Request,
  res: Response,
) => {
  const payload = {
    ...(req.query as Record<string, string>),
    ...((req.body || {}) as Record<string, string>),
  } as SepCallbackPayload;
  let paymentId: string | null = null;
  try {
    paymentId = await handleSepCallback(payload);
  } catch (err) {
    // Whatever state the payment was left in, the recovery sweep settles it;
    // the result page polls until it's final.
    console.log("[payment] SEP callback handling failed:", err);
    const resNum = String(payload.ResNum || "");
    if (isValidObjectId(resNum)) paymentId = resNum;
  }
  let siteBaseUrl = "";
  try {
    siteBaseUrl = (await getSepSettings()).siteBaseUrl;
  } catch (err) {
    console.log("[payment] could not read siteBaseUrl:", err);
  }
  const target = paymentId
    ? `${siteBaseUrl}/payment/${paymentId}`
    : `${siteBaseUrl}/dashboard/transaction`;
  res.redirect(303, target || "/");
};

// The result page's data source - only the payment's own buyer can read it.
export const getMyPayment: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const data = await GatewayPayment.findOne({
      _id: nodeId,
      user: req.user._id,
    }).select(
      "gateway purpose amount order returnPath status refNum rrn traceNo maskedPan failureReason verifyResultDescription createdAt verifiedAt",
    );
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getMyPayment", data });
  },
);

// ---- Admin SEP test page (2026-09) ----
// Components/Admin/Sep/AdminSepTestPage.tsx on noyanai-front. The test is a
// REAL payment through the normal flow: a wallet top-up for the logged-in
// admin (SEP page -> callback -> verify -> wallet credit -> /payment/<id>).
// It only skips the public on/off switch and the minimum top-up amount, so
// the gateway can be tried before it's shown to users.

// Config checklist + the admin's own recent gateway payments.
export const adminGetSepTest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const sep = await getSepSettings();
    const payments = await GatewayPayment.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .select(
        "purpose amount gatewayAmount status refNum rrn traceNo maskedPan state verifyResultCode verifyResultDescription failureReason createdAt verifiedAt",
      );
    res.status(200).json({
      message: "adminGetSepTest",
      data: {
        config: {
          enabled: sep.enabled,
          configured: sep.configured,
          terminalId: sep.terminalId,
          callbackUrl: sep.callbackBaseUrl
            ? `${sep.callbackBaseUrl}${SEP_CALLBACK_PATH}`
            : "",
          siteBaseUrl: sep.siteBaseUrl,
          multiplier: sep.multiplier,
          tokenExpiryMinutes: sep.tokenExpiryMinutes,
        },
        payments,
      },
    });
  },
);

const adminStartSepTestSchema = z.strictObject({
  amount: z.coerce.number().int().positive(),
  returnPath: z.string().max(1000).optional(),
});

export const adminStartSepTest: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, error, success } =
      await adminStartSepTestSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError(error.message));
    const { payment, redirectUrl } = await startSepPayment({
      user: req.user,
      amount: data.amount,
      purpose: "walletCharge",
      returnPath: data.returnPath,
      ignoreEnabledSwitch: true,
    });
    res.status(200).json({
      message: "adminStartSepTest",
      data: { payment: payment._id, redirectUrl },
    });
  },
);
