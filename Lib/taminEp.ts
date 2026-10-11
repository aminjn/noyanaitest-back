import "./Env";
import AppError, {
  BadTaminResponseError,
  MissingTaminTokenError,
} from "./AppError";
import DoctorTaminCred, { IDoctorTaminCred } from "../Models/DoctorTaminCred";
import DoctorProfile, { IDoctorProfile } from "../Models/DoctorProfile";
import User from "../Models/User";
import { IUserIdentity } from "../Models/UserIdentity";
import { getAppConfig } from "./appConfig";
import { tehranMoment } from "./tehranTime";

// Tamin e-prescription (نسخه نویسی الکترونیک) client of the doctor panel
// -----------------------------------------------------------------------
// Follows "راهنمای سرویس نسخه نویسی الکترونیک" v1.9.9 (1405/06/23). Every
// doctor-panel call to Tamin goes through here so the environment, the
// doctor's identity and the token lifecycle are handled in one place.
// (Pharmacy, clinic and paraClinic still talk to the sandbox and stay
// behind the lockout, Controllers/featureGateController.ts.)
//
// Configuration:
//   TAMIN_EP_ENV (.env)        "production" (default) | "test"
//   client id                  AppConfig.taminEpClientId (super admin,
//                              «تامین اجتماعی» > «اتصال نسخه‌نویسی»), else
//                              TAMIN_EP_CLIENT_ID (test: "portal-js")
//   redirect uri               AppConfig.taminEpRedirectUri, else
//                              TAMIN_EP_REDIRECT_URI, else
//                              `${AppConfig.siteBaseUrl}/doctorpanel/tamin`.
//                              Must be the address registered with Tamin -
//                              static, https, no query params. The doctor
//                              panel's callback page is /doctorpanel/tamin.
//
// The test environment additionally needs `clientId` on SendEpresc and a
// `requestBy` segment on deserve-info (both the doctor's national code),
// and uses different paths for fetch/edit/remove.
//
// Privacy: access and refresh tokens stay in DoctorTaminCred (the refresh
// token is select: false) and are never returned or logged; the patient's
// national code and mobile are only put into the requests to Tamin.

export type TaminEpEnv = "production" | "test";
export const taminEpEnv: TaminEpEnv =
  process.env.TAMIN_EP_ENV === "test" ? "test" : "production";
const isTest = taminEpEnv === "test";

const ACCOUNT = isTest
  ? "https://account-pilot.tamin.ir"
  : "https://account.tamin.ir";
const SEND_EPRESC = isTest
  ? "https://ep-test.tamin.ir/api/v2"
  : "https://soa.tamin.ir/interface/epresc/SendEpresc/v2";

const trimSlash = (v: string) => v.replace(/\/+$/, "");

export const taminEpClientId = async () =>
  (await getAppConfig()).taminEpClientId?.trim() ||
  process.env.TAMIN_EP_CLIENT_ID?.trim() ||
  (isTest ? "portal-js" : "");

export const taminEpRedirectUri = async () => {
  const config = await getAppConfig();
  const explicit =
    config.taminEpRedirectUri?.trim() ||
    process.env.TAMIN_EP_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const site = trimSlash(config.siteBaseUrl?.trim() || "");
  if (site) return `${site}/doctorpanel/tamin`;
  return isTest ? "http://localhost/doctorpanel/tamin" : "";
};

// Where each setting comes from - the super admin's settings tab shows it.
export const taminEpConfigSummary = async () => {
  const config = await getAppConfig();
  const clientId = await taminEpClientId();
  const redirectUri = await taminEpRedirectUri();
  return {
    environment: taminEpEnv,
    clientId,
    clientIdSource: config.taminEpClientId?.trim()
      ? "appConfig"
      : process.env.TAMIN_EP_CLIENT_ID?.trim()
        ? "env"
        : clientId
          ? "default"
          : "none",
    redirectUri,
    redirectUriSource: config.taminEpRedirectUri?.trim()
      ? "appConfig"
      : process.env.TAMIN_EP_REDIRECT_URI?.trim()
        ? "env"
        : config.siteBaseUrl?.trim()
          ? "siteBaseUrl"
          : redirectUri
            ? "default"
            : "none",
    authorizeUrl: taminEpUrls.authorize,
    tokenUrl: taminEpUrls.token,
  };
};

