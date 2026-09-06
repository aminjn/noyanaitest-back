# 01 — Project Map

Audit pass date: 2026-09-03. Scope: `noyanai-front` (client) + `noyanai-back` (server), two separate git repos that together form one product ("NoyanAI" — a multi-sided healthcare marketplace/telemedicine platform covering patients, doctors, clinics, pharmacies, para-clinics, and insurance).

This document is descriptive only (Phase 1: build a map). No behavioral judgments belong here — those start in Phase 3 onward.

---

## 1. Repository structure

### noyanai-front (~1,501 .ts/.tsx files, git: 50 commits, branch `master` only)

```
noyanai-front/
├── app/                    Next.js 14 App Router — route tree (pages, layouts, route handlers)
│   ├── [adminKey]/         Admin panel — ~90 sub-routes, one per data entity, gated by a dynamic URL segment
│   ├── dashboard/          Patient-facing "my account" panel
│   ├── doctorpanel/        Doctor org panel (largest panel: ~20 sub-sections)
│   ├── clinicpanel/        Clinic org panel
│   ├── pharmacypanel/      Pharmacy org panel
│   ├── paraClinicPanel/    Para-clinic org panel (note casing differs from others — see §5)
│   ├── insurancepanel/     Insurance org panel (thinnest — 2 sub-sections)
│   ├── secretarypanel/     Shared secretary panel (works across doctor/clinic/pharmacy/paraClinic/insurance)
│   ├── wizard/, call/, session/   AI chat + WebRTC calling surfaces
│   ├── book/, cart/, order/, payment/   Booking & commerce flow
│   └── (public entity pages: doctor/, clinic/, pharmacy/, drug/, disease/, product/, etc.)
├── Components/             All React components + client-side domain logic, mirrors `app/` structure roughly 1:1
│   ├── Admin/, DoctorPanel/, ClinicPanel/, PharmacyPanel/, ParaClinicDashboard/, InsurancePanel/, SecretaryPanel/
│   ├── Enums/              contentKeys/contentNamespaces (i18n-ish text-key system), route maps, static enums
│   ├── helpers/             API client wrappers (getPublicData, etc.)
│   ├── Hooks/, Store/, UI/  Shared hooks, client state, generic UI kit
│   └── _Common/SecretaryManager/  Shared secretary-management widget reused across org panels
├── middleware.ts           Edge middleware: short-link + redirect resolution against backend
├── public/, inlinead/       Static assets; a top-level ad-unit route oddly living outside `app/`
├── _to_delete/, _to_delete_tsconfig.scoped.json   Explicitly-named scratch/legacy files (see 08_DEAD_CODE)
├── TODO.md                  Hand-maintained backlog, dated 2026-08-15 — see §6, high signal for Phases 3/7/8
└── package.json              Next.js 14.2.30, React 18, mediasoup-client, socket.io-client, ag-grid-enterprise, maplibre-gl
```

### noyanai-back (~295 .ts files under source, git: 49 commits, branch `master` only)

```
noyanai-back/
├── app.ts                  Express app assembly: middleware, ~28 static router mounts + 1 dynamic ACL-based mount
├── server.ts                Process entry: env/DB bootstrap, cron-style interval jobs, HTTP+socket.io server, mongoose connect
├── Routers/, Controllers/   One router+controller pair per domain (28 routers; see 05_CONTRACT_DRIFT for router↔controller mapping)
├── Models/                  ~180 Mongoose schemas (flat directory except Models/Old, Models/Bot, Models/Geo, Models/Prescription)
│   └── Old/                 8 legacy schemas (OldBlog, OldDisease, OldDrug, OldPart, OldSymptom, oldDoctor, oldSpeciality, oldUser)
├── Services/                 Higher-level orchestration: Call/ (mediasoup SFU), reservation lifecycle sweeps, push notifications, slug generation
├── Lib/                      Cross-cutting utilities: Env.ts (env parsing), appConfig.ts (live-reloaded runtime config), AppError, validators, sipService, snappClient
├── socket/                   Second, apparently separate socket.io wiring (Client.ts, Room.ts, mediasoup.ts, controller/, middleware/) — relationship to Services/Call is unresolved, see §5
├── Public/, NotPublic/       Uploaded file storage (served statically / access-controlled), populated with real user-uploaded filenames already
├── CallRecordings/           Recorded call media storage
├── compile/                  tsc build output (mirrors source tree) — this is what `npm start` actually runs
├── Controllers/deleteme/     Empty directory, self-named for removal
└── package.json               Express 4, Mongoose 8, socket.io 4, mediasoup 3.19, ari-client (Asterisk/SIP), ollama client, web-push, zod
```

