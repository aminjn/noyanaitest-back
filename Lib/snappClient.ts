import SnappCredential from "../Models/SnappCredential";
import * as env from "./Env";
import { SnappNotConfiguredError, SnappRequestError } from "./AppError";

// Thin client for Snapp's corporate (B2B) API V2 (2026-09) - see the
// "1. Authentication API V2" / "2. Ride API V2" / "3. Ride/Financial History
// API V2" / "4. Payment API V2" reference docs. Used today to dispatch a
// Snapp Box courier ride for a pharmacy's order delivery (see
// pharmacyController.dispatchOrderDelivery); the history/payment/balance
// methods are included for completeness and aren't wired to any endpoint
// yet.
//
// Auth model: login() exchanges SNAPP_USERNAME/SNAPP_PASSWORD for a
// token/refresh_token pair, cached in the DB (Models/SnappCredential.ts
// singleton, not in memory, so it survives restarts and is shared across
// instances). Every request() call reuses the cached token and, per the
// docs' own note ("whenever you got a 401 error, get a new token in
// Authentication API"), transparently re-logs-in and retries once on a 401
// rather than using the refresh-token endpoint - simpler, and login has no
// rate limit documented.

const ensureConfigured = () => {
  if (!env.SNAPP_BASE_URL || !env.SNAPP_USERNAME || !env.SNAPP_PASSWORD)
    throw new SnappNotConfiguredError();
};

interface SnappTokenPair {
  token: string;
  refresh_token: string;
}

