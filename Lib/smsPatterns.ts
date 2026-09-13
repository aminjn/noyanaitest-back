// Deprecated / no longer used. getSmsPatterns() used to live here but was
// removed - Lib/sendSms.ts's sendSmsRaw/sendSMS now resolve pattern codes
// from the DB-backed SmsPatterns singleton (Models/SmsPatterns.ts)
// internally, so callers just pass a SmsPatternName instead of fetching
// the singleton themselves first.
//
// This file has no exports and nothing imports it - it's kept only because
// the sandbox's shell access was down when this change was made, so the
// file itself couldn't be deleted. Delete it the next time you have a
// working shell (`rm Lib/smsPatterns.ts`) or via your editor.
export {};