---

## 2. Technology stack

| Layer | Technology |
|---|---|
| Frontend framework | Next.js 14.2.30 (App Router), React 18, TypeScript 5 (strict mode on) |
| Frontend state/data | SWR, custom `Components/Store`, no Redux/Zustand present |
| Frontend UI | Custom CSS/components, ag-grid-enterprise (data grids), maplibre-gl + terra-draw (maps), slate (rich text), react-pdf/renderer |
| Backend framework | Express 4 on Node, TypeScript 5, compiled via `tsc` to `compile/` and run with plain `node` (no ts-node in prod) |
| Database | MongoDB via Mongoose 8 (single DB, connection string built from env; auth optional) |
| Real-time | socket.io 4 (two parallel wiring paths, see §5) + mediasoup 3.19 (self-hosted WebRTC SFU) for audio/video calls |
| Telephony | `ari-client` (Asterisk REST Interface / SIP) — present in package.json and server.ts imports, but the only call site is commented out (see §5, §8 candidate) |
| AI | `ollama` npm client — local/self-hosted LLM backend for the `/wizard` AI chat feature and admin `aiExample`/`ollama` tools |
| Push notifications | `web-push` (VAPID keys in env) |
| Delivery integration | Snapp courier API (`Lib/snappClient.ts`, pharmacy-only dispatch) |
| Auth | JWT (`jsonwebtoken`) + `bcryptjs`, cookie-based (`cookie-parser`) |
| i18n/content | Bespoke `contentKeys`/`contentNamespaces` system in `Components/Enums` (per user memory: no hardcoded UI strings is an enforced convention) |

---

## 3. Entry points

- **Frontend runtime**: `next dev` / `next start --port 3001` (package.json scripts). Route entry is the App Router tree under `app/`. `middleware.ts` runs on every request first (short-link + redirect lookups against the backend).
- **Backend runtime**: `noyanai-back/server.ts` → compiled to `compile/server.js`, run via `node compile/server.js` (prod) or `nodemon` watching `tsc --watch` output (dev, via `concurrently`). `server.ts` imports `app.ts` (the Express app/router assembly) and layers on: HTTP server creation, mediasoup/socket.io call service init (`initCallService`), mongoose connection, and several `setInterval`-based background jobs (doctor availability recalculation, slug generation, reservation reminder/activation/finalization sweeps).
- **API base path**: all backend routes are mounted under `/api/v1/*` in `app.ts`.

---

## 4. Important configuration