const enc = encodeURIComponent;

export const taminEpUrls = {
  authorize: `${ACCOUNT}/auth/server/authorize`,
  // v2 is the token endpoint that also issues refresh tokens (guide 2-4).
  token: `${ACCOUNT}/auth/server/v2/token`,
  signout: `${ACCOUNT}/auth/signout`,
  sendEpresc: isTest ? `${SEND_EPRESC}/SendEpresc` : SEND_EPRESC,
  fetch: (headerId: string, docId: string, docNationalCode: string) =>
    isTest
      ? `${SEND_EPRESC}/ep/${enc(headerId)}/${enc(docNationalCode)}/${enc(docId)}/detail`
      : `${SEND_EPRESC}/${enc(headerId)}/${enc(docId)}`,
  remove: (headerId: string, docId: string, docNationalCode: string) =>
    isTest
      ? `${SEND_EPRESC}/ep/${enc(headerId)}/${enc(docNationalCode)}/${enc(docId)}`
      : `${SEND_EPRESC}/remove/${enc(headerId)}/${enc(docId)}`,
  edit: (headerId: string, docId: string, docNationalCode: string) =>
    isTest
      ? `${SEND_EPRESC}/ep/update/${enc(headerId)}/${enc(docNationalCode)}/${enc(docId)}`
      : `${SEND_EPRESC}/edit/${enc(headerId)}/${enc(docId)}`,
  deserve: (
    siamId: string,
    docId: string,
    patientNationalCode: string,
    docNationalCode: string,
  ) =>
    isTest
      ? `https://ep-test.tamin.ir/api/v2/patients/deserve-info/${enc(docNationalCode)}/${enc(siamId)}/${enc(docId)}/${enc(patientNationalCode)}`
      : `https://soa.tamin.ir/interface/epresc/patient/v2/deserve-info/${enc(siamId)}/${enc(docId)}/${enc(patientNationalCode)}`,
  activeClinics: isTest
    ? "https://ep-test.tamin.ir/api/v2/doctor-active-clinics"
    : "https://api.tamin.ir/ep/doctor-active-clinics/v1",
  // Base information (guide section 8).
  baseInfo: {
    prescriptionType: isTest
      ? `${SEND_EPRESC}/ws-prescription-type`
      : `${SEND_EPRESC}/prescription-type`,
    serviceType: isTest
      ? `${SEND_EPRESC}/ws-service-type`
      : `${SEND_EPRESC}/service-type`,
    services: (srvType: string) =>
      isTest
        ? `${SEND_EPRESC}/ws-services?serviceType=${enc(srvType)}`
        : `${SEND_EPRESC}/services?service-type=${enc(srvType)}`,
    parTaref: isTest
      ? `${SEND_EPRESC}/ws-par-taref`
      : `${SEND_EPRESC}/par-taref`,
    drugAmount: isTest
      ? `${SEND_EPRESC}/ws-drug-amount`
      : `${SEND_EPRESC}/drug-amount`,
    drugUsage: isTest
      ? `${SEND_EPRESC}/ws-drug-usage`
      : `${SEND_EPRESC}/drug-usage`,
    drugInstruction: isTest
      ? `${SEND_EPRESC}/ws-drug-instruction`
      : `${SEND_EPRESC}/drug-instruction`,
    phPlan: isTest ? `${SEND_EPRESC}/ws-ph-plan` : `${SEND_EPRESC}/ph-plan`,
    phIllness: isTest
      ? `${SEND_EPRESC}/ws-ph-illness`
      : `${SEND_EPRESC}/ph-illness`,
    complaint: isTest
      ? "https://ep-test.tamin.ir/api/complaint"
      : `${SEND_EPRESC}/complaint`,
    icd10: isTest
      ? "https://ep-test.tamin.ir/api/icd10/getAll"
      : `${SEND_EPRESC}/icd10/getAll`,
    specials: isTest
      ? "https://ep-test.tamin.ir/api/specials"
      : `${SEND_EPRESC}/special/getAll`,
  },
};

