# 10 — Security / Configuration Findings

Scope: code-level risk identification only, per audit rules — no exploitation attempted, no live requests sent against any deployment. Severities assume a standard production deployment; where the actual runtime configuration matters and wasn't verifiable from source alone, that's called out explicitly.

---

## Finding 10.1 — File uploads accept any file type/content and are vulnerable to path traversal via the original filename

**Location:** `noyanai-back/Controllers/uploadController.ts`

```ts
export const upload = multer({
  storage: multerStorage,          // memoryStorage — whole file buffered in RAM
  fileFilter: (req, file, cb) => cb(null, true),   // accepts everything
});
//TODO: add filter   <- the file's own comment, one line above `upload`
```

and in `saveUplaodsToBody`:

```ts
const filename = `${name}__${req.files[i].fieldname}__${new Date().getTime()}.${
  req.files[i].originalname.split(".").findLast(() => true)
}`;
await fs.writeFile(path.join(process.cwd(), "Public", filename), req.files[i].buffer);
```

**Two distinct issues:**

1. **No file-type restriction at all** (self-acknowledged by the `//TODO: add filter` comment — not a discovered oversight, but confirmed-incomplete work). Any content type — HTML, SVG, executables — can be uploaded and is written into `Public/`, which `app.ts` serves statically (`express.static(path.join(__dirname, "..", "Public"))`) at whatever public base path the deployment uses. An uploaded `.html` or `.svg` file with embedded script is served with no content-type enforcement seen in this path, which is a classic stored-XSS-via-upload vector if the browser is allowed to render it inline rather than download it.
2. **Path traversal via the "extension"**: the "extension" is derived as `originalname.split(".").findLast(() => true)` — the substring after the *last* dot in the attacker-supplied original filename, with zero sanitization. `path.join()` normalizes `..` segments, so a crafted `originalname` (e.g. one whose only, or last, "extension" segment contains `../../` sequences — trivially achievable by naming the uploaded file with no dot and traversal characters, or by placing `../` after the last dot) can cause the final `path.join(process.cwd(), "Public", filename)` to resolve *outside* the `Public/` directory entirely. Combined with issue #1 (arbitrary content, no filter), this is a path-traversal-based arbitrary file write — the most severe class of upload vulnerability, not just an unrestricted-file-type nuisance.

**Exposure:** this isn't admin-only. `uploadController.upload` is wired into 22 of 27 routers, including `userRouter.ts` (e.g. `POST /api/v1/user/... upload.single("avatar")`) and `doctorRouter.ts` (57 separate route mounts use it) — meaning any authenticated regular patient account, not just admins, can reach this code path via a normal avatar/document upload.

