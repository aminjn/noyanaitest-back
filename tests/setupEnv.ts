// Must be the FIRST import of every test file (directly or via ./helpers):
// Lib/Env.ts reads process.env at module load (and throws without
// JWT_SECRET), and dotenv never overrides a key that is already set - so
// blanking the external-service credentials here guarantees a local .env
// can't make the app talk to a real SMS gateway / push service / courier /
// Podium during tests.
process.env.JWT_SECRET = "noyan-integration-test-secret";
// development makes Lib/sendSms.ts log instead of sending
process.env.NODE_ENV = "development";
process.env.RATE_LIMIT_DISABLED = "1";
for (const key of [
  "SMS_API_TOKEN",
  "SMS_REQUEST_URL",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "SNAPP_BASE_URL",
  "SNAPP_USERNAME",
  "SNAPP_PASSWORD",
  "TAPSI_BASE_URL",
  "TAPSI_USERNAME",
  "TAPSI_PASSWORD",
  "PODIUM_TOKEN",
  "GET_IDENTITY_INFO_API_KEY",
  "MATCH_NATIONAL_ID_AND_PHONE_NUMBER_API_KEY",
  "GET_MEDICAL_SYSTEM_CODE_API_KEY",
  "GET_MC_CERTIFICATE_API_KEY",
  "NEXAMAP_API_KEY",
  "ANTHROPIC_API_KEY",
])
  process.env[key] = "";

// The app logs liberally; keep the TAP output readable unless TEST_VERBOSE.
if (!process.env.TEST_VERBOSE) console.log = () => {};

export {};