// --------------------------------------------------------------- Identity

// Tamin wants Iranian mobiles as 09xxxxxxxxx; User.phone is stored as
// 989xxxxxxxxx.
export const toTaminMobile = (phone?: string | null) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (/^989\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
  if (/^9\d{9}$/.test(digits)) return `0${digits}`;
  if (/^09\d{9}$/.test(digits)) return digits;
  return undefined;
};

// docId is the medical-system number "without signs". Midwives' numbers
// carry the letter م, which Tamin wants sent as a trailing "*" (guide 3,
// note 11).
export const toTaminDocId = (
  doctor: Pick<IDoctorProfile, "medicalSystemCode" | "medicalSystemTitle">,
) => {
  const raw = String(doctor.medicalSystemCode || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return undefined;
  const midwife = doctor.medicalSystemTitle === "مامایی" || /م/.test(raw);
  return midwife ? `${digits}*` : digits;
};

export type TaminDoctorIdentity = {
  docId: string;
  docNationalCode: string;
  docMobileNo: string;
};

// What gets sent as docId/docNationalCode/docMobileNo. Tamin checks them
// against the doctor's EP.TAMIN.IR registration, so the doctor can override
// each one (DoctorTaminCred) when the profile differs from what Tamin has.
export const resolveDoctorIdentity = async (
  doctorId: unknown,
  cred?: IDoctorTaminCred | null,
): Promise<Partial<TaminDoctorIdentity>> => {
  const doctor = await DoctorProfile.findById(doctorId).select(
    "medicalSystemCode medicalSystemTitle user +ssid",
  );
  const user = doctor?.user
    ? await User.findById(doctor.user).select("phone")
    : null;
  return {
    docId: cred?.docId || (doctor ? toTaminDocId(doctor) : undefined),
    docNationalCode: cred?.docNationalCode || doctor?.ssid || undefined,
    docMobileNo: cred?.docMobileNo || toTaminMobile(user?.phone),
  };
};

export const requireDoctorIdentity = async (
  doctorId: unknown,
  cred?: IDoctorTaminCred | null,
): Promise<TaminDoctorIdentity> => {
  const identity = await resolveDoctorIdentity(doctorId, cred);
  if (!identity.docId || !identity.docNationalCode || !identity.docMobileNo)
    throw new AppError(
      "برای ارسال نسخه به تامین، کد نظام پزشکی، کد ملی و شماره همراه شما باید در تنظیمات تامین تکمیل باشد",
      400,
    );
  return identity as TaminDoctorIdentity;
};

// Patient national code + mobile (SendEpresc rejects an empty or malformed
// mobile).
export const patientForTamin = async (patient: IUserIdentity) => {
  let mobile = (patient.phones || []).map(toTaminMobile).find(Boolean);
  if (!mobile && patient.user) {
    const user = await User.findById(patient.user).select("phone");
    mobile = toTaminMobile(user?.phone);
  }
  if (!mobile)
    throw new AppError(
      "شماره همراه بیمار ثبت نشده است؛ تامین بدون شماره همراه نسخه را نمی‌پذیرد",
      400,
    );
  return { nationalCode: patient.nationalId, mobile };
};

// ------------------------------------------------------------------ Token

type TokenAnswer = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

// Tamin answered, and said no (bad code, used/expired refresh token...) -
// as opposed to Tamin not being reachable.
class TaminTokenRejected extends AppError {
  constructor() {
    super("دریافت توکن از تامین ناموفق بود", 400);
  }
}

const postToken = async (params: Record<string, string>) => {
  const response = await fetch(taminEpUrls.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.headers.get("content-type")?.includes("json")) {
    console.log("Tamin token answer not JSON", response.status);
    throw new AppError("جواب دریافتی از سامانه تامین معتبر نبود", 400);
  }
  const body = (await response.json()) as TokenAnswer & {
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    // only the OAuth error fields - never the tokens or the request
    console.log("Tamin token error", response.status, body?.error, body?.error_description);
    throw new TaminTokenRejected();
  }
  return body;
};

const tokenUpdate = (body: TokenAnswer) => ({
  token: body.access_token,
  tokenRefreshedAt: new Date(),
  environment: taminEpEnv,
  ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
  ...(Number(body.expires_in) > 0
    ? { tokenExpiresAt: new Date(Date.now() + Number(body.expires_in) * 1000) }
    : {}),
});

// authorization_code -> tokens (guide 2-4-1). `audience` is the doctor's
// national code.
export const exchangeDoctorCode = async ({
  credId,
  code,
  verifier,
  audience,
}: {
  credId: unknown;
  code: string;
  verifier: string;
  audience: string;
}) => {
  const redirectUri = await taminEpRedirectUri();
  const clientId = await taminEpClientId();
  if (!redirectUri || !clientId)
    throw new AppError("اتصال به تامین روی سرور تنظیم نشده است", 500);
  const body = await postToken({
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    audience,
  });
  await DoctorTaminCred.findByIdAndUpdate(credId, {
    ...tokenUpdate(body),
    $unset: {
      loginState: 1,
      verifier: 1,
      challenge: 1,
      ...(body.refresh_token ? {} : { refreshToken: 1 }),
      ...(Number(body.expires_in) > 0 ? {} : { tokenExpiresAt: 1 }),
    },
  });
};

// Refresh a little before the access token actually expires.
const EXPIRY_MARGIN_MS = 60 * 1000;

export const tokenState = (
  // load it with .select("+refreshToken") or a refreshable token reads expired
  cred: Pick<IDoctorTaminCred, "token" | "tokenExpiresAt" | "environment" | "refreshToken"> | null | undefined,
) => {
  // a token of the other Tamin environment (all tokens from before 2026-10
  // came from the sandbox) is no token here
  if (!cred?.token || (cred.environment || "test") !== taminEpEnv)
    return "missing" as const;
  if (
    cred.tokenExpiresAt &&
    cred.tokenExpiresAt.getTime() - EXPIRY_MARGIN_MS <= Date.now()
  )
    return cred.refreshToken ? ("refreshable" as const) : ("expired" as const);
  return "valid" as const;
};

// One refresh per doctor at a time: two requests arriving with an expired
// token must not both spend the (single-use) refresh token.
const refreshing = new Map<string, Promise<{ token: string; cred: IDoctorTaminCred }>>();

// A usable access token for this doctor, refreshing it with the stored
// refresh_token when it has expired (guide 2-4-2). Throws
// MissingTaminTokenError when the doctor has to log in to Tamin again.
export const getDoctorTaminToken = async (
  doctorId: unknown,
): Promise<{ token: string; cred: IDoctorTaminCred }> => {
  const cred = await DoctorTaminCred.findOne({ doctor: doctorId }).select(
    "+refreshToken",
  );
  const state = tokenState(cred);
  if (!cred || state === "missing" || state === "expired")
    throw new MissingTaminTokenError();
  if (state === "valid") return { token: cred.token as string, cred };
  const key = String(cred._id);
  const running = refreshing.get(key);
  if (running) return running;
  const job = (async () => {
    const identity = await resolveDoctorIdentity(doctorId, cred);
    try {
      const body = await postToken({
        grant_type: "refresh_token",
        client_id: await taminEpClientId(),
        refresh_token: cred.refreshToken as string,
        audience: identity.docNationalCode || "",
      });
      const updated = await DoctorTaminCred.findByIdAndUpdate(
        cred._id,
        tokenUpdate(body),
        { new: true },
      );
      return { token: body.access_token as string, cred: updated || cred };
    } catch (err) {
      // Tamin refused the refresh token: the doctor has to log in again.
      // Tamin unreachable: keep the session for the next try.
      if (err instanceof TaminTokenRejected) {
        await DoctorTaminCred.findByIdAndUpdate(cred._id, {
          $unset: { token: 1, refreshToken: 1, tokenExpiresAt: 1 },
        });
        throw new MissingTaminTokenError();
      }
      throw err instanceof AppError ? err : new BadTaminResponseError();
    }
  })();
  refreshing.set(key, job);
  try {
    return await job;
  } finally {
    refreshing.delete(key);
  }
};

// ------------------------------------------------------------------ Calls

export const taminEpRequest = async ({
  url,
  method,
  token,
  payload,
}: {
  url: string;
  method: "GET" | "POST";
  token: string;
  payload?: unknown;
}): Promise<any> => {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
  } catch {
    throw new BadTaminResponseError();
  }
  if (response.status === 401) throw new MissingTaminTokenError();
  if (!response.headers.get("content-type")?.includes("json")) {
    // the path only (it carries the patient's national code on deserve-info)
    console.log("Tamin EP answer not JSON", new URL(url).pathname.split("/").slice(0, 6).join("/"), response.status);
    throw new BadTaminResponseError();
  }
  return response.json();
};

