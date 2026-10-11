import {
  api,
  createDoctor,
  createIdentity,
  createUser,
  dayFromNow,
  externalFetchStubs,
  startTestApp,
  stopTestApp,
} from "./helpers";

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import AppConfig from "../Models/AppConfig";
import User from "../Models/User";
import DoctorProfile from "../Models/DoctorProfile";
import DoctorProfileLicense from "../Models/DoctorProfileLicense";
import DoctorTaminCred from "../Models/DoctorTaminCred";
import TaminService from "../Models/TaminService";
import TaminServiceType from "../Models/TaminServiceType";
import TaminPrescriptionType from "../Models/TaminPrescriptionType";
import TaminDrugAmount from "../Models/TaminDrugAmount";
import TaminDrugInstruction from "../Models/TaminDrugInstruction";
import TaminPrescription2 from "../Models/Prescription/TaminPrescription2";
import TaminSpec from "../Models/TaminSpec";
import TaminComplaint from "../Models/TaminComplaint";
import TaminIcid from "../Models/TaminIdid";
import UserIdentity from "../Models/UserIdentity";
import { getAppConfig } from "../Lib/appConfig";

// Doctor e-prescription on Tamin's production API (Lib/taminEp.ts, guide
// v1.9.9). Every Tamin call is answered by a stub - tamin.ir is never
// reached. Ported from the main repo's tests/doctorTaminEp.test.ts and
// extended with the AppConfig settings, the secrecy of the refresh token,
// sandbox-era tokens and the pharmacy/clinic/paraClinic lockout.

before(startTestApp);
after(stopTestApp);

process.env.TAMIN_EP_CLIENT_ID = "noyan-client";
process.env.TAMIN_EP_REDIRECT_URI = "https://noyan.example/doctorpanel/tamin";

const BASE = "/api/v1/doctor";
const SOA = "https://soa.tamin.ir/interface/epresc/SendEpresc/v2";

type Call = { url: string; method: string; body: any; auth?: string };
let calls: Call[] = [];
let answers: { status?: number; body: unknown }[] = [];

const sendOk = (taminId: number, tracking: number) => ({
  body: {
    data: {
      result: {
        head_EPRSC_ID: taminId,
        trackingCode: tracking,
        complemantary_Msg: "ok",
        error_Code: null,
        error_Msg: null,
      },
    },
  },
});

