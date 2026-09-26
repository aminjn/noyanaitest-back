# Backend env for https://ts.noyanai.com  ->  copy to .env in the repo root
# (Lib/Env.ts loads ./.env relative to the working directory).

# Must be production: in development every OTP is "111111" and SMS is not
# sent, so anyone could log in as any user (including the super admin).
NODE_ENV=production

# Different from the live site's port so both can run on one server.
PORT=5100

# Separate database so the test site never touches live data.
DB_HOST=127.0.0.1
DB_PORT=27017
DB_NAME=NoyanAiTs
DB_USERNAME=
DB_PASSWORD=

# Long random string, e.g. `openssl rand -hex 48`. Do NOT reuse the live one.
JWT_SECRET=CHANGE_ME
JWT_EXPIRES_IN=1

# First super admin(s), comma-separated. Created/promoted on every boot.
SUPER_ADMIN_PHONES=09XXXXXXXXX

OTP_TTL=120
BASE_OTP_INTERVAL=30
OTP_MAX_TRYS=10
OTP_PATTERN=

# SMS (IPPanel)
SMS_API_TOKEN=
SMS_FROM_NUMBER=
SMS_REQUEST_URL=

# Calls (mediasoup). Public IP of the server; UDP+TCP range must be open in
# the firewall and must not overlap the live site's range (40000-49999).
ANNOUNCED_ADDRESS=SERVER_PUBLIC_IP
MEDIASOUP_MIN_PORT=50000
MEDIASOUP_MAX_PORT=50999
MEDIASOUP_NUM_WORKERS=2
CALL_RECORDING_DIR=CallRecordings
FFMPEG_PATH=ffmpeg

# Web push - generate new keys with `npx web-push generate-vapid-keys`
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@noyanai.com

# Couriers
SNAPP_BASE_URL=
SNAPP_USERNAME=
SNAPP_PASSWORD=
TAPSI_BASE_URL=
TAPSI_USERNAME=
TAPSI_PASSWORD=

# Only used to seed AppConfig on first boot; edit later from the admin panel
# (notadmin/appConfig).
SIP_HOST=
SIP_USERNAME=
SIP_PASSWORD=
GET_IDENTITY_INFO_API_KEY=
MATCH_NATIONAL_ID_AND_PHONE_NUMBER_API_KEY=
GET_MEDICAL_SYSTEM_CODE_API_KEY=
GET_MC_CERTIFICATE_API_KEY=
PODIUM_TOKEN=
