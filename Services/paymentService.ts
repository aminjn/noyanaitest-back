import { stampOrderResponseDeadlines } from "../Lib/orderResponse";
import { notifyWithSms, smsAmount } from "./notificationSmsService";
import mongoose, { isValidObjectId } from "mongoose";
import { TOMAN_TO_RIAL } from "../Lib/currency";
import {
  BadInputError,
  OnlinePaymentNotAvailableError,
} from "../Lib/AppError";
import { getAppConfig } from "../Lib/appConfig";
import {
  requestSepToken,
  reverseSepTransaction,
  SepCallbackPayload,
  sepPaymentPageUrl,
  toSepCellNumber,
  verifySepTransaction,
} from "../Lib/sepClient";
import GatewayPayment, {
  GatewayPaymentPurpose,
  IGatewayPayment,
} from "../Models/GatewayPayment";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import Order, { IOrder } from "../Models/Order";
import Cart from "../Models/Cart";
import { IUser } from "../Models/User";
import { notifyNewOrderById } from "./orderSmsService";

// Online-gateway payments (2026-09, SEP/Saman - see Lib/sepClient.ts for the
// protocol itself). Two entry points share everything below:
//
//   - wallet top-up   POST /payment/wallet/charge  (purpose "walletCharge")
//   - cart checkout   POST /cart/submit {method:"sep"} (purpose "order")
//
// Every verified payment is first credited to the buyer's wallet (with its
// own +amount Transaction); an "order" payment then debits that amount
// straight back to pay its pending Order, exactly like the wallet checkout
// does. That keeps the Transaction ledger consistent with the wallet
// balance and guarantees a verified payment is never lost: if the order
// can't be completed any more, the money simply stays as wallet balance.
//
// Safety rules taken from the SEP doc:
//   - verify only when State == "OK" and a RefNum came back
//   - never honor the same RefNum twice ("Double Spending") - enforced by a
//     unique index on GatewayPayment.refNum plus a single atomic
//     created -> verifying claim per payment
//   - after verify, the returned OrginalAmount must equal what we asked for
//     (else Reverse it)
//   - retry verify on timeouts; SEP auto-reverses anything left unverified
//     for 30 minutes, so an unverifiable payment is safe to mark failed

export const SEP_CALLBACK_PATH = "/api/v1/payment/sep/callback";

const trimTrailingSlash = (s: string) => s.trim().replace(/\/+$/, "");

export const getSepSettings = async () => {
  const config = await getAppConfig();
  const terminalId = (config.sepTerminalId || "").trim();
  const callbackBaseUrl = trimTrailingSlash(config.sepCallbackBaseUrl || "");
  const siteBaseUrl = trimTrailingSlash(config.siteBaseUrl || "");
  // everything needed to talk to SEP is filled in (regardless of the
  // public on/off switch) - the admin test page only needs this
  const configured = !!terminalId && !!callbackBaseUrl && !!siteBaseUrl;
  return {
    enabled: !!config.sepEnabled,
    configured,
    ready: !!config.sepEnabled && configured,
    terminalId,
    callbackBaseUrl,
    siteBaseUrl,
    multiplier: TOMAN_TO_RIAL,
    tokenExpiryMinutes: config.sepTokenExpiryMinutes || 20,
    minAmount: config.onlinePaymentMinAmount || 1,
  };
};

type SepSettings = Awaited<ReturnType<typeof getSepSettings>>;

