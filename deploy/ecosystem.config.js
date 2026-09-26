// PM2 config for the ts.noyanai.com backend.
//   npm ci && npm run build && pm2 start deploy/ecosystem.config.js
// cwd must be the repo root: .env, Public/, NotPublic/ are resolved from it.
module.exports = {
  apps: [
    {
      name: "noyanai-ts-back",
      cwd: __dirname + "/..",
      script: "compile/server.js",
      env: { NODE_ENV: "production" },
      max_memory_restart: "1G",
    },
  ],
};