// SendEpresc answers `{ data: { result: { head_EPRSC_ID, trackingCode,
// complemantary_Msg | error_Code, error_Msg } } }`.
type EpResult = {
  head_EPRSC_ID?: string | number | null;
  trackingCode?: string | number | null;
  error_Code?: string | null;
  error_Msg?: string | null;
  complemantary_Msg?: string | null;
};
const resultOf = (body: any): EpResult =>
  body?.data?.result ?? body?.result ?? body?.data ?? {};

const failure = (body: any, fallback = "درخواست تامین ناموفق بود") => {
  const r = resultOf(body);
  return new AppError(
    `${fallback}: ${r.error_Msg || body?.message || body?.reason || "نامعلوم"}`,
    400,
  );
};

export type EpPrescType = 1 | 2 | 3 | 5 | 6 | 7 | 8 | 9;

export type EpItem = Record<string, unknown>;

// Jalali date in Tehran (Tamin's dates are Iranian calendar days).
export const taminJalali = (date: Date) =>
  tehranMoment(date).format("jYYYYjMMjDD");

// Prescriptions stay valid for a month unless the caller says otherwise.
const DEFAULT_VALIDITY_DAYS = 30;

export type SendEprescResult = {
  taminId: string;
  tracking: string;
  // Tamin answered 304: the same prescription was already registered; the
  // ids come from its error message.
  duplicate: boolean;
};

