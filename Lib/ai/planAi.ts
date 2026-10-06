// A plan can sell AI (2026-10): every provider plan (Base*License) and the
// patients' Pro plan carry
//   aiFeatures  registry keys the plan includes (unlocks them for its
//               holders even when the policy's modules would not)
//   aiQuotas    { featureKey: { day, month, orgMonth } } the plan's own
//               limits for its holders, over the policy's paid tier
//               (0 = unlimited, a missing number = the policy's)
// Both are checked against the registry (Lib/ai/aiFeatures.ts), so what a
// plan may hold follows the registry.
import mongoose from "mongoose";
import { AiAudience, featuresFor } from "./aiFeatures";

export const planAiFields = {
  aiFeatures: { type: [String], default: [] },
  aiQuotas: { type: mongoose.Schema.Types.Mixed, default: {} },
};

export type PlanAiQuota = { day?: number; month?: number; orgMonth?: number };

const whole = (v: unknown) => {
  if (v === "" || v === null || v === undefined) return undefined;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 10_000_000) : undefined;
};

const parsed = (v: unknown) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};

// the plan's AI fields of a form body, cleaned for the plan's audience;
// a field the body does not carry stays as it is
export const sanitizePlanAi = (audience: AiAudience, body: Record<string, unknown>) => {
  const allowed = new Set(featuresFor(audience).map((f) => f.key));
  if (body.aiFeatures !== undefined) {
    const list = parsed(body.aiFeatures);
    body.aiFeatures = Array.isArray(list) ? Array.from(new Set(list.filter((k) => typeof k === "string" && allowed.has(k)))) : [];
  }
  if (body.aiQuotas !== undefined) {
    const map = parsed(body.aiQuotas);
    const out: Record<string, PlanAiQuota> = {};
    if (map && typeof map === "object" && !Array.isArray(map))
      for (const [key, q] of Object.entries(map as Record<string, unknown>)) {
        if (!allowed.has(key) || !q || typeof q !== "object") continue;
        const row: PlanAiQuota = {};
        for (const k of ["day", "month", "orgMonth"] as const) {
          const n = whole((q as Record<string, unknown>)[k]);
          if (n !== undefined) row[k] = n;
        }
        if (Object.keys(row).length) out[key] = row;
      }
    body.aiQuotas = out;
  }
  return body;
};
