import { RequestHandler } from "express";

// Fields that must never reach a visitor, whatever query produced them.
// `select: false` on the schema covers find/populate only - an aggregate
// $lookup ignores it, and the public controllers join doctor profiles in
// many aggregates. So every public response is swept here as well.
const PRIVATE_KEYS = new Set([
  "ssid",
  "nationalId",
  "password",
  "token",
  "refreshToken",
]);

const strip = (value: unknown, depth = 0): void => {
  if (!value || typeof value !== "object" || depth > 40) return;
  if (Array.isArray(value)) {
    for (const item of value) strip(item, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (PRIVATE_KEYS.has(key)) delete record[key];
    else strip(record[key], depth + 1);
  }
};

export const stripPrivateFields: RequestHandler = (_req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body?: unknown) => {
    if (body && typeof body === "object") {
      const plain = JSON.parse(JSON.stringify(body));
      strip(plain);
      return json(plain);
    }
    return json(body);
  };
  next();
};
