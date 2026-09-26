import { SepRequestError } from "./AppError";

// Thin client for SEP (Saman Electronic Payment / سپ) online payment gateway,
// per "راهنمای استفاده از درگاه پرداخت اینترنتی - مستند فنی نگارش 3.3"
// (Esfand 1402). Token-based flow:
//
//   1. requestToken()   server -> SEP: get a one-time token for this payment
//                       (merchant server IP must be whitelisted at SEP)
//   2. browser -> sepPaymentPageUrl(token): shopper pays on SEP's own page
//   3. SEP -> browser -> our RedirectUrl: form POST with State/RefNum/...
//   4. verifyTransaction() within 30 minutes, or SEP auto-reverses the
//      payment back to the card
//   5. reverseTransaction() (optional, within 50 minutes) to refund a
//      payment we verified but can't honor
//
// Field names are case-sensitive per the doc ("نکته ۴") - they're spelled
// here exactly as the doc's own request samples spell them. Amounts passed
// in/out of this file are always in RIAL (the gateway's unit); converting
// from the app's Toman happens in Services/paymentService.ts.
//
// Configuration (terminal id etc.) lives in the AppConfig singleton, not
// here - callers pass what they need, so this file stays side-effect free.

const SEP_TOKEN_URL = "https://sep.shaparak.ir/onlinepg/onlinepg";
const SEP_SEND_TOKEN_URL = "https://sep.shaparak.ir/OnlinePG/SendToken";
const SEP_VERIFY_URL =
  "https://sep.shaparak.ir/verifyTxnRandomSessionkey/ipg/VerifyTransaction";
const SEP_REVERSE_URL =
  "https://sep.shaparak.ir/verifyTxnRandomSessionkey/ipg/ReverseTransaction";

const REQUEST_TIMEOUT_MS = 20 * 1000;

// "جدول وضعیت تراکنش" - the numeric Status / textual State SEP posts back to
// the RedirectUrl (and uses as errorCode on a failed token request).
export const sepTransactionStates: Record<number, string> = {
  1: "CanceledByUser",
  2: "OK",
  3: "Failed",
  4: "SessionIsNull",
  5: "InvalidParameters",
  8: "MerchantIpAddressIsInvalid",
  10: "TokenNotFound",
  11: "TokenRequired",
  12: "TerminalNotFound",
  21: "MultisettlePolicyErrors",
};

// VerifyTransaction / ReverseTransaction ResultCode table (doc v3.3).
export const sepVerifyResultCodes: Record<number, string> = {
  [-2]: "تراکنش یافت نشد",
  [-6]: "بیش از نیم ساعت از زمان اجرای تراکنش گذشته است",
  0: "موفق",
  2: "درخواست تکراری می باشد",
  [-105]: "ترمینال ارسالی در سیستم موجود نمی باشد",
  [-104]: "ترمینال ارسالی غیرفعال می باشد",
  [-106]: "آدرس آی پی درخواستی غیر مجاز می باشد",
  5: "تراکنش برگشت خورده می باشد",
};

// Normalizes an Iranian mobile number to the 10-digit "9xxxxxxxxx" form the
// doc's CellNumber sample uses. Returns undefined if it doesn't look like a
// mobile number - CellNumber is optional (only used to offer saved cards).
export const toSepCellNumber = (phone?: string | null): string | undefined => {
  if (!phone) return undefined;
  const digits = phone
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/\D/g, "");
  const last10 = digits.slice(-10);
  return /^9\d{9}$/.test(last10) ? last10 : undefined;
};

const postJson = async <T>(url: string, body: unknown): Promise<T> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `[SEP] non-JSON response from ${url} (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
};

// ---- 1. Token ----

export interface SepTokenRequest {
  terminalId: string;
  amount: number; // Rial, integer
  resNum: string; // our unique purchase id, <= 50 chars
  redirectUrl: string; // <= 2083 chars
  cellNumber?: string;
  tokenExpiryInMin?: number;
}

type SepTokenResponse =
  | { status: 1; token: string }
  | { status: -1; errorCode: string; errorDesc: string };

export const requestSepToken = async (
  input: SepTokenRequest,
): Promise<string> => {
  let data: SepTokenResponse;
  try {
    data = await postJson<SepTokenResponse>(SEP_TOKEN_URL, {
      action: "token",
      TerminalId: input.terminalId,
      Amount: input.amount,
      ResNum: input.resNum,
      RedirectUrl: input.redirectUrl,
      ...(input.cellNumber ? { CellNumber: input.cellNumber } : {}),
      ...(input.tokenExpiryInMin
        ? { TokenExpiryInMin: input.tokenExpiryInMin }
        : {}),
    });
  } catch (err) {
    console.log("[SEP] token request failed:", err);
    throw new SepRequestError();
  }
  if (data.status === 1 && data.token) return data.token;
  const failed = data as Extract<SepTokenResponse, { status: -1 }>;
  console.log(
    `[SEP] token refused resNum=${input.resNum} code=${failed.errorCode}: ${failed.errorDesc}`,
  );
  throw new SepRequestError(failed.errorDesc);
};

// Where to send the shopper's browser once a token exists - the doc's GET
// ("SendToken") variant, so the frontend can just assign window.location.
export const sepPaymentPageUrl = (token: string) =>
  `${SEP_SEND_TOKEN_URL}?token=${encodeURIComponent(token)}`;

// ---- 3. Callback payload ----

// What SEP form-POSTs to our RedirectUrl ("پارامترهای ارسالی به فروشنده").
// All values arrive as strings.
export interface SepCallbackPayload {
  MID?: string;
  TerminalId?: string;
  State?: string;
  Status?: string;
  RRN?: string;
  Rrn?: string;
  RefNum?: string;
  ResNum?: string;
  TraceNo?: string;
  Amount?: string;
  AffectiveAmount?: string;
  Wage?: string;
  SecurePan?: string;
  HashedCardNumber?: string;
  Token?: string;
}

// ---- 4/5. Verify & reverse ----

export interface SepVerifyInfo {
  RRN: string;
  RefNum: string;
  MaskedPan: string;
  HashedPan: string;
  TerminalNumber: number;
  OrginalAmount: number; // sic - spelled this way by SEP
  AffectiveAmount: number;
  StraceDate: string;
  StraceNo: string;
}

export interface SepVerifyResponse {
  TransactionDetail?: SepVerifyInfo | null;
  ResultCode: number;
  ResultDescription: string;
  Success: boolean;
}

// The doc ("نکات" ب, and section 6) asks merchants to RETRY verify when no
// answer arrives (timeout / network error) - but not when SEP answered with
// a failure. So: retry only thrown/transport errors, return any parsed
// answer as-is. Returns null if every attempt failed to get an answer.
const callWithRetry = async (
  url: string,
  refNum: string,
  terminalNumber: number,
  attempts = 3,
): Promise<SepVerifyResponse | null> => {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await postJson<SepVerifyResponse>(url, {
        RefNum: refNum,
        TerminalNumber: terminalNumber,
      });
    } catch (err) {
      console.log(`[SEP] ${url} attempt ${i}/${attempts} failed:`, err);
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  return null;
};

export const verifySepTransaction = (refNum: string, terminalNumber: number) =>
  callWithRetry(SEP_VERIFY_URL, refNum, terminalNumber);

export const reverseSepTransaction = (refNum: string, terminalNumber: number) =>
  callWithRetry(SEP_REVERSE_URL, refNum, terminalNumber);
