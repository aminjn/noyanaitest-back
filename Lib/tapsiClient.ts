import TapsiCredential from "../Models/TapsiCredential";
import * as env from "./Env";
import { TapsiNotConfiguredError, TapsiRequestError } from "./AppError";

// Thin client for Tapsi's Corporate API (B2B ride booking, 2026-09) - see
// https://co.tapsi.ir/docs. General-purpose wrapper, not wired to any
// specific feature yet (mirrors the shape of Lib/snappClient.ts, which
// *is* wired to pharmacy order delivery - see that file's header comment
// for the precedent this follows).
//
// Auth model: login() exchanges TAPSI_USERNAME/TAPSI_PASSWORD for a JWT,
// cached in the DB (Models/TapsiCredential.ts singleton, not in memory,
// so it survives restarts and is shared across instances). Every
// request() call reuses the cached token and transparently re-logs-in and
// retries once on a 401 (INVALID_TOKEN/EXPIRED_TOKEN per the docs)
// instead of waiting for the documented 1-hour expiry - there's no
// refresh-token endpoint, unlike Snapp.
//
// Booking flow (per the docs' "Getting Started"): pricePreview() first to
// get a per-service `token` + `key` (serviceKey), then requestRide() using
// that token (not the auth JWT) within its short TTL (~5-10 min), then
// poll status with getRideStatus() and, if needed, cancelRide().

const ensureConfigured = () => {
  if (!env.TAPSI_BASE_URL || !env.TAPSI_USERNAME || !env.TAPSI_PASSWORD)
    throw new TapsiNotConfiguredError();
};

// Every Tapsi response body follows this envelope
// ({result:"ERR",...} on any 4xx/5xx per the docs' "Error Handling").
interface TapsiOkEnvelope<T> {
  result: "OK";
  data: T;
}
interface TapsiErrEnvelope {
  result: "ERR";
  data: { code: string; message: string; payload?: Record<string, unknown> };
}
type TapsiEnvelope<T> = TapsiOkEnvelope<T> | TapsiErrEnvelope;

