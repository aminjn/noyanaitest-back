import crypto from "crypto";
import * as env from "../Env";
import AppError from "../AppError";
import { encryptJwe, signJws, unseal } from "./jose";

// The Moadian API (version 2) for one taxpayer: a short-lived token from a
// nonce signed with the taxpayer's key, invoices sent as signed and then
// encrypted packets, and their outcome asked by reference number. In
// development nothing leaves the server: sends get a fake reference and
// inquiries answer "SUCCESS", so the whole flow can be tried locally.

const BASE = {
  production: (process.env.MOADIAN_URL || "https://tp.tax.gov.ir/requestsmanager/api/v2/").replace(/\/?$/, "/"),
  sandbox: (process.env.MOADIAN_SANDBOX_URL || "https://sandboxrc.tax.gov.ir/requestsmanager/api/v2/").replace(/\/?$/, "/"),
};

export const moadianSimulated = () => env.NODE_ENV === "development" && process.env.MOADIAN_LIVE !== "1";

export type MoadianCreds = {
  env: "sandbox" | "production";
  memoryId: string;
  privateKey: string; // sealed
  certificate?: string;
};

const call = async (url: string, init: RequestInit = {}) => {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  } catch {
    throw new AppError("سامانه‌ی مودیان در دسترس نیست", 503);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body as { message?: string; errors?: { detail?: string }[] })?.message || "";
    console.log(`[moadian] ${init.method || "GET"} ${url} -> ${res.status}`, typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300));
    if (res.status === 401 || res.status === 403) throw new AppError("سامانه‌ی مودیان کلید یا شناسه‌ی حافظه را نپذیرفت", 400);
    throw new AppError(msg ? `خطای سامانه‌ی مودیان: ${msg}` : "سامانه‌ی مودیان در دسترس نیست", 502);
  }
  return body;
};

// the tax organisation's encryption key, cached for an hour
const serverKeys = new Map<string, { at: number; key: string; id: string }>();
const serverKey = async (e: MoadianCreds["env"]) => {
  const hit = serverKeys.get(e);
  if (hit && Date.now() - hit.at < 3600_000) return hit;
  const info = (await call(`${BASE[e]}server-information`)) as { publicKeys?: { key: string; id: string; purpose?: number }[] };
  const k = info?.publicKeys?.find((x) => x.purpose === 1 || x.purpose === undefined) || info?.publicKeys?.[0];
  if (!k?.key || !k?.id) throw new AppError("کلید سامانه‌ی مودیان دریافت نشد", 502);
  const v = { at: Date.now(), key: k.key, id: k.id };
  serverKeys.set(e, v);
  return v;
};

const token = async (c: MoadianCreds) => {
  const n = (await call(`${BASE[c.env]}nonce?timeToLive=20`)) as { nonce?: string };
  if (!n?.nonce) throw new AppError("سامانه‌ی مودیان در دسترس نیست", 502);
  return signJws({ nonce: n.nonce, clientId: c.memoryId }, unseal(c.privateKey), c.certificate);
};

const authed = async (c: MoadianCreds, path: string, init: RequestInit = {}) =>
  call(`${BASE[c.env]}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token(c)}`, ...(init.headers || {}) },
  });

export type SentPacket = { uid: string; referenceNumber: string };

// one call for up to a few dozen invoices of the same taxpayer
export const sendInvoices = async (c: MoadianCreds, invoices: { uid: string; json: unknown }[]): Promise<SentPacket[]> => {
  if (moadianSimulated()) {
    console.log(`[moadian] (development) ${invoices.length} invoice(s) of ${c.memoryId} not sent`);
    return invoices.map((i) => ({ uid: i.uid, referenceNumber: `dev-${crypto.randomUUID()}` }));
  }
  const key = unseal(c.privateKey);
  const sk = await serverKey(c.env);
  const body = invoices.map((i) => ({
    payload: encryptJwe(signJws(i.json, key, c.certificate), sk.key, sk.id),
    header: { requestTraceId: i.uid, fiscalId: c.memoryId },
  }));
  const res = (await authed(c, "invoice", { method: "POST", body: JSON.stringify(body) })) as {
    result?: { uid?: string; referenceNumber?: string }[];
  };
  return (res?.result || [])
    .filter((r) => r.uid && r.referenceNumber)
    .map((r) => ({ uid: String(r.uid), referenceNumber: String(r.referenceNumber) }));
};

export type Inquiry = {
  referenceNumber: string;
  status: "SUCCESS" | "FAILED" | "PENDING" | "IN_PROGRESS" | string;
  errors: { code?: string; message: string }[];
  warnings: { code?: string; message: string }[];
};

const issues = (list: unknown) =>
  (Array.isArray(list) ? list : []).map((e: { code?: unknown; message?: unknown; msg?: unknown }) => ({
    code: e?.code != null ? String(e.code) : undefined,
    message: String(e?.message ?? e?.msg ?? "").slice(0, 500),
  }));

export const inquire = async (c: MoadianCreds, referenceNumbers: string[]): Promise<Inquiry[]> => {
  if (!referenceNumbers.length) return [];
  if (moadianSimulated())
    return referenceNumbers.map((r) => ({ referenceNumber: r, status: "SUCCESS", errors: [], warnings: [] }));
  const qs = referenceNumbers.map((r) => `referenceIds=${encodeURIComponent(r)}`).join("&");
  const res = (await authed(c, `inquiry-by-reference-id?${qs}`)) as unknown;
  const rows = (Array.isArray(res) ? res : (res as { result?: unknown[] })?.result || []) as Record<string, any>[];
  return rows.map((r) => ({
    referenceNumber: String(r.referenceNumber || ""),
    status: String(r.status || "PENDING"),
    errors: issues(r.data?.error),
    warnings: issues(r.data?.warning),
  }));
};

// the memory id's own record: proves the key and the id belong together
export const fiscalInfo = async (c: MoadianCreds) => {
  if (moadianSimulated()) return { nameTrade: "development", fiscalStatus: "ACTIVE", economicCode: "" };
  return (await authed(c, `fiscal-information?memoryId=${encodeURIComponent(c.memoryId)}`)) as Record<string, unknown>;
};