const saveTokenPair = async ({ token, refresh_token }: SnappTokenPair) => {
  await SnappCredential.findOneAndUpdate(
    { singleton: "SINGLETON" },
    {
      $set: {
        token,
        refreshToken: refresh_token,
        updatedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

const login = async (): Promise<SnappTokenPair> => {
  ensureConfigured();
  const res = await fetch(`${env.SNAPP_BASE_URL}/api/v2/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: env.SNAPP_USERNAME,
      password: env.SNAPP_PASSWORD,
    }),
  });
  if (!res.ok) throw new SnappRequestError();
  const data = (await res.json()) as SnappTokenPair;
  await saveTokenPair(data);
  return data;
};

// Returns the cached token, logging in fresh if nothing is cached yet (e.g.
// first call ever, or a fresh database).
const ensureToken = async (): Promise<string> => {
  const cached = await SnappCredential.findOne({
    singleton: "SINGLETON",
  }).select("+token");
  if (cached?.token) return cached.token;
  const { token } = await login();
  return token;
};

// Generic authenticated request against the Snapp API. Retries once via a
// fresh login if the cached token has expired (401).
const request = async <T = unknown>(
  path: string,
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
  _retried = false,
): Promise<T> => {
  ensureConfigured();
  const token = await ensureToken();
  const res = await fetch(`${env.SNAPP_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !_retried) {
    await login();
    return request<T>(path, method, body, true);
  }
  if (!res.ok) throw new SnappRequestError();
  // some endpoints (e.g. logout) return a body with no content-type set;
  // guard against an empty body breaking .json()
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
};

// ---- Ride ----

// Snapp's numeric service types (2. Ride API V2#Take A Ride). Only Box
// (courier/package delivery) is used by dispatchOrderDelivery today.
export const snappServiceTypes = {
  eco: 1,
  plus: 2,
  rose: 3,
  box: 5,
  bike: 7,
} as const;

export interface SnappRideRequestPayload {
  origin_lat: number;
  origin_lng: number;
  destination_lat: number;
  destination_lng: number;
  service_type: number;
  by_credit: boolean;
  // mandatory only for service_type 5 (Box)
  extra_info?: string;
  is_paid_by_recipient?: boolean;
  package_info?: string;
  recipient_name?: string;
  recipient_cellphone?: string;
  sender_cellphone?: string;
}

export interface SnappRideRequestResponse {
  // misleadingly named by Snapp - this is the HRI (Human Readable ID), not a
  // numeric ride id. Every other ride endpoint is addressed by this string.
  ride_id: string;
}

export const requestRide = (
  payload: SnappRideRequestPayload,
): Promise<SnappRideRequestResponse> =>
  request<SnappRideRequestResponse>("/api/v2/ride/request", "POST", payload);

// current_state values from the Active Rides / Refresh Ride responses
// (2. Ride API V2#current_state).
export const snappRideStates = {
  started: 1,
  accepted: 2,
  arrived: 3,
  boarded: 4,
  finished: 5,
  cancelledByCustomer: 6,
  cancelledByDriver: 7,
  cancelledByBackoffice: 8,
  nobodyAccepted: 9,
  couldNotCalculatePrice: 10,
  cancelledDueNewRideRequest: 11,
  driverRequestedFareReview: 12,
  cancelFinishedRide: 13,
  finishCanceledRide: 14,
  fareReviewDone: 15,
  arrivedFirstDestination: 16,
  arrivedSecondDestination: 17,
  updatingRideOptions: 18,
  cancelledWithFee: 19,
  finishing: 20,
  settled: 21,
  fareReviewCancelled: 22,
} as const;

export interface SnappRideInfo {
  ride_id: string;
  current_state: number;
  name: string;
  cellphone: string;
  service_type: number;
  is_delivery: boolean;
  final_price: number;
  origin: { lat: number; lng: number; formatted_address: string };
  destination: { lat: number; lng: number; formatted_address: string };
  start_time: string;
  shareurl: string;
  payment_type: number;
}

export interface SnappRideRefreshResponse {
  ride_info: SnappRideInfo;
  [key: string]: unknown;
}

export const refreshRide = (hri: string): Promise<SnappRideRefreshResponse> =>
  request<SnappRideRefreshResponse>(`/api/v2/ride/${hri}/refresh`, "GET");

export interface SnappRideStatusResponse {
  message: string;
  ride_status: string;
}

export const getRideStatus = (hri: string): Promise<SnappRideStatusResponse> =>
  request<SnappRideStatusResponse>(`/api/v2/ride/${hri}/status`, "GET");

export const getActiveRides = (): Promise<
  { ride_info: SnappRideInfo; [key: string]: unknown }[]
> => request(`/api/v2/ride/active`, "GET");

// Note: only allowed while the ride's current_state is STARTED(1),
// ACCEPTED(2) or ARRIVED(3) - Snapp rejects the request otherwise.
export const cancelRide = (
  hri: string,
): Promise<{ status: number; data: { message: string } }> =>
  request(`/api/v2/ride/${hri}/cancel`, "PATCH");

export interface SnappRidePriceRequestPayload {
  origin_lat: number;
  origin_lng: number;
  destination_lat: number;
  destination_lng: number;
  extra_destination_lat?: number | null;
  extra_destination_lng?: number | null;
  destination_place_id?: number | null;
  voucher_code?: string | null;
  round_trip?: boolean;
  waiting?: string | null;
  tag?: number;
}

export const getRidePrice = (
  payload: SnappRidePriceRequestPayload,
): Promise<{ prices: unknown[]; [key: string]: unknown }> =>
  request(`/api/v2/ride/price`, "POST", payload);

export interface SnappRideHistoryQuery {
  date_min: number;
  date_max: number;
  page: number;
  hri?: string;
  passenger_name?: string;
  passenger_phone?: string;
  credit?: 0 | 1 | 2;
}

const toQueryString = (query: object) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== null)
      params.append(key, String(value));
  return params.toString();
};

export const getRideHistory = (
  query: SnappRideHistoryQuery,
): Promise<{ status: number; data: { rides: unknown[] } }> =>
  request(`/api/v2/ride/history?${toQueryString(query)}`, "GET");

// ---- Financial ----

export interface SnappFinancialHistoryQuery {
  page: number;
  date_min?: number;
  date_max?: number;
  payment?: 3 | 4;
  export?: number;
}

export const getFinancialHistory = (
  query: SnappFinancialHistoryQuery,
): Promise<unknown> =>
  request(`/api/v2/financial/history?${toQueryString(query)}`, "GET");

export const createPayment = (
  amount: number,
): Promise<{
  status: number;
  data: { redirect_url: string; callback_url: string };
}> => request(`/api/v2/financial/payment`, "POST", { amount });

export const getBalance = (): Promise<{
  status: number;
  data: { balance: number };
}> => request(`/api/v2/profile/balance`, "GET");