before(() => {
  externalFetchStubs.push(async (url, init) => {
    if (!url.includes("tamin.ir")) return undefined;
    const raw = init?.body ? String(init.body) : undefined;
    let body: any = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw || ""));
    }
    calls.push({
      url,
      method: init?.method || "GET",
      body,
      auth: (init?.headers as Record<string, string> | undefined)
        ?.Authorization,
    });
    const next = answers.shift() || { body: { status: 200, data: true } };
    return new Response(JSON.stringify(next.body), {
      status: next.status || 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});

let doctorUser: Awaited<ReturnType<typeof createUser>>;
let doctorId: unknown;
let drug: { _id: unknown };
let amount: { _id: unknown };
let instruction: { _id: unknown };

before(async () => {
  const created = await createDoctor();
  doctorUser = created.doctorUser;
  doctorId = created.doctor._id;
  await DoctorProfile.updateOne(
    { _id: doctorId },
    { medicalSystemCode: "12345", ssid: "0012345679" },
  );
  await DoctorProfileLicense.create({
    owner: doctorId,
    modules: ["drugsAndPrescriptions"],
  });
  await TaminPrescriptionType.create({ prescTypeId: 1, prescTypeDesc: "دارو" });
  await TaminServiceType.create({
    srvType: 1,
    prescTypeId: 1,
    srvTypeDes: "دارویی",
  });
  drug = await TaminService.create({
    srvType: "01",
    srvCode: "1000",
    wsSrvCode: "1000",
    srvName: "Amoxicillin",
  });
  amount = await TaminDrugAmount.create({ drugAmntId: "5" });
  instruction = await TaminDrugInstruction.create({ drugInstId: "3" });
  await getAppConfig();
});

beforeEach(async () => {
  calls = [];
  answers = [];
  await DoctorTaminCred.deleteMany({});
  await DoctorTaminCred.create({
    doctor: doctorId,
    token: "access",
    refreshToken: "refresh",
    environment: "production",
    tokenExpiresAt: new Date(Date.now() + 3600 * 1000),
  });
});

const patientWithPhone = async () => {
  const identity = await createIdentity(undefined);
  await UserIdentity.updateOne(
    { _id: identity._id },
    { phones: ["09121112233"] },
  );
  return identity;
};

const draft = async (patientId: unknown) => {
  const res = await api("POST", `${BASE}/presc2`, {
    user: doctorUser._id,
    body: {
      patient: String(patientId),
      items: [
        {
          item: String(drug._id),
          qty: 2,
          timesADay: String(amount._id),
          instruction: String(instruction._id),
          dose: "after meal",
        },
      ],
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data._id as string;
};

describe("doctor Tamin e-prescription (production API)", () => {
  test("routes are open to doctors again", async () => {
    const res = await api("GET", `${BASE}/tamin/settings`, {
      user: doctorUser._id,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.environment, "production");
    assert.equal(res.body.data.token.state, "valid");
    assert.deepEqual(res.body.data.identity.effective, {
      docId: "12345",
      docNationalCode: "0012345679",
      // User.phone is stored as 989…; Tamin always gets 09…
      docMobileNo: `0${doctorUser.phone.slice(2)}`,
    });
  });

  test("tokens never leave the server", async () => {
    const res = await api("GET", `${BASE}/tamin/settings`, {
      user: doctorUser._id,
    });
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes("refresh"), text);
    assert.ok(!text.includes('"access"'), text);
    const tokenDate = await api("GET", `${BASE}/tamin/token`, {
      user: doctorUser._id,
    });
    assert.equal(tokenDate.status, 200);
    assert.ok(!JSON.stringify(tokenDate.body).includes("refresh"));
  });

  test("a sandbox-era token (no environment) counts as no token", async () => {
    await DoctorTaminCred.updateOne(
      { doctor: doctorId },
      { $unset: { environment: 1 } },
    );
    const res = await api("GET", `${BASE}/tamin/settings`, {
      user: doctorUser._id,
    });
    assert.equal(res.body.data.token.state, "missing");
    const patient = await patientWithPhone();
    const id = await draft(patient._id);
    const commit = await api("PATCH", `${BASE}/presc2/${id}`, {
      user: doctorUser._id,
    });
    assert.equal(commit.status, 400);
    assert.equal(calls.length, 0);
  });

  test("legacy v1 prescription routes stay locked", async () => {
    for (const [method, path] of [
      ["GET", `${BASE}/presc`],
      ["GET", `${BASE}/presc/000000000000000000000000`],
      ["GET", `${BASE}/presc/tamin/000000000000000000000000`],
    ]) {
      const res = await api(method, path, { user: doctorUser._id });
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  });

  test("pharmacy, clinic and paraClinic Tamin routes stay locked", async () => {
    for (const [method, path] of [
      ["GET", "/api/v1/pharmacy/prescription"],
      ["GET", "/api/v1/clinic/tamin"],
      ["POST", "/api/v1/paraClinic/tamin"],
    ]) {
      const res = await api(method, path, { user: doctorUser._id, body: method === "POST" ? {} : undefined });
      assert.equal(res.status, 403, `${method} ${path} ${JSON.stringify(res.body)}`);
    }
    assert.equal(calls.length, 0);
  });

  test("login: production authorize URL, state check, v2 token with audience", async () => {
    let res = await api("GET", `${BASE}/tamin`, { user: doctorUser._id });
    assert.equal(res.status, 200);
    const url = new URL(res.body.data.authorizeUrl);
    assert.equal(
      url.origin + url.pathname,
      "https://account.tamin.ir/auth/server/authorize",
    );
    assert.equal(url.searchParams.get("client_id"), "noyan-client");
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "https://noyan.example/doctorpanel/tamin",
    );
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge"));
    const state = url.searchParams.get("state");
    assert.ok(state && state.length >= 16);

    for (const forged of [{ code: "c", state: "forged" }, { code: "c" }]) {
      res = await api("POST", `${BASE}/tamin`, {
        user: doctorUser._id,
        body: forged,
      });
      assert.equal(res.status, 400, JSON.stringify(forged));
    }
    assert.equal(calls.length, 0);

    answers.push({
      body: { access_token: "new", refresh_token: "r2", expires_in: 3600 },
    });
    res = await api("POST", `${BASE}/tamin`, {
      user: doctorUser._id,
      body: { code: "c", state },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(calls[0].url, "https://account.tamin.ir/auth/server/v2/token");
    assert.equal(calls[0].body.audience, "0012345679");
    assert.equal(calls[0].body.grant_type, "authorization_code");
    assert.equal(calls[0].body.client_id, "noyan-client");
    assert.equal(calls[0].body.redirect_uri, "https://noyan.example/doctorpanel/tamin");
    assert.ok(calls[0].body.code_verifier);
    const cred = await DoctorTaminCred.findOne({ doctor: doctorId }).select("+refreshToken");
    assert.equal(cred?.token, "new");
    assert.equal(cred?.refreshToken, "r2");
    assert.equal(cred?.environment, "production");
    assert.equal(cred?.loginState, undefined, "state is single-use");

    // the same callback can't be replayed
    res = await api("POST", `${BASE}/tamin`, {
      user: doctorUser._id,
      body: { code: "c", state },
    });
    assert.equal(res.status, 400);
  });

  test("client id and redirect address come from the super admin settings first", async () => {
    await AppConfig.updateOne(
      { singleton: "SINGLETON" },
      { $set: { taminEpClientId: "from-admin", taminEpRedirectUri: "https://admin.example/doctorpanel/tamin" } },
    );
    try {
      const res = await api("GET", `${BASE}/tamin`, { user: doctorUser._id });
      const url = new URL(res.body.data.authorizeUrl);
      assert.equal(url.searchParams.get("client_id"), "from-admin");
      assert.equal(url.searchParams.get("redirect_uri"), "https://admin.example/doctorpanel/tamin");
    } finally {
      await AppConfig.updateOne(
        { singleton: "SINGLETON" },
        { $set: { taminEpClientId: "", taminEpRedirectUri: "" } },
      );
    }
  });

  test("redirect address defaults to siteBaseUrl + /doctorpanel/tamin", async () => {
    const saved = process.env.TAMIN_EP_REDIRECT_URI;
    delete process.env.TAMIN_EP_REDIRECT_URI;
    await AppConfig.updateOne({ singleton: "SINGLETON" }, { $set: { siteBaseUrl: "https://site.example/" } });
    try {
      const res = await api("GET", `${BASE}/tamin`, { user: doctorUser._id });
      const url = new URL(res.body.data.authorizeUrl);
      assert.equal(url.searchParams.get("redirect_uri"), "https://site.example/doctorpanel/tamin");
    } finally {
      process.env.TAMIN_EP_REDIRECT_URI = saved;
      await AppConfig.updateOne({ singleton: "SINGLETON" }, { $set: { siteBaseUrl: "" } });
    }
  });

  test("super admin Tamin settings endpoint", async () => {
    const admin = await createUser();
    await User.updateOne({ _id: admin._id }, { role: "admin" });
    let res = await api("GET", "/api/v1/admin/tamin/ep-settings", { user: admin._id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.environment, "production");
    assert.equal(res.body.data.clientId, "noyan-client");
    assert.equal(res.body.data.clientIdSource, "env");
    assert.equal(res.body.data.authorizeUrl, "https://account.tamin.ir/auth/server/authorize");
    res = await api("POST", "/api/v1/admin/tamin/ep-settings", {
      user: admin._id,
      body: { taminEpRedirectUri: "https://x.example/doctorpanel/tamin?a=1" },
    });
    assert.equal(res.status, 400, "query params are refused");
    res = await api("POST", "/api/v1/admin/tamin/ep-settings", {
      user: admin._id,
      body: { taminEpClientId: "cid-1" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.clientIdSource, "appConfig");
    await AppConfig.updateOne({ singleton: "SINGLETON" }, { $set: { taminEpClientId: "" } });
    // a doctor is not the super admin
    res = await api("GET", "/api/v1/admin/tamin/ep-settings", { user: doctorUser._id });
    assert.notEqual(res.status, 200);
  });

  test("commit sends real doctor/patient data to the production SendEpresc", async () => {
    const patient = await patientWithPhone();
    const id = await draft(patient._id);
    answers.push(sendOk(9001, 777));
    const res = await api("PATCH", `${BASE}/presc2/${id}`, {
      user: doctorUser._id,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const send = calls[0];
    assert.equal(send.url, SOA);
    assert.equal(send.auth, "Bearer access");
    assert.equal(send.body.patient, patient.nationalId);
    assert.equal(send.body.mobile, "09121112233");
    assert.equal(send.body.docId, "12345");
    assert.equal(send.body.docNationalCode, "0012345679");
    assert.equal(send.body.clientId, undefined, "clientId is test-only");
    assert.match(send.body.prescDate, /^14\d{6}$/);
    assert.deepEqual(send.body.prescType, { prescTypeId: 1 });
    assert.deepEqual(send.body.noteDetailEprscs[0], {
      srvId: { srvType: { srvType: "01" }, srvCode: "1000" },
      srvQty: 2,
      timesAday: { drugAmntId: 5 },
      drugInstruction: { drugInstId: 3 },
      dose: "after meal",
    });
    const saved = await TaminPrescription2.findOne({ taminId: "9001" });
    assert.equal(saved?.tracking, "777");
  });

  test("an expired access token is refreshed with the refresh token", async () => {
    await DoctorTaminCred.updateOne(
      { doctor: doctorId },
      { tokenExpiresAt: new Date(Date.now() - 1000) },
    );
    const patient = await patientWithPhone();
    const id = await draft(patient._id);
    answers.push({
      body: { access_token: "fresh", refresh_token: "r3", expires_in: 3600 },
    });
    answers.push(sendOk(9002, 778));
    const res = await api("PATCH", `${BASE}/presc2/${id}`, {
      user: doctorUser._id,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(calls[0].body.grant_type, "refresh_token");
    assert.equal(calls[0].body.refresh_token, "refresh");
    assert.equal(calls[1].auth, "Bearer fresh");
  });

  test("a refused refresh token ends the session", async () => {
    await DoctorTaminCred.updateOne(
      { doctor: doctorId },
      { tokenExpiresAt: new Date(Date.now() - 1000) },
    );
    answers.push({ status: 400, body: { error: "invalid_grant" } });
    const res = await api("POST", `${BASE}/presc/privilege`, {
      user: doctorUser._id,
      body: { nationalCode: "0012345679" },
    });
    assert.equal(res.status, 400);
    const cred = await DoctorTaminCred.findOne({ doctor: doctorId }).select("+refreshToken");
    assert.equal(cred?.token, undefined);
    assert.equal(cred?.refreshToken, undefined);
  });

  test("a patient without a mobile is rejected before calling Tamin", async () => {
    const patient = await createIdentity(undefined);
    const id = await draft(patient._id);
    const res = await api("PATCH", `${BASE}/presc2/${id}`, {
      user: doctorUser._id,
    });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  test("Tamin errors are passed through", async () => {
    const patient = await patientWithPhone();
    const id = await draft(patient._id);
    answers.push({
      body: {
        data: {
          result: { error_Code: "120", error_Msg: "پزشک فعال نشده است" },
        },
      },
    });
    const res = await api("PATCH", `${BASE}/presc2/${id}`, {
      user: doctorUser._id,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /پزشک فعال نشده است/);
  });

  test("edit uses the production edit endpoint, once only", async () => {
    const patient = await patientWithPhone();
    const id = await draft(patient._id);
    answers.push(sendOk(9003, 779));
    await api("PATCH", `${BASE}/presc2/${id}`, { user: doctorUser._id });
    const edit = (qty: number) =>
      api("POST", `${BASE}/presc2/tamin/${id}`, {
        user: doctorUser._id,
        body: {
          items: [
            {
              item: String(drug._id),
              qty,
              timesADay: String(amount._id),
              instruction: String(instruction._id),
              dose: "after meal",
            },
          ],
        },
      });
    answers.push({ body: { status: 200, data: { statusCode: "200" } } });
    let res = await edit(3);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.errors, []);
    assert.equal(calls[1].url, `${SOA}/edit/9003/12345`);
    assert.equal(calls[1].body[0].srvQty, 3);

    res = await edit(4);
    assert.equal(res.status, 200);
    assert.match(res.body.errors[0], /یک بار ویرایش شده/);
    assert.equal(calls.length, 2, "no second edit call");
  });

  test("delete uses the production remove endpoint, same day only", async () => {
    const patient = await patientWithPhone();
    const id = await draft(patient._id);
    answers.push(sendOk(9004, 780));
    await api("PATCH", `${BASE}/presc2/${id}`, { user: doctorUser._id });

    await TaminPrescription2.updateOne(
      { taminId: "9004" },
      { createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) },
    );
    let res = await api("PUT", `${BASE}/presc2/tamin/${id}`, {
      user: doctorUser._id,
    });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 1);

    await TaminPrescription2.updateOne(
      { taminId: "9004" },
      { createdAt: new Date() },
    );
    answers.push({ body: { status: 200, data: true } });
    res = await api("PUT", `${BASE}/presc2/tamin/${id}`, {
      user: doctorUser._id,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(calls[1].url, `${SOA}/remove/9004/12345`);
  });

  test("eligibility uses the selected workplace as siam-id", async () => {
    answers.push({ body: { data: { hasDeserve: true } } });
    let res = await api("POST", `${BASE}/presc/privilege`, {
      user: doctorUser._id,
      body: { nationalCode: "0012345679" },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(
      calls[0].url,
      "https://soa.tamin.ir/interface/epresc/patient/v2/deserve-info/12345/12345/0012345679",
    );

    res = await api("PATCH", `${BASE}/tamin/settings`, {
      user: doctorUser._id,
      body: { workplace: { siamId: "SIAM-1", name: "درمانگاه" } },
    });
    assert.equal(res.status, 200);
    answers.push({ body: { data: { hasDeserve: false } } });
    res = await api("POST", `${BASE}/presc/privilege`, {
      user: doctorUser._id,
      body: { nationalCode: "0012345679" },
    });
    assert.equal(res.body.data, false);
    assert.match(calls[1].url, /deserve-info\/SIAM-1\/12345\//);
  });

  test("identity overrides are validated and used", async () => {
    let res = await api("PATCH", `${BASE}/tamin/settings`, {
      user: doctorUser._id,
      body: { docMobileNo: "123" },
    });
    assert.equal(res.status, 400);
    res = await api("PATCH", `${BASE}/tamin/settings`, {
      user: doctorUser._id,
      body: { docMobileNo: "09351112222" },
    });
    assert.equal(res.status, 200);
    res = await api("GET", `${BASE}/tamin/settings`, { user: doctorUser._id });
    assert.equal(res.body.data.identity.effective.docMobileNo, "09351112222");
    // clearing an override falls back to the profile
    res = await api("PATCH", `${BASE}/tamin/settings`, {
      user: doctorUser._id,
      body: { docMobileNo: "" },
    });
    assert.equal(res.status, 200);
    res = await api("GET", `${BASE}/tamin/settings`, { user: doctorUser._id });
    assert.equal(res.body.data.identity.effective.docMobileNo, `0${doctorUser.phone.slice(2)}`);
  });

  test("referral: at most 3, dated tomorrow..3 months", async () => {
    const patient = await patientWithPhone();
    const spec = await TaminSpec.create({ specCode: "00100", specDesc: "x" });
    const complaint = await TaminComplaint.create({ code: 704425001 });
    const icd = await TaminIcid.create({ icdCode: "X46.49" });
    const body = (over: Record<string, unknown>) => ({
      spec: String(spec._id),
      complaints: [String(complaint._id)],
      icds: [String(icd._id)],
      patient: String(patient._id),
      quantity: 2,
      referralDate: dayFromNow(5).toISOString(),
      ...over,
    });
    let res = await api("POST", `${BASE}/referral`, {
      user: doctorUser._id,
      body: body({ quantity: 4 }),
    });
    assert.equal(res.status, 400);
    res = await api("POST", `${BASE}/referral`, {
      user: doctorUser._id,
      body: body({ referralDate: new Date().toISOString() }),
    });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);

    answers.push(sendOk(9005, 781));
    res = await api("POST", `${BASE}/referral`, {
      user: doctorUser._id,
      body: body({}),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(calls[0].body.prescType.prescTypeId, 7);
    assert.deepEqual(calls[0].body.noteDetailsReferralList[0].complaints, [
      { id: "704425001" },
    ]);
  });
});
