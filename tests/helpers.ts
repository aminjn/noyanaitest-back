import "./setupEnv";

import { randomBytes } from "crypto";
import { AddressInfo } from "net";
import { Server } from "http";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

import app from "../app";
import * as env from "../Lib/Env";
import User from "../Models/User";
import UserSecurity from "../Models/UserSecurity";
import UserIdentity from "../Models/UserIdentity";
import DoctorProfile from "../Models/DoctorProfile";

// Integration-test helpers (2026-10, first tests of this repo; same shape
// as the main repo's tests/helpers.ts). A fresh per-process database on the
// local Mongo (override with MONGO_TEST_URI_BASE / MONGO_TEST_URI_QUERY),
// dropped at the end; the Express app on an ephemeral port; no boot jobs.
const MONGO_BASE = process.env.MONGO_TEST_URI_BASE || "mongodb://127.0.0.1:27017";
const MONGO_QUERY = process.env.MONGO_TEST_URI_QUERY ?? "";

// --- Network guard ------------------------------------------------------
// Only requests to our own test server are let through; anything else fails
// loudly unless a test registered a stub that answers it.
const realFetch = globalThis.fetch;
export const blockedExternalCalls: string[] = [];
export type ExternalFetchStub = (
  url: string,
  init?: RequestInit,
) => Response | undefined | Promise<Response | undefined>;
export const externalFetchStubs: ExternalFetchStub[] = [];
let baseUrl = "";
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (baseUrl && url.startsWith(baseUrl)) return realFetch(input, init);
  for (const stub of externalFetchStubs) {
    const res = await stub(url, init);
    if (res) return res;
  }
  blockedExternalCalls.push(url);
  throw new Error(`[test] blocked external fetch to ${url}`);
}) as typeof fetch;

let server: Server | undefined;
export let dbName = "";

export const startTestApp = async () => {
  dbName = `noyan_test_${randomBytes(6).toString("hex")}`;
  await mongoose.connect(`${MONGO_BASE}/${dbName}${MONGO_QUERY}`, {
    serverSelectionTimeoutMS: 5000,
  });
  // indexes (unique ones matter); a model whose index this Mongo version
  // can't build (an older local server) must not stop the suite
  await Promise.allSettled(
    mongoose.modelNames().map((name) => mongoose.model(name).init()),
  );
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
};

export const stopTestApp = async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  await new Promise((r) => setTimeout(r, 300));
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
};

// --- HTTP -----------------------------------------------------------------
// Same signing as authController.cookieBuilder: jwt.sign({ id }, JWT_SECRET).
export const tokenFor = (userId: unknown) =>
  jwt.sign({ id: String(userId) }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN * 24 * 60 * 60,
  });

export type ApiResponse = { status: number; body: any };

export const api = async (
  method: string,
  path: string,
  { user, body }: { user?: unknown; body?: unknown } = {},
): Promise<ApiResponse> => {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (user) headers.Cookie = `token=${tokenFor(user)}`;
  const res = await realFetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-JSON body, keep raw text
  }
  return { status: res.status, body: parsed };
};

// --- Fixtures ---------------------------------------------------------
let phoneCounter = 0;
const nextPhone = () =>
  `989${String(Date.now() % 1e6).padStart(6, "0")}${String(++phoneCounter).padStart(3, "0")}`;

// A user whose UserSecurity lastLogin predates every token we mint
// (authController.protect rejects tokens issued before lastLogin).
export const createUser = async () => {
  const user = await User.create({ phone: nextPhone() });
  await UserSecurity.create({ user: user._id, lastLogin: new Date(0) });
  return user;
};

export const createIdentity = async (userId?: unknown) =>
  UserIdentity.create({
    user: userId,
    nationalId: String(Math.floor(Math.random() * 1e10)).padStart(10, "0"),
    givenName: "Test",
    lastName: "Patient",
    gender: "male",
    dateOfbirth: new Date("1990-01-01"),
  });

export const dayFromNow = (days: number) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
};

// A doctor with its own linked User.
export const createDoctor = async () => {
  const doctorUser = await createUser();
  const doctor = await DoctorProfile.create({
    user: doctorUser._id,
    firstName: "Dr",
    lastName: "Test",
  });
  return { doctor, doctorUser };
};
