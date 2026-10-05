// The AI policy, made once from the settings it replaces (2026-10):
//   - AppConfig.panelAiDailyLimit (the single per-user daily cap of panel
//     AI, 200) becomes the daily limit of every feature that counted
//     against it (copilot, voice, prescription, suggestions, summary, CRM,
//     call analysis, finance AI, the staff copilot);
//   - PatientProPlan.freeAiDailyLimit / proAiDailyLimit (20 / unlimited)
//     become the free and paid tiers of the patient's assistant, copilot
//     and voice; aiEnabled = false takes "Pro unlocks it" off;
//   - each feature's access is today's gate (Lib/ai/aiFeatures.ts
//     defaults), so nothing changes for anyone until the admin edits it;
//   - today's counts (PanelAiUsage per feature, AiDailyUsage) are carried
//     into AiUsage so nobody's day starts over.
import mongoose from "mongoose";
import moment from "moment-jalaali";
import AiPolicy from "../Models/AiPolicy";
import AiUsage from "../Models/AiUsage";
import PanelAiUsage from "../Models/PanelAiUsage";
import AiDailyUsage from "../Models/AiDailyUsage";
import PatientProPlan from "../Models/PatientProPlan";
import { AI_FEATURES, legacyFeatureKey } from "./ai/aiFeatures";
import { clearAiPolicyCache, defaultFeaturePolicy, legacySnapshot } from "./ai/aiPolicy";
import { tehranDay } from "./ai/aiGate";

export const migrateAiPolicy = async () => {
  if (await AiPolicy.exists({ singleton: "SINGLETON" })) return;
  const legacy = await legacySnapshot();
  const pro = await PatientProPlan.findOne({}).sort({ order: 1, _id: 1 }).select("aiEnabled").lean<{ aiEnabled?: boolean }>();
  const features = Object.fromEntries(
    AI_FEATURES.map((f) => {
      const p = defaultFeaturePolicy(f, legacy);
      if (f.audiences.includes("patient") && pro && pro.aiEnabled === false) p.pro = false;
      return [f.key, p];
    }),
  );
  try {
    await AiPolicy.create({ singleton: "SINGLETON", enabled: true, mode: "plan", features, legacy });
  } catch (err) {
    // made meanwhile by another instance
    if ((err as { code?: number })?.code === 11000) return;
    throw err;
  }
  clearAiPolicyCache();

  // today's counts
  const day = tehranDay();
  const month = moment().utcOffset(210).format("jYYYY-jMM");
  const ops: mongoose.AnyBulkWriteOperation[] = [];
  const add = (subject: unknown, feature: string, audience: string, count: number) => {
    if (!count) return;
    ops.push({
      updateOne: {
        filter: { scope: "user", subject, feature, day },
        update: { $inc: { count, requests: count }, $set: { month, audience, tier: "free" } },
        upsert: true,
      },
    });
  };
  const panel = await PanelAiUsage.find({ day }).select("user features").lean<{ user: unknown; features?: Record<string, number> }[]>();
  for (const row of panel)
    for (const [name, n] of Object.entries(row.features || {})) {
      const key = legacyFeatureKey(name);
      if (key) add(row.user, key, "doctor", Math.max(0, Number(n) || 0));
    }
  const patient = await AiDailyUsage.find({ day }).select("user count").lean<{ user: unknown; count?: number }[]>();
  for (const row of patient) add(row.user, "assistant.health", "patient", Math.max(0, Number(row.count) || 0));
  if (ops.length) await AiUsage.bulkWrite(ops as never, { ordered: false }).catch(() => undefined);
  console.log(`[ai] policy made from the old settings (panel ${legacy.panel}/day, patient ${legacy.patientFree}/${legacy.patientPro}); ${ops.length} counters carried over`);
};
