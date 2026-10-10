import SmsGatewaySettings from "../Models/SmsGatewaySettings";

// The super admin's rules for advertising SMS (2026-10, /notadmin/appConfig
// ?tab=sms, Models/SmsGatewaySettings.ts): the Tehran hours they may leave
// in (the quiet hours are the rest of the day; 08:00-21:00 by default, the
// operators' rule) and how many one provider may send in a Tehran day
// (0 = no cap). Read synchronously by the window checks of campaigns,
// automations and one-off sends, so it is kept in memory and reloaded by
// the campaign job every minute and whenever the admin saves it.

export type SmsPolicy = { from: number; until: number; dailyCap: number };

export const DEFAULT_SMS_POLICY: SmsPolicy = { from: 8, until: 21, dailyCap: 0 };

let current: SmsPolicy = { ...DEFAULT_SMS_POLICY };

const clampHour = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export const normalizeSmsPolicy = (s?: { campaignWindowFrom?: number; campaignWindowUntil?: number; campaignDailyCap?: number } | null): SmsPolicy => {
  const from = clampHour(s?.campaignWindowFrom, 0, 23, DEFAULT_SMS_POLICY.from);
  const until = clampHour(s?.campaignWindowUntil, 1, 24, DEFAULT_SMS_POLICY.until);
  // the operators' quiet hours are a floor: the admin may narrow the
  // window (start later, stop earlier), never open it past 08:00-21:00
  const fromF = Math.max(from, DEFAULT_SMS_POLICY.from);
  const untilF = Math.min(until, DEFAULT_SMS_POLICY.until);
  const ok = untilF > fromF;
  return {
    from: ok ? fromF : DEFAULT_SMS_POLICY.from,
    until: ok ? untilF : DEFAULT_SMS_POLICY.until,
    dailyCap: Math.max(0, Math.floor(Number(s?.campaignDailyCap) || 0)),
  };
};

export const smsPolicy = (): SmsPolicy => current;

export const loadSmsPolicy = async (): Promise<SmsPolicy> => {
  const s = await SmsGatewaySettings.findOne({ singleton: "SINGLETON" })
    .select("campaignWindowFrom campaignWindowUntil campaignDailyCap")
    .lean()
    .catch(() => null);
  current = normalizeSmsPolicy(s);
  return current;
};