// Only same-site absolute paths ("/book/finalize/x?date=..."), never a
// protocol-relative or absolute URL - this is shown as a "continue" link on
// the result page, so it must not become an open redirect.
export const sanitizeReturnPath = (path?: string | null): string | undefined => {
  if (!path) return undefined;
  const p = path.trim();
  if (p.length > 1000) return undefined;
  if (!p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\"))
    return undefined;
  if (/[\u0000-\u001f]/.test(p)) return undefined;
  return p;
};

const cancelPendingOrder = async (orderId?: unknown) => {
  if (!orderId) return;
  await Order.updateOne(
    { _id: orderId, status: "pending" },
    { $set: { status: "cancelled" } },
  );
};

// Moves a payment to a terminal failure state, but only from one of the
// given states - so a late duplicate callback can never overwrite a payment
// another request already settled.
const failPayment = async (
  paymentId: unknown,
  fromStatuses: IGatewayPayment["status"][],
  failureReason: string,
  extra: Partial<IGatewayPayment> = {},
  status: "failed" | "reversed" | "needsReview" = "failed",
) => {
  const updated = await GatewayPayment.findOneAndUpdate(
    { _id: paymentId, status: { $in: fromStatuses } },
    { $set: { ...extra, status, failureReason } },
    { new: true },
  );
  if (updated?.purpose === "order") await cancelPendingOrder(updated.order);
  return updated;
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export const startSepPayment = async ({
  user,
  amount,
  purpose,
  order,
  returnPath,
  ignoreEnabledSwitch = false,
}: {
  user: IUser;
  amount: number;
  purpose: GatewayPaymentPurpose;
  order?: IOrder;
  returnPath?: string;
  // admin test page (paymentController.adminStartSepTest): lets an admin
  // run a real payment while online payment is still switched off for
  // everyone else - the gateway only needs to be configured
  ignoreEnabledSwitch?: boolean;
}): Promise<{ payment: IGatewayPayment; redirectUrl: string }> => {
  const sep = await getSepSettings();
  if (!(ignoreEnabledSwitch ? sep.configured : sep.ready))
    throw new OnlinePaymentNotAvailableError();
  if (!Number.isFinite(amount) || amount < 1) throw new BadInputError();
  const gatewayAmount = Math.round(amount * sep.multiplier);

  const _id = new mongoose.Types.ObjectId();
  const payment = await GatewayPayment.create({
    _id,
    gateway: "sep",
    purpose,
    user: user._id,
    amount,
    gatewayAmount,
    order: order?._id,
    returnPath: sanitizeReturnPath(returnPath),
    resNum: _id.toString(),
    status: "created",
  });
  try {
    const token = await requestSepToken({
      terminalId: sep.terminalId,
      amount: gatewayAmount,
      resNum: payment.resNum,
      redirectUrl: `${sep.callbackBaseUrl}${SEP_CALLBACK_PATH}`,
      cellNumber: toSepCellNumber(user.phone),
      tokenExpiryInMin: sep.tokenExpiryMinutes,
    });
    payment.token = token;
    await payment.save();
    return { payment, redirectUrl: sepPaymentPageUrl(token) };
  } catch (err) {
    await failPayment(payment._id, ["created"], "tokenRequestFailed");
    throw err;
  }
};

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

// Handles SEP's post-payment redirect. Returns the payment id to show the
// result for, or null when the callback doesn't match any payment of ours.
// Idempotent: a refresh/duplicate POST for an already-handled payment just
// returns its id.
export const handleSepCallback = async (
  payload: SepCallbackPayload,
): Promise<string | null> => {
  const resNum = String(payload.ResNum || "").trim();
  if (!resNum || !isValidObjectId(resNum)) return null;
  const payment = await GatewayPayment.findOne({ resNum, gateway: "sep" });
  if (!payment) return null;
  const id = payment._id.toString();
  if (payment.status !== "created") return id;

  const sep = await getSepSettings();
  const state = String(payload.State || "").trim();
  const refNum = String(payload.RefNum || "").trim();
  const terminal = String(payload.TerminalId || payload.MID || "").trim();
  const details: Partial<IGatewayPayment> = {
    state,
    rrn: payload.RRN || payload.Rrn || undefined,
    traceNo: payload.TraceNo || undefined,
    maskedPan: payload.SecurePan || undefined,
  };

  // Not paid (cancelled by user, timed out, failed, ...) - nothing to verify.
  if (state !== "OK" || !refNum) {
    await failPayment(payment._id, ["created"], state || "NoState", details);
    return id;
  }
  if (!sep.terminalId || (terminal && terminal !== sep.terminalId)) {
    // Left unverified on purpose - SEP refunds it automatically.
    await failPayment(payment._id, ["created"], "terminalMismatch", details);
    return id;
  }

  // Claim: exactly one request may move created -> verifying. The unique
  // refNum index rejects a RefNum another payment already consumed.
  let claimed: IGatewayPayment | null;
  try {
    claimed = await GatewayPayment.findOneAndUpdate(
      { _id: payment._id, status: "created" },
      {
        $set: { ...details, refNum, status: "verifying", claimedAt: new Date() },
      },
      { new: true },
    );
  } catch (err) {
    if ((err as { code?: number })?.code === 11000) {
      await failPayment(payment._id, ["created"], "duplicateRefNum", details);
      return id;
    }
    throw err;
  }
  if (!claimed) return id;

  await verifyAndSettle(claimed, sep);
  return id;
};

// ---------------------------------------------------------------------------
// Verify + settle
// ---------------------------------------------------------------------------

const verifyAndSettle = async (payment: IGatewayPayment, sep: SepSettings) => {
  const terminalNumber = Number(sep.terminalId);
  const refNum = payment.refNum as string;

  const result = await verifySepTransaction(refNum, terminalNumber);
  if (!result) {
    // No answer (network, SEP down): the payment may well be verified on
    // SEP's side, so it is NOT failed here - it stays "verifying" and the
    // sweep (runGatewayPaymentSweep, every 10 min) verifies it again. Only
    // once SEP has surely reversed an unverified payment (it does so after
    // 30 minutes) is it marked failed.
    const startedAt = new Date(payment.createdAt || payment.claimedAt || Date.now()).getTime();
    if (Date.now() - startedAt > 45 * 60 * 1000)
      await failPayment(payment._id, ["verifying"], "verifyNoResponse");
    return;
  }

  const verifyInfo = {
    verifyResultCode: result.ResultCode,
    verifyResultDescription: result.ResultDescription,
  };
  const detail = result.TransactionDetail;
  // 0 = verified now; 2 = "repeated request", i.e. already verified by an
  // earlier attempt of OURS (the claim above guarantees nobody else could
  // have verified this RefNum through us).
  const accepted =
    result.Success &&
    (result.ResultCode === 0 || result.ResultCode === 2) &&
    !!detail;
  if (!accepted || !detail) {
    await failPayment(
      payment._id,
      ["verifying"],
      `verify:${result.ResultCode}`,
      verifyInfo,
    );
    return;
  }

  const settledDetails: Partial<IGatewayPayment> = {
    ...verifyInfo,
    rrn: detail.RRN || payment.rrn,
    traceNo: detail.StraceNo || payment.traceNo,
    maskedPan: detail.MaskedPan || payment.maskedPan,
    verifiedAt: new Date(),
  };

  if (
    Number(detail.OrginalAmount) !== payment.gatewayAmount ||
    Number(detail.TerminalNumber) !== terminalNumber
  ) {
    const reversed = await reverseSepTransaction(refNum, terminalNumber);
    await failPayment(
      payment._id,
      ["verifying"],
      "amountMismatch",
      settledDetails,
      reversed?.Success ? "reversed" : "needsReview",
    );
    console.log(
      `[payment] SEP amount/terminal mismatch on ${payment._id}: expected ${payment.gatewayAmount}@${terminalNumber}, got ${detail.OrginalAmount}@${detail.TerminalNumber} - reverse ${reversed?.Success ? "ok" : "FAILED"}`,
    );
    return;
  }

  // Credit the wallet. Guarded by an existing-credit check so a recovery
  // re-run (see runGatewayPaymentSweep) can never credit twice.
  let creditId: unknown;
  try {
    const existing = await Transaction.findOne({
      gatewayPayment: payment._id,
    });
    if (existing) {
      creditId = existing._id;
    } else {
      await Wallet.findOneAndUpdate(
        { user: payment.user },
        { $inc: { balance: payment.amount } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      try {
        const credit = await Transaction.create({
          user: payment.user,
          amount: payment.amount,
          gatewayPayment: payment._id,
        });
        creditId = credit._id;
      } catch (err) {
        await Wallet.findOneAndUpdate(
          { user: payment.user },
          { $inc: { balance: -payment.amount } },
        );
        throw err;
      }
    }
  } catch (err) {
    console.log(`[payment] crediting wallet for ${payment._id} failed:`, err);
    const reversed = await reverseSepTransaction(refNum, terminalNumber);
    await failPayment(
      payment._id,
      ["verifying"],
      "creditFailed",
      settledDetails,
      reversed?.Success ? "reversed" : "needsReview",
    );
    return;
  }

  const paid = await GatewayPayment.findOneAndUpdate(
    { _id: payment._id, status: "verifying" },
    { $set: { ...settledDetails, status: "paid", transaction: creditId } },
    { new: true },
  );
  if (paid?.purpose === "order") await payOrderFromWallet(paid);
  if (paid?.purpose === "walletCharge")
    notifyWithSms("walletChargedUser", paid.user, { amount: smsAmount(paid.amount) });
};

// Settles an "order" payment's pending Order out of the wallet the payment
// was just credited to - same debit/Transaction/link steps as
// cartController.submitCart's wallet branch.
const payOrderFromWallet = async (payment: IGatewayPayment) => {
  const order = await Order.findOne({
    _id: payment.order,
    user: payment.user,
    status: "pending",
  });
  if (!order) {
    console.log(
      `[payment] order ${payment.order} for payment ${payment._id} is no longer pending - amount left in wallet`,
    );
    return;
  }
  if (await Transaction.exists({ order: order._id })) return;

  const debited = await Wallet.findOneAndUpdate(
    { user: payment.user, balance: { $gte: order.total } },
    { $inc: { balance: -order.total } },
  );
  if (!debited) {
    order.status = "cancelled";
    await order.save();
    console.log(
      `[payment] insufficient wallet balance to settle order ${order._id} after payment ${payment._id} - order cancelled, amount left in wallet`,
    );
    return;
  }
  try {
    const debit = await Transaction.create({
      user: payment.user,
      amount: -order.total,
      order: order._id,
    });
    order.transaction = debit._id as unknown as IOrder["transaction"];
    order.status = "paid";
    order.paidAt = new Date();
    // the seller response deadline of each pharmacy / lab line starts now
    await stampOrderResponseDeadlines(order as any);
    await order.save();
  } catch (err) {
    await Wallet.findOneAndUpdate(
      { user: payment.user },
      { $inc: { balance: order.total } },
    );
    console.log(`[payment] settling order ${order._id} failed:`, err);
    return;
  }
  await Cart.findOneAndReplace(
    { owner: payment.user },
    { owner: payment.user },
  );
  notifyNewOrderById(order._id.toString());
};

// ---------------------------------------------------------------------------
// Recovery sweep
// ---------------------------------------------------------------------------

// Run periodically from server.ts:
//   - "created" payments whose token has long expired (shopper closed the
//     tab at the bank) -> failed, and their pending order cancelled
//   - "verifying" payments stuck for 10+ minutes (server restarted mid
//     verify) -> verify again. SEP answers ResultCode 2 if the earlier
//     attempt did verify (settled normally) or -6/-2 if it never did (failed;
//     SEP auto-refunds).
export const runGatewayPaymentSweep = async () => {
  const sep = await getSepSettings();
  const now = Date.now();

  const expiredBefore = new Date(
    now - (sep.tokenExpiryMinutes + 15) * 60 * 1000,
  );
  const expired = await GatewayPayment.find({
    status: "created",
    createdAt: { $lt: expiredBefore },
  }).select("_id");
  for (const p of expired) await failPayment(p._id, ["created"], "expired");

  const stuckBefore = new Date(now - 10 * 60 * 1000);
  const stuck = await GatewayPayment.find({
    status: "verifying",
    claimedAt: { $lt: stuckBefore },
  }).select("_id");
  for (const p of stuck) {
    const reclaimed = await GatewayPayment.findOneAndUpdate(
      { _id: p._id, status: "verifying", claimedAt: { $lt: stuckBefore } },
      { $set: { claimedAt: new Date() } },
      { new: true },
    );
    if (!reclaimed) continue;
    try {
      await verifyAndSettle(reclaimed, sep);
    } catch (err) {
      console.log(`[payment] sweep re-verify of ${p._id} failed:`, err);
    }
  }
};