- `noyanai-back/Lib/Env.ts` — typed access to process.env (DB host/port/name/credentials, JWT secret/expiry, OTP settings, SIP creds, third-party API keys, Podium token, mediasoup worker count, VAPID keys).
- `noyanai-back/Lib/appConfig.ts` — a **second**, DB/runtime-backed config layer (`getAppConfig()`) read fresh per-call in most places, but only read **once at boot** to size the `setInterval` background jobs in `server.ts` (explicitly documented in a comment in `server.ts`: changing those specific intervals from the admin settings page requires a server restart to take effect — a documented, intentional partial-live-reload gap, not a bug by itself, but worth carrying into Phase 6/7 since it's exactly the kind of "two systems can disagree" seam this audit is looking for).
- `noyanai-front/next.config.mjs` — exposes `API`, `ADMIN_KEY`, `DOMAIN`, `TAMIN_DOMAIN`, `BACKEND`, `FILE_PATH` to the client bundle via `env`.
- Env var inventory (names only, values not reproduced here):
  - Backend `.env`: `DB_USERNAME`, `DB_PASSWORD`, `JWT_SECRET`, `NODE_ENV`, `SIP_HOST`, `SIP_USERNAME`, `SIP_PASSWORD`, `GET_IDENTITY_INFO_API_KEY`, `MATCH_NATIONAL_ID_AND_PHONE_NUMBER_API_KEY`, `GET_MEDICAL_SYSTEM_CODE_API_KEY`, `GET_MC_CERTIFICATE_API_KEY`, `PODIUM_TOKEN`, `MEDIASOUP_NUM_WORKERS`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
  - Frontend `.env.local`: `API`, `ADMIN_KEY`, `DOMAIN`, `TAMIN_DOMAIN`, `BACKEND`, `FILE_PATH`.
  - `noyanai-back/env` (a template/reference file, not the real `.env`) shows `ADMIN_KEY=notadmin` as a checked-in default and documents expected shapes (`DB_USERNAME?`, `OTP_PATTERN?`, `NODE_ENV=development ( production | development )`) — flagged for Phase 10, not yet investigated.

---

## 5. Notable architectural seams (flagged for later phases, not yet root-caused)

These are observations from Phase 1 reconnaissance that look like exactly the "old/new" or "two systems, one concept" pattern the later phases should chase down. Listed here as pointers, not conclusions.

1. **Two socket.io wiring paths in the backend**: `noyanai-back/socket/` (Client.ts, Room.ts, mediasoup.ts, controller/, middleware/) alongside `noyanai-back/Services/Call/` (CallRuntime.ts, CallService.ts, callSocket.ts, mediasoupConfig.ts, workerPool.ts). `server.ts` only calls `initCallService` from `Services/Call`. Whether `socket/` is a superseded predecessor, a still-used shared layer, or dead code is unresolved — candidate for Phase 2/3/8.
2. **Telephony (ARI/SIP) appears wired at the package/type level but disabled at the call site**: `server.ts` imports `ari-client` and declares SIP-related types, but the only usage (`listenForCall`) is entirely commented out. `TODO.md` independently lists "Resolve telephony test endpoints" and "Delete leftover SIP config" under Cross-cutting — corroborating this is known, tracked debt rather than an accidental discovery. Candidate for Phase 8 (dead code) / Phase 11 (git archaeology on when it was disabled).
3. **Prescription v1/v2 migration in progress**: frontend has both `Components/DoctorPanel/Prescription` and `Components/DoctorPanel/Prescription2`; `TODO.md` explicitly lists "Migrate prescription edit to v2," "Migrate prescription print to v2," and "Retire prescription v1" as open items. Backend has a single `Models/Prescription/` — needs Phase 3 investigation into whether both frontend versions target the same backend shape or have drifted.
4. **`Models/Old/*` + `Routers/oldRouter.ts` + `app/[adminKey]/old/*`**: a full old/new pair for blog, disease, drug, part, speciality, symptom, doctor, user — old models are still imported in `app.ts` and `oldRouter` is still mounted at `/api/v1/old`, meaning this legacy system is confirmed *reachable*, not just present. High-priority Phase 3 target.
5. **A dynamic, ACL-driven router dispatch exists alongside static router mounts**: in `app.ts`, `clinic`/`pharmacy`/`doctor`/`insurance`/`paraClinic` are each mounted twice — once implicitly (their router modules are imported) and once explicitly via a `nameToRouter` map keyed off `nodesWithAcl` (from `aclController`) and mounted at `/api/v1/:name`. Needs Phase 5 tracing to confirm this isn't a double-mount/route-shadowing risk.
6. **`app.ts` has an unexplained global 1ms delay middleware** (`await new Promise(r => setTimeout(r, 1))` before every route) with no comment explaining its purpose. Candidate for Phase 4 (unexplained/suspicious code) — not yet classified as intentional (e.g. event-loop yielding) vs. leftover debugging artifact.
7. **Casing inconsistency**: `paraClinicPanel` route folder is `app/paraClinicPanel` (capital C mid-path) while sibling panels are all-lowercase (`doctorpanel`, `clinicpanel`, `pharmacypanel`, `insurancepanel`). Cosmetic on its own, but per user's existing memory ([[project_paraclinic_license_gate_2026_09]]) ParaClinic components already live under a differently-named directory (`ParaClinicDashboard/` not `ParaClinicPanel/`) — naming drift around this one org type looks systemic rather than a one-off typo.
8. **Two build-info/tsconfig artifacts for a "wizard" subsystem**: `tsconfig.wizard.tsbuildinfo`, `tsconfig.wizard2.tsbuildinfo`, and `_to_delete/tsconfig.wizard.json` + `_to_delete/tsconfig.wizard2.json` at the front-end root suggest a scoped-typecheck setup (per existing memory, used to work around a `--noResolve` scoped-tsc quirk) that was later part-migrated into `_to_delete`. Needs confirmation of current usage vs. abandonment.

---

## 6. Existing self-documentation found (high-value, authored by the project owner)

- `noyanai-front/TODO.md` (dated 2026-08-15): a hand-written, dated backlog covering every panel and several backend domains. This is strong corroborating evidence for later phases — several TODO items independently confirm code-level observations above (prescription v1/v2, SIP/telephony cleanup, "Book page: remove dead code," "Fix availability race condition," "Fix timezone shift bug," "Auto-fill blog author," "Fix Offer owner list"). Treat unchecked TODO items as a *lead*, not proof — the code should still be independently verified per audit rule 7, but this file effectively pre-registers several findings this audit is expected to surface.
- `noyanai-back/CALL_SERVICE.md` (21KB — not yet read in full) — likely documents the `Services/Call` mediasoup/socket.io subsystem; should be read before drawing conclusions about the two socket.io paths in §5.1.
- `noyanai-back/missing-content-keys.txt` (514KB, freshly modified today) — appears to be generated output from a content-key sync check, corroborating the existing memory note that frontend/backend content-key lists require manual sync and can drift.

---

## 7. Data stores & external services

- **Primary data store**: single MongoDB instance (Mongoose), ~180 top-level schemas plus a few nested namespaces (`Models/Bot`, `Models/Geo`, `Models/Prescription`, `Models/Old`).
- **File storage**: local filesystem — `Public/` (publicly served), `NotPublic/` (access-controlled), `CallRecordings/` — not object storage (e.g. S3); already contains real user-uploaded content (patient profile images, gallery items).
- **External services integrated**: Asterisk/SIP telephony (ari-client — disabled, see §5.2), Ollama (self-hosted LLM), Snapp (courier/delivery dispatch), Podium (purpose not yet investigated — token present in env), Tamin (Iranian social security / insurance integration — `TAMIN_DOMAIN` env, `Lib/MakeTamjinRequest.ts`, extensive `Tamin*` models; per `TODO.md` this runs against a sandbox, not the real API, and is expected to be rewritten), national-identity verification APIs (`GET_IDENTITY_INFO_API_KEY`, `MATCH_NATIONAL_ID_AND_PHONE_NUMBER_API_KEY`, `GET_MEDICAL_SYSTEM_CODE_API_KEY`, `GET_MC_CERTIFICATE_API_KEY`), web-push (VAPID).

---

## 8. Build/runtime architecture summary

- Two independently deployed apps, no shared package/monorepo tooling (no lerna/turborepo/workspaces detected) — front and back are separate git repos with separate `package.json`/`tsconfig.json`, communicating purely over HTTP (`API`/`BACKEND` env vars) + socket.io.
- Backend has no test runner, linter config, or CI config detected at this pass (to confirm in later phases).
- Frontend has ESLint (`eslint-config-next`) but no test runner detected at this pass.
- Both repos are single-branch (`master`) with linear, small commit histories (~50 commits each) relative to file count (1,501 + 295 source files) — suggests either a long pre-git history, squashed history, or a young repo with heavy early velocity; worth a real `git log --since`/date-range check in Phase 11 rather than assuming.

---

## Open items carried into later phases

- Read `CALL_SERVICE.md` before finalizing any conclusion about the two socket.io paths.
- Confirm whether `noyanai-back/socket/` is reachable from any current code path (Phase 2/8).
- Confirm current status of `_to_delete/` and `Controllers/deleteme/` (Phase 8).
- Full router → controller → model dependency inventory is deferred to Phase 2 (not attempted here to keep this pass structural, per audit instructions).
