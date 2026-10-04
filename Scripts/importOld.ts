// Command-line run of the old-site import (Services/oldSiteImport.ts), used
// by deploy/arvan/import-old.sh after it restored the old database here as
// "Noyan". Same service as the admin devtools button, without HTTP/auth.
//
//   node compile/Scripts/importOld.js [--only=doctor,blog] [--no-files]
//   env: OLD_FILES_BASE_URL=https://noyanai.com/files (optional)
//
// Run from the backend folder (it reads .env and writes into Public/).
import mongoose from "mongoose";
import * as env from "../Lib/Env";
import {
  OLD_IMPORT_STEPS,
  OldImportJob,
  OldImportStep,
  recordCliRun,
  runOldImport,
} from "../Services/oldSiteImport";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}`));

const main = async () => {
  const onlyArg = arg("only")?.split("=")[1];
  const only = onlyArg
    ? (onlyArg.split(",").map((s) => s.trim()).filter(Boolean) as OldImportStep[])
    : undefined;
  const bad = only?.filter((s) => !OLD_IMPORT_STEPS.includes(s));
  if (bad?.length) throw new Error(`unknown collection(s): ${bad.join(", ")} (known: ${OLD_IMPORT_STEPS.join(", ")})`);

  const auth =
    env.DB_USERNAME && env.DB_PASSWORD
      ? `${encodeURIComponent(env.DB_USERNAME)}:${encodeURIComponent(env.DB_PASSWORD)}@`
      : "";
  await mongoose.connect(
    `mongodb://${auth}${env.dbHost}:${env.dbPort}/${env.dbName}${auth ? "?authSource=admin" : ""}`,
  );
  console.log(`[importOld] ${env.dbName} <- Noyan`);

  const job: OldImportJob = {
    id: `cli-${Date.now()}`,
    status: "running",
    phase: "starting",
    total: 0,
    processed: 0,
    startedAt: new Date().toISOString(),
    source: "cli",
    steps: only || [...OLD_IMPORT_STEPS],
  };
  let lastLine = "";
  try {
    job.result = await runOldImport(
      { only, downloadFiles: !arg("no-files"), filesBaseUrl: process.env.OLD_FILES_BASE_URL, source: "cli" },
      (p) => {
        job.phase = p.phase;
        job.processed = p.processed;
        job.total = p.total;
        const pct = p.total ? Math.floor((p.processed / p.total) * 100) : 0;
        const line = `${p.phase} ${pct}%`;
        if (line !== lastLine && (pct % 10 === 0 || p.processed === p.total)) {
          lastLine = line;
          console.log(`[importOld] ${p.phase.padEnd(10)} ${p.processed}/${p.total} (${pct}%)`);
        }
      },
    );
    job.status = "done";
    job.phase = "done";
  } catch (err) {
    job.status = "failed";
    job.phase = "failed";
    job.error = { message: (err as Error).message };
    throw err;
  } finally {
    job.finishedAt = new Date().toISOString();
    await recordCliRun(job);
  }

  const { counts, files, notes } = job.result!;
  const rows = Object.entries(counts).map(([name, c]) => ({
    collection: name,
    total: c.total,
    created: c.created,
    updated: c.updated,
    unchanged: c.unchanged,
    skipped: c.skipped,
    errors: c.errors,
  }));
  console.log("");
  console.table(rows);
  console.log(
    `files: downloaded ${files.downloaded}, already here ${files.present}, kept as path/URL ${files.kept}, failed ${files.failed}`,
  );
  for (const f of files.failures.slice(0, 10)) console.log(`  file failed: ${f}`);
  for (const [name, c] of Object.entries(counts))
    for (const m of c.messages.slice(0, 5)) console.log(`  ${name}: ${m}`);
  for (const n of notes) console.log(`note: ${n}`);
};

main()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`[importOld] failed: ${(err as Error).message}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
