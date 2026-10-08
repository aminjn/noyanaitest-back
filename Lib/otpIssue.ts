import * as env from "./Env";
import { randomCode } from "./helpers";
import { sendSMS } from "./sendSms";
import { Locale } from "./locales";

// One rule for "send me a login code" (login and sign-up):
// - the wait before another SMS is 1 min for the first two sends, then
//   doubles (2, 4, 8 min) and never passes 15 min - the old rule doubled
//   from the first send and never forgot, so after a few logins a phone
//   waited up to two hours with no SMS and no word on screen;
// - an hour without a send starts the count again;
// - a code still alive is sent again (one code at a time), else a new one;
// - a failed SMS counts for nothing: the next tap tries again at once.
// The caller gets `retryAfter` (seconds) either way, so the screen can show
// the real countdown, and `sent: false` when it has to wait.
const MAX_WAIT = 15 * 60;
const FORGET_AFTER = 60 * 60 * 1000;

type OtpToken = {
  code?: string;
  lastSent?: Date;
  sendCount: number;
  isExpired: () => boolean;
  save: () => Promise<unknown>;
};

const waitAfter = (sends: number) =>
  Math.min(MAX_WAIT, env.BASE_OTP_INTERVAL * 2 * Math.pow(2, Math.max(0, sends - 2)));

const secondsLeft = (token: OtpToken, now: number) => {
  if (!token.lastSent) return 0;
  const next = new Date(token.lastSent).getTime() + waitAfter(token.sendCount) * 1000;
  return Math.max(0, Math.ceil((next - now) / 1000));
};

export type OtpIssueResult =
  | { sent: true; retryAfter: number }
  | { sent: false; retryAfter: number }
  | { failed: true };

export const issueOtp = async (
  token: OtpToken,
  phone: string,
  options: { locale?: Locale; onUnsent?: (code: string) => boolean } = {},
): Promise<OtpIssueResult> => {
  const now = Date.now();
  if (token.lastSent && now - new Date(token.lastSent).getTime() > FORGET_AFTER) token.sendCount = 0;
  const wait = secondsLeft(token, now);
  if (wait > 0) return { sent: false, retryAfter: wait };
  const code = !token.isExpired() && token.code ? token.code : randomCode();
  let ok = await sendSMS(phone, { OTP: code }, "OTP_PATTERN", { locale: options.locale });
  if (!ok && options.onUnsent) ok = options.onUnsent(code);
  if (!ok) {
    await token.save();
    return { failed: true };
  }
  token.code = code;
  token.lastSent = new Date(now);
  token.sendCount = (token.sendCount || 0) + 1;
  await token.save();
  return { sent: true, retryAfter: waitAfter(token.sendCount) };
};
