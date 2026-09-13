import * as env from "./Env";
import SmsPatterns, { SmsPatternName } from "../Models/SmsPatterns";

// IPPanel's pattern-based SMS send endpoint - used whenever SMS_REQUEST_URL
// isn't set in env. See https://ippanelcom.github.io/Edge-Document/docs/send/
const DEFAULT_SMS_URL = "https://edge.ippanel.com/v1/api/send";

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
export const sendSmsRaw = async (
  to: string,
  patternName: SmsPatternName,
  variables: Record<string, string>,
): Promise<void> => {
  const patterns = await SmsPatterns.findOneAndUpdate(
    { singleton: "SINGLETON" },
    {},
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const pattern = patterns[patternName];

  if (!pattern) throw new Error("SMS pattern not set");

  if (env.NODE_ENV === "development" || !env.SMS_API_TOKEN) {
    console.log(`[SMS] pattern=${pattern} to=${to}`, variables);
    return;
  }

  let response: Response;
  try {
    response = await fetch(env.SMS_REQUEST_URL || DEFAULT_SMS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: env.SMS_API_TOKEN,
      },
      body: JSON.stringify({
        sending_type: "pattern",
        from_number: env.SMS_FROM_NUMBER,
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
): Promise<boolean> => {
  try {
    await sendSmsRaw(to, patternName, payload);
    return true;
  } catch (err) {
    console.log(`[SMS] sendSMS failed — to=${to}`, err);
    return false;
  }
};