export const sendEpresc = async ({
  token,
  identity,
  patient,
  prescTypeId,
  items = [],
  referrals,
  comments = "",
  expireDate,
}: {
  token: string;
  identity: TaminDoctorIdentity;
  patient: { nationalCode: string; mobile: string };
  prescTypeId: EpPrescType;
  items?: EpItem[];
  referrals?: Record<string, unknown>[];
  comments?: string;
  expireDate?: Date;
}): Promise<SendEprescResult> => {
  const now = new Date();
  const payload: Record<string, unknown> = {
    patient: patient.nationalCode,
    mobile: patient.mobile,
    prescType: { prescTypeId },
    prescDate: taminJalali(now),
    expireDate: taminJalali(
      expireDate ||
        new Date(now.getTime() + DEFAULT_VALIDITY_DAYS * 24 * 3600 * 1000),
    ),
    docId: identity.docId,
    docNationalCode: identity.docNationalCode,
    docMobileNo: identity.docMobileNo,
    comments,
    noteDetailEprscs: items,
  };
  if (referrals) payload.noteDetailsReferralList = referrals;
  // Test environment only (guide 3): clientId = doctor's national code.
  if (isTest) payload.clientId = identity.docNationalCode;
  const body = await taminEpRequest({
    url: taminEpUrls.sendEpresc,
    method: "POST",
    token,
    payload,
  });
  const r = resultOf(body);
  if (r.error_Code) {
    if (String(r.error_Code) === "304" && r.error_Msg) {
      const taminId = r.error_Msg.match(/شناسه.*?(\d+)/)?.[1];
      const tracking = r.error_Msg.match(/کد رهگیری\s*(\d+)/)?.[1];
      if (taminId && tracking) return { taminId, tracking, duplicate: true };
    }
    throw failure(body);
  }
  if (!r.head_EPRSC_ID || !r.trackingCode) throw new BadTaminResponseError();
  return {
    taminId: String(r.head_EPRSC_ID),
    tracking: String(r.trackingCode),
    duplicate: false,
  };
};

