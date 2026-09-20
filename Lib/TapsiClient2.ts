import TapsiCredential from "../Models/TapsiCredential";
import * as env from "./Env";
import { TapsiNotConfiguredError, TapsiRequestError } from "./AppError";

const ensureConfigured = () => {
  if (!env.TAPSI_BASE_URL || !env.TAPSI_USERNAME || !env.TAPSI_PASSWORD)
    throw new TapsiNotConfiguredError();
};

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

const ensureToken = async (): Promise<string> => {
  const cached = await TapsiCredential.findOne({
    singleton: "SINGLETON",
  }).select("+token");
  if (cached?.token) return cached.token;
  return login();
};

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


export interface TapsiCoordinate {
  latitude: number;
  longitude: number;
}

export interface TapsiServiceOption {
  key: string;
  name: string;
  token: string;
  price: { min: number; max: number };
  eta?: { time: number; kind: string };
}

export interface TapsiPricePreviewResponse {
  token?: string;
  services: TapsiServiceOption[];
  ttl?: number;
}

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
  phoneNumber: string;
  email?: string;
}

export interface TapsiDeliveryRequestDetails {
  sender?: { name?: string; phoneNumber?: string; address?: string };
  receivers?: unknown[];
  payer?: "SENDER" | "RECEIVER";
  description?: string;
}

export interface TapsiRideRequestPayload {
  origin: TapsiCoordinate;
  destinations: TapsiCoordinate[];
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

export const getRideStatus = (
  rideIds: string[],
): Promise<{ rides: TapsiRideStatus[] }> =>
  request<{ rides: TapsiRideStatus[] }>("/api/v2/ride/batch", "POST", {
    rideIds,
  });

export const cancelRide = (
  rideId: string,
): Promise<{ message: string; cancellationFee: number | null }> =>
  request(`/api/v2.1/ride/request/${rideId}`, "DELETE");
