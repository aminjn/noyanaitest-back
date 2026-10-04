import mongoose from "mongoose";
import { seedRecommendedPlansIfEmpty } from "./licenseTiers";

// Boot migrations of the plan catalog (2026-10).
//
// 1. "aiAssistant" (the AI visit note draft and transcription) became its
//    own doctor module: until now it rode on "schedule", so every doctor
//    plan and license that has "schedule" gets it once - nobody loses the
//    feature they had; after that the super admin decides per plan.
// 2. A provider kind with no plans at all gets the recommended lineup
//    (Lib/licenseTiers.ts); a kind with any plan is never touched.
const AI_MARKER = "license-ai-assistant-module";

export const migrateAiAssistantModule = async () => {
  const db = mongoose.connection.db;
  if (!db) return;
  const marks = db.collection<{ _id: string; at: Date }>("bootmigrations");
  if (await marks.findOne({ _id: AI_MARKER })) return;
  let changed = 0;
  for (const name of ["basedoctorlicenses", "doctorprofilelicenses"]) {
    const res = await db
      .collection(name)
      .updateMany({ modules: "schedule" }, { $addToSet: { modules: "aiAssistant" } });
    changed += res.modifiedCount;
  }
  await marks.insertOne({ _id: AI_MARKER, at: new Date() });
  console.log(`[plans] aiAssistant module added to ${changed} doctor plans and licenses`);
};

export const migrateLicensePlans = async () => {
  await migrateAiAssistantModule();
  await seedRecommendedPlansIfEmpty();
};