const requireOk = (body: any, fallback: string) => {
  const r = resultOf(body);
  if (r.error_Code) throw failure(body, fallback);
  const ok =
    body?.status === 200 ||
    String(body?.data?.statusCode ?? "") === "200" ||
    body?.data === true;
  if (!ok) throw failure(body, fallback);
};

// Section 7: the item list replaces the registered one. Only possible once
// per prescription and before a pharmacy/paraclinic acts on it.
export const editEpresc = async ({
  token,
  identity,
  taminId,
  items,
}: {
  token: string;
  identity: TaminDoctorIdentity;
  taminId: string;
  items: EpItem[];
}) => {
  const body = await taminEpRequest({
    url: taminEpUrls.edit(taminId, identity.docId, identity.docNationalCode),
    method: "POST",
    token,
    payload: items,
  });
  requireOk(body, "ویرایش نسخه در تامین ناموفق بود");
};

// Section 6: only possible until the end of the day it was registered.
export const removeEpresc = async ({
  token,
  identity,
  taminId,
}: {
  token: string;
  identity: TaminDoctorIdentity;
  taminId: string;
}) => {
  const body = await taminEpRequest({
    url: taminEpUrls.remove(taminId, identity.docId, identity.docNationalCode),
    method: "POST",
    token,
  });
  requireOk(body, "حذف نسخه از تامین ناموفق بود");
};

export const fetchEpresc = async ({
  token,
  identity,
  taminId,
}: {
  token: string;
  identity: TaminDoctorIdentity;
  taminId: string;
}) => {
  const body = await taminEpRequest({
    url: taminEpUrls.fetch(taminId, identity.docId, identity.docNationalCode),
    method: "GET",
    token,
  });
  if (resultOf(body).error_Code) throw failure(body);
  return body?.data;
};

// Deletion is allowed until the end of the registration day (Tehran).
export const isSameTaminDay = (registeredAt: Date, now = new Date()) =>
  taminJalali(registeredAt) === taminJalali(now);

// ------------------------------------------------------------ Base info

// Base information (service catalog, drug amounts, ICD10...) has to come
// from the same environment prescriptions are sent to, otherwise codes
// won't match. The admin refresh jobs have no Tamin login of their own, so
// they borrow the most recently refreshed doctor session of this
// environment (refreshing it if needed); the test environment also answers
// without one.
export const taminBaseInfoFetch = async (url: string) => {
  const creds = await DoctorTaminCred.find({
    token: { $exists: true },
    environment: taminEpEnv,
  })
    .sort({ tokenRefreshedAt: -1 })
    .limit(5);
  let token: string | undefined;
  for (const cred of creds) {
    try {
      token = (await getDoctorTaminToken(cred.doctor)).token;
      break;
    } catch {
      // try the next session
    }
  }
  if (!token && !isTest) throw new MissingTaminTokenError();
  return fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
};
