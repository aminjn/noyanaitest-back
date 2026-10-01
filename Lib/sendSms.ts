import * as env from "./Env";
import SmsPatterns, { SmsPatternName } from "../Models/SmsPatterns";
import SmsGatewaySettings from "../Models/SmsGatewaySettings";
import User from "../Models/User";
import SmsLog, { SmsLogStatus } from "../Models/SmsLog";
import { isLocale, Locale, siteDefaultLocale } from "./locales";

// IPPanel's pattern-based SMS send endpoint - used whenever SMS_REQUEST_URL
// isn't set in env. See https://ippanelcom.github.io/Edge-Document/docs/send/
const DEFAULT_SMS_URL = "https://edge.ippanel.com/v1/api/send";

// Effective gateway settings: what the admin saved in the panel, else .env.
// Cached briefly - OTPs are sent on every login.
let cachedGateway: { at: number; value: SmsGateway } | null = null;
type SmsGateway = { token: string; fromNumber: string; url: string };

export const getSmsGateway = async (): Promise<SmsGateway> => {
  if (cachedGateway && Date.now() - cachedGateway.at < 30_000)
    return cachedGateway.value;
  const saved = await SmsGatewaySettings.findOne({ singleton: "SINGLETON" })
    .select("+apiToken")
    .lean();
  const value = {
    token: saved?.apiToken || env.SMS_API_TOKEN,
    fromNumber: saved?.fromNumber || env.SMS_FROM_NUMBER,
    url: saved?.requestUrl || env.SMS_REQUEST_URL || DEFAULT_SMS_URL,
  };
  cachedGateway = { at: Date.now(), value };
  return value;
};

export const clearSmsGatewayCache = () => {
  cachedGateway = null;
};

interface IppanelSendResponse {
  data: { message_outbox_ids?: number[] } | null;
  meta: {
    status: boolean;
    message: string;
    message_code?: string;
    errors?: Record<string, string[]>;
  };
}

// `patternName` identifies *which* pattern to send (Models/SmsPatterns.ts's
// smsPatternNames, e.g. "OTP_PATTERN") - callers never see or pass the
// actual gateway pattern code. This resolves it from the DB-backed
// SmsPatterns singleton itself on every call (upserting it first, so a
// fresh database still works and picks up its env-var default - see
// Models/SmsPatterns.ts) rather than making every caller fetch it first.
// The recipient's language: `locale` when the caller knows it (the OTP
// request's own language, staff alerts in the site default), else the
// language the account with this phone last used, else the site default.
// That language's own pattern code wins when the admin set one; otherwise
// the base code is sent.
const recipientLocale = async (to: string): Promise<Locale> => {
  const user = await User.findOne({ phone: to }).select("locale").lean<{ locale?: string }>();
  return isLocale(user?.locale) ? user!.locale : siteDefaultLocale();
};

const PATTERN_NOT_SET = "SMS pattern not set";

// One SmsLog row per attempt (Models/SmsLog.ts) - best effort: logging must
// never fail or delay an OTP. Variables are not stored (they hold the code).
const logSms = (entry: {
  to: string;
  pattern: string;
  code?: string;
  locale?: string;
  status: SmsLogStatus;
  error?: string;
  outboxId?: string;
}) => {
  SmsLog.create({ ...entry, error: entry.error?.slice(0, 1000) }).catch((err) =>
    console.log("[SMS] log write failed:", err),
  );
};

export const sendSmsRaw = async (
  to: string,
  patternName: SmsPatternName,
  variables: Record<string, string>,
  options: { locale?: Locale } = {},
): Promise<void> => {
  let result: SendResult;
  try {
    result = await sendSmsUnlogged(to, patternName, variables, options);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logSms({
      to,
      pattern: patternName,
      // an event whose pattern the admin left empty is "not sent on
      // purpose", not a gateway failure
      status: error === PATTERN_NOT_SET ? "skipped" : "failed",
      error,
    });
    throw err;
  }
  logSms({
    to,
    pattern: patternName,
    code: result.code,
    locale: result.locale,
    outboxId: result.outboxId,
    // development / no gateway token: printed to the console, not sent
    status: result.delivered ? "sent" : "skipped",
  });
};

type SendResult = {
  code: string;
  locale?: string;
  outboxId?: string;
  delivered: boolean;
};

const sendSmsUnlogged = async (
  to: string,
  patternName: SmsPatternName,
  variables: Record<string, string>,
  options: { locale?: Locale } = {},
): Promise<SendResult> => {
  const patterns = await SmsPatterns.findOneAndUpdate(
    { singleton: "SINGLETON" },
    {},
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const localized = patterns.localized?.[patternName];
  const locale =
    localized && Object.keys(localized).length
      ? options.locale ?? (await recipientLocale(to))
      : undefined;
  const pattern = (locale && localized?.[locale]) || patterns[patternName];

  if (!pattern) throw new Error(PATTERN_NOT_SET);

  const gateway = await getSmsGateway();
  if (env.NODE_ENV === "development" || !gateway.token) {
    console.log(`[SMS] pattern=${pattern} to=${to}`, variables);
    return { code: pattern, locale, delivered: false };
  }

  let response: Response;
  try {
    response = await fetch(gateway.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: gateway.token,
      },
      body: JSON.stringify({
        sending_type: "pattern",
        from_number: gateway.fromNumber,
        code: pattern,
        // Endpoint only accepts a single recipient.
        recipients: [to],
        params: variables,
      }),
    });
  } catch (err) {
    console.log(`[SMS] request failed — pattern=${pattern} to=${to}`, err);
    throw err;
  }

  let body: IppanelSendResponse | undefined;
  try {
    body = await response.json();
  } catch {
    // Gateway didn't return JSON — fall through with body left undefined.
  }

  if (!response.ok || !body?.meta?.status) {
    const message = body?.meta?.message || "Unknown SMS gateway error";
    console.log(
      `[SMS] gateway error — pattern=${pattern} to=${to}: ${message}`,
    );
    throw new Error(message);
  }
  const outbox = body.data?.message_outbox_ids?.[0];
  return {
    code: pattern,
    locale,
    outboxId: outbox !== undefined ? String(outbox) : undefined,
    delivered: true,
  };
};

// Convenience wrapper around sendSmsRaw for callers that just want a
// success/failure boolean instead of a throwing promise (e.g. deciding
// whether to persist an OTP code, or a fire-and-forget notification that
// should log and move on rather than reject). Used to live in Lib/helpers.ts
// as `sendSMS`; moved here to keep every SMS-sending function in one file.
export const sendSMS = async (
  to: string,
  payload: Record<string, string>,
  patternName: SmsPatternName,
  options: { locale?: Locale } = {},
): Promise<boolean> => {
  try {
    await sendSmsRaw(to, patternName, payload, options);
    return true;
  } catch (err) {
    console.log(`[SMS] sendSMS failed — to=${to}`, err);
    return false;
  }
};