const saveToken = async (token: string) => {
  await TapsiCredential.findOneAndUpdate(
    { singleton: "SINGLETON" },
    { $set: { token, updatedAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

interface TapsiUser {
  id: number;
  role: string;
  profile: {
    firstName: string;
    lastName: string;
    email?: string;
    phoneNumber?: string;
  };
}

const login = async (): Promise<string> => {
  ensureConfigured();
  const res = await fetch(
    `${env.TAPSI_BASE_URL}/api/v2.2/user/corporate/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credential: {
          username: env.TAPSI_USERNAME,
          password: env.TAPSI_PASSWORD,
        },
        product: "CORPORATE",
      }),
    },
  );
  const json = (await res.json()) as TapsiEnvelope<{
    token: string;
    user: TapsiUser;
  }>;
  if (!res.ok || json.result === "ERR")
    throw new TapsiRequestError(
      json.result === "ERR" ? json.data.message : undefined,
      json.result === "ERR" ? json.data.code : undefined,
    );
  await saveToken(json.data.token);
  return json.data.token;
};

// Returns the cached token, logging in fresh if nothing is cached yet
// (e.g. first call ever, or a fresh database).
const ensureToken = async (): Promise<string> => {
  const cached = await TapsiCredential.findOne({
    singleton: "SINGLETON",
  }).select("+token");
  if (cached?.token) return cached.token;
  return login();
};

// Generic authenticated request against the Tapsi API. Retries once via a
// fresh login if the cached token has expired/is invalid (401).
const request = async <T = unknown>(
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
  _retried = false,
): Promise<T> => {
  ensureConfigured();
  const token = await ensureToken();
  const res = await fetch(`${env.TAPSI_BASE_URL}${path}`, {
    method,
    headers: {
      "X-Authorization": token,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !_retried) {
    await login();
    return request<T>(path, method, body, true);
  }

  // some endpoints could in principle return an empty body; guard against
  // that breaking JSON.parse
  const text = await res.text();
  const json = (text ? JSON.parse(text) : undefined) as
    | TapsiEnvelope<T>
    | undefined;

  if (!res.ok || !json || json.result === "ERR")
    throw new TapsiRequestError(
      json && json.result === "ERR" ? json.data.message : undefined,
      json && json.result === "ERR" ? json.data.code : undefined,
    );

  return json.data;
};

// ---- Ride ----

export interface TapsiCoordinate {
  latitude: number;
  longitude: number;
}

export interface TapsiServiceOption {
  key: string;
  name: string;
  // short-lived (~5-10 min per the docs) - pass through to requestRide()
  // as `token` alongside this option's `key` as `serviceKey`.
  token: string;
  price: { min: number; max: number };
  eta?: { time: number; kind: string };
}

export interface TapsiPricePreviewResponse {
  token?: string;
  services: TapsiServiceOption[];
  ttl?: number;
}

// Step 1 of booking - get price estimates and a per-service token/key to
// use in requestRide().
export const pricePreview = (
  origin: TapsiCoordinate,
  destinations: TapsiCoordinate[],
): Promise<TapsiPricePreviewResponse> =>
  request<TapsiPricePreviewResponse>("/api/v2.1/price/preview", "POST", {
    origin,
    destinations,
  });

export interface TapsiCorporatePassenger {
  firstName?: string;
  lastName?: string;
  // Iranian mobile, e.g. "09123456789" or "+989123456789"
  phoneNumber: string;
  email?: string;
}

// Only relevant when booking a package delivery instead of a passenger
// ride - /api/v2.3/ride accepts this alongside corporatePassenger either
// way. Kept here for completeness; not used by the passenger-ride flow.
export interface TapsiDeliveryRequestDetails {
  sender?: { name?: string; phoneNumber?: string; address?: string };
  receivers?: unknown[];
  payer?: "SENDER" | "RECEIVER";
  description?: string;
}

export interface TapsiRideRequestPayload {
  origin: TapsiCoordinate;
  destinations: TapsiCoordinate[];
  // from pricePreview()'s chosen TapsiServiceOption's .key / .token
  serviceKey: string;
  token: string;
  paymentMethod: "CASH" | "CARD";
  corporatePassenger: TapsiCorporatePassenger;
  numberOfPassengers: 1 | 2;
  deliveryRequestDetails?: TapsiDeliveryRequestDetails;
}

export interface TapsiRidePlace {
  latitude: number;
  longitude: number;
  address?: string;
  shortAddress?: string;
  city?: { name: string; nameFA: string };
}

export interface TapsiRide {
  id?: number;
  code: string;
  // opaque id to use with getRideStatus()/cancelRide()
  rideUId: string;
  status: string;
  createdAt: number;
  passengerShare: number;
  estimatedETA?: number;
  waitingTime?: number;
  paymentMethod: string;
  service: string;
  statusInfo?: { text: string };
  taker?: {
    id: number;
    profile: { firstName: string; lastName: string; phoneNumber: string };
  };
  origin: TapsiRidePlace;
  destinations: TapsiRidePlace[];
  tags?: string[];
}

// Step 2 - books the ride using the token/serviceKey from pricePreview().
// Returns a snapshot; persist `rideUId` to poll status/cancel later.
export const requestRide = (
  payload: TapsiRideRequestPayload,
): Promise<{ ride: TapsiRide }> =>
  request<{ ride: TapsiRide }>("/api/v2.3/ride", "POST", payload);

export interface TapsiRideStatus {
  rideId: string;
  status: string;
  driver: {
    name: string;
    phoneNumber: string;
    rating: number;
    location?: TapsiCoordinate;
  } | null;
  eta: number | null;
  price: { amount: number; currency: string } | null;
}

// Step 3 - poll one or more rides' live status by rideUId.
export const getRideStatus = (
  rideIds: string[],
): Promise<{ rides: TapsiRideStatus[] }> =>
  request<{ rides: TapsiRideStatus[] }>("/api/v2/ride/batch", "POST", {
    rideIds,
  });

// Only allowed while the ride is PENDING, ACCEPTED or DRIVER_ARRIVED - a
// STARTED/COMPLETED/CANCELLED ride is rejected with CANNOT_CANCEL_RIDE.
export const cancelRide = (
  rideId: string,
): Promise<{ message: string; cancellationFee: number | null }> =>
  request(`/api/v2.1/ride/request/${rideId}`, "DELETE");