- Severity: **CRITICAL**
- Confidence: **HIGH** on the code path and lack of filtering (directly read, self-documented as incomplete). **MEDIUM** on whether the path-traversal variant is practically exploitable end-to-end without further testing (Node's `fs.writeFile` will create intermediate directories only if they exist — a traversal write still requires the target directory to already exist on disk — so real-world impact depends on the deployment's filesystem layout, which wasn't accessible in this audit). The unrestricted-file-type issue (#1) does not have this caveat — it's unconditionally true.
- Recommended action: allowlist file types/MIME by inspection of actual bytes (not just extension), sanitize/regenerate the extension from a fixed allowlist rather than trusting `originalname` at all, and add a `limits` config to `multer` (none is currently set — also a memory-exhaustion/DoS angle worth noting given `memoryStorage` buffers the whole file in RAM before writing).

---

## Finding 10.2 — The admin panel's `[adminKey]` URL segment is not a real access boundary: it's a client-bundled value, enforced on 2 of 165 admin pages

**Location:** `noyanai-front/next.config.mjs` (exposes `ADMIN_KEY` via `env`), `Components/helpers/adminPath.tsx`, `Components/Admin/UI/CheckAdminKey.tsx`, `app/[adminKey]/**`.

The admin section is namespaced under a dynamic route segment (`/[adminKey]/doctor`, `/[adminKey]/blog`, etc.) rather than a fixed `/admin/` path. The intent looks like obscuring the admin panel's location. In practice:

- `ADMIN_KEY` is declared in `next.config.mjs`'s `env` block, which means Next.js **inlines it into the client-side JavaScript bundle** — it is not a server secret, it ships to every visitor's browser and is trivially recoverable by reading the bundle.
- Only 2 of the 165 `app/[adminKey]/**/page.tsx` files actually import and render `CheckAdminKey` (which compares the URL segment against the bundled `ADMIN_KEY` and calls `notFound()` on mismatch): the index page and the blog page. The other 163 admin pages (doctor, user, clinic, pharmacy, finance settings, access levels, etc.) render unconditionally regardless of what string occupies the `[adminKey]` URL segment.
- The current `.env.local` value found in this repo is the literal placeholder `ADMIN_KEY=notadmin`.

**What this does and doesn't mean:** real data protection for admin *operations* appears to rest on the backend's `authController.restrictTo("admin")` (and the granular `hasPermission`/access-level system for "notadmin" staff roles) — that check is server-side, cookie/JWT-based, and looks sound from the code read in this pass (see "Checked, no issue found" below). So visiting `/anything-you-type/doctor` would render the admin page *shell* but any data-fetching call from it would still need a valid admin session cookie to return anything. The concrete risk is therefore narrower than "unauthenticated admin access": it's (a) trivial discovery of the admin UI's existence and full route structure by anyone who reads the client bundle, since the `[adminKey]` mechanism provides no obfuscation once the key is extracted, and (b) inconsistent application even on its own terms (2 of 165 pages), meaning the two protected pages give a false sense that this layer does something meaningful. Whether any of the 163 unprotected admin pages perform a client-side fetch that leaks data *before* an auth check resolves (e.g., rendering a list from a response that a misconfigured endpoint returned before role-checking) was not individually verified for all 163 — flagged as an open item below rather than asserted.

- Severity: **MEDIUM** (not a direct data-exposure bypass on the evidence gathered, but a broken/inconsistent security control that provides false assurance, plus trivial disclosure of internal admin routes/structure).
- Confidence: **HIGH** on the mechanism and inconsistent application; **MEDIUM** on downstream impact (didn't audit all 163 pages' data-fetch-before-auth-check behavior).
- Cross-reference: `.env.local`'s literal `notadmin` value is a local/dev file in the folder audited — whether the actual deployed production frontend uses a stronger value wasn't verifiable from this vantage point, but given the value is bundled into client JS regardless of strength, changing it would not fix the underlying design issue.

---

## Finding 10.3 — Generic admin CRUD layer (`autoController`) does unfiltered mass-assignment on write and passes raw query strings into Mongoose filters on read

**Location:** `noyanai-back/Controllers/autoController.ts`

```ts
export const create = ({ model }) => catchAsync(async (req, res, next) => {
  const data = await model.create(req.body);              // no field allowlist
  ...
export const edit = ({ model }) => catchAsync(async (req, res, next) => {
  await model.findByIdAndUpdate(req.params.nodeId, req.body);  // no field allowlist
  ...
export const getAll = ({ model, population, selection }) => catchAsync(async (req, res, next) => {
  const query = model.find(req.query);                     // raw query string as Mongo filter
  ...
```

`req.body` is passed straight to `model.create`/`findByIdAndUpdate` with no field allowlist, and `req.query` (parsed by Express's `qs`, which supports nested-object syntax like `?field[$ne]=` in the query string) is passed straight to `model.find()` as the filter object — a well-known NoSQL-operator-injection pattern, since callers can smuggle Mongo query operators (`$ne`, `$gt`, `$regex`, etc.) through query parameters that the endpoint author only intended as simple equality filters.

**Mitigating context, checked directly:** every route wired to these handlers (`Routers/autoRouter.ts`, `Routers/oldRouter.ts`) applies `authController.protect` plus `authController.restrictTo("admin")` or `restrictTo("admin", "notadmin")`, with the "notadmin" (limited-staff) path additionally gated per-model per-operation by `authController.hasPermission`. So exploitation requires an already-authenticated admin or granted-access staff account — this is not reachable by an anonymous or ordinary patient/doctor user. That materially lowers severity versus an unauthenticated-reachable version of the same pattern, but it is still a real privilege-boundary weakness: a staff account with narrow, intentionally-limited access to one model (e.g. read-only on `Blog`) inherits the same unfiltered `req.query`-as-filter and (where they have update rights) unfiltered `req.body`-as-update behavior, with no defense-in-depth against a staff account doing more than its access level should literally allow via crafted field names or query operators.

- Severity: **MEDIUM** (privileged-account-only, but a real defense-in-depth gap across ~90 admin-managed entity types).
- Confidence: **HIGH**.

---

## Finding 10.4 — Destructive, single-call, no-confirmation admin endpoints

Cross-referenced from `03_LEGACY_AND_DUPLICATION.md` Finding 3.4. `Routers/migrationRouter.ts` exposes, per entity type (doctor/blog/disease/drug/part/speciality/symptom), a `DELETE` verb (`dropAllX`) that deletes **every** document of that model — not just migrated ones — in a single request, admin-role-gated only, no secondary confirmation, no soft-delete/undo. Also in the same file: `PUT` ("drop") removes every doc that came from the old-system import, and none of the four verbs (import/drop/purge/dropAll) log who triggered them or when (no audit trail model referenced in `migrationController.ts`).

- Severity: **MEDIUM** (admin-only, but a single mistaken/curious request from a valid admin session — or a compromised admin session — permanently deletes an entire production collection with no recovery path visible in code).
- Confidence: **HIGH**.

---

## Finding 10.5 — Dev-only settlement bypass secret, cross-referenced

Cross-referenced from `07_BUSINESS_LOGIC_DRIFT.md`. `Controllers/checkoutController.ts:settleInvoice` requires a hardcoded literal string (`req.body.secret !== "HAJI"`) and is fully disabled when `NODE_ENV === "production"`. As a security matter (rather than the business-logic-drift angle already covered): a literal, guessable, unrotatable string checked in application code is a bad pattern in general, even though its blast radius here is limited by the surrounding `NODE_ENV` gate — *if* that gate is honored by the actual deployment. Recommend confirming the deployed `NODE_ENV` value as a first step (also recommended in Finding 7.1's addendum, for the availability-drift angle).

- Severity: LOW as a distinct security item (given the production gate), but see 07's CRITICAL framing for the business-impact angle of the same code.

---

## Checked, no issue found

- **Authentication core** (`authController.ts`): JWT signed server-side with `env.JWT_SECRET`, `httpOnly` cookies, `secure` flag correctly conditioned on `NODE_ENV === "production"`, OTP flow has rate-limiting via `Token.canSendAgain()`/`canSendAgainAt()` and a max-tries concept (`OTP_MAX_TRYS` env var), session invalidation on password/security-relevant changes via the `UserSecurity.lastLogin` vs. JWT `iat` comparison (so a stale token from before a security event is rejected). No obvious bypass found in `protect`/`restrictTo`/`hasPermission`.
- **Password/OTP verification**: uses `bcryptjs`-backed comparison via `token.isCorrectCode()` (implementation not fully re-read this pass, but the call pattern is consistent with hashed comparison, not plaintext).
- **National-ID/identity verification (`signup`)**: calls out to Podium with server-held API keys (`getAppConfig()`), not client-suppliable — no obvious way for a client to spoof identity verification results by supplying its own values.

## Not yet investigated / open items

- No `cors` or `helmet` (or equivalent) package present in `noyanai-back/package.json`, and no CORS headers or security-header middleware visible in `app.ts`. Whether this matters depends on deployment topology (same-origin reverse proxy vs. cross-origin frontend/backend) which wasn't visible from source — flagged as open rather than asserted as a vulnerability, since Express's default (no CORS headers) is restrictive, not permissive.
- The unexplained global 1ms delay middleware in `app.ts` (`01_PROJECT_MAP.md` §5.6) — git history traces only to the single bulk "moving shit to wsl" commit, no purpose recoverable from history. Not classified as a security issue, but re-flagged here since an undocumented global middleware touching every request is worth a direct question to the project owner rather than continued guessing.
- A commented-out `// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";` line exists in `server.ts`. Currently inert (commented out), so no live risk — but if ever uncommented it would disable TLS certificate validation for all outbound HTTPS calls from the backend (Podium, Tamin, Snapp). Noting its presence as a landmine, not a live finding.
- Did not verify all 163 unprotected `[adminKey]` admin pages individually for data-fetch-before-auth-check behavior (Finding 10.2).
- Rate limiting at the HTTP/network layer (as opposed to the OTP-specific application-layer throttling, which does exist) was not found or investigated further — no `express-rate-limit` or equivalent in `package.json`.
