// PM2 config for the ts.noyanai.com backend.
//   npm ci && npm run build && pm2 start deploy/ecosystem.config.js
// cwd must be the repo root: .env, Public/, NotPublic/ are resolved from it.
module.exports = {
  apps: [
    {
      name: "noyanai-ts-back",
      cwd: __dirname + "/..",
      script: "compile/server.js",
      // Tehran time (Asia/Tehran) as a second guard: the code reads Tehran
      // through Lib/tehranTime.ts whatever the zone, and this keeps any
      // stray server-local date (logs, a library) on Tehran too
      env: { NODE_ENV: "production", TZ: "Asia/Tehran" },
      max_memory_restart: "1G",
    },
  ],
};
