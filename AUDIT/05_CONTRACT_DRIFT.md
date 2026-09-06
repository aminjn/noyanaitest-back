# 05 — API / System Contract Audit

---

## Finding 5.1 — The project's own content-key contract-drift detector has an active, still-growing backlog, live as of today

**Location:** `noyanai-back/Controllers/publicController.ts` (compiled at `compile/Controllers/publicController.js:140-164`), `noyanai-front/Components/Hooks/useScopedLocale.tsx`, `Components/helpers/reportMissingContentKey.tsx`, log file `noyanai-back/missing-content-keys.txt` (gitignored, not committed — a genuine runtime artifact from the working environment this audit ran in).

**What it is:** since there's no shared types/contract package between the two repos (per `01_PROJECT_MAP.md`, they're fully separate deployments talking over HTTP), the project built a small self-diagnostic tool for exactly this class of drift on one specific contract — the "content key" i18n-style text system (per existing project memory: "no hardcoded strings... keep frontend+backend key lists in sync"). `useScopedLocale`'s `getContent()`, when `NODE_ENV === "development"`, checks every requested key against the calling component's declared namespace and against whether a value actually resolved, and POSTs a `{key, namespaces, reason}` report to the backend when either check fails. The backend's own comment on the receiving endpoint: *"Dev-only diagnostics for the namespaced text content system: the frontend [reports when a key] (a) isn't declared in the namespace(s) it fetched, or (b) has no value... just something to skim and go fix."*

**What the log shows:** 5,312 lines, timestamps from **2026-08-18** through **2026-09-03T09:44:27Z — a few hours before this audit session**, meaning this is a live, currently-firing diagnostic, not historical noise. Breakdown: 5,152 entries (97%) are `reason=not-in-namespace`; 160 are `reason=no-value`.

- **The `not-in-namespace` entries are not user-facing breakage.** They fire because a component's declared namespace list doesn't include a key it asks for, but the key still resolves correctly today because (per `useScopedLocale`'s own comment) "the root layout still fetches everything" as a safety net during the in-progress migration to per-namespace scoped fetching. This is a legitimate contract-drift finding in spirit (it's exactly "declared contract doesn't match actual usage"), but its practical severity is "migration bookkeeping debt," not "broken page." The most recent, highest-frequency offenders are the `blog` and `frequentlyAskedQuestions` keys, requested under a `home`-namespace scope from multiple page paths (`/` and, notably, `/dashboard/support/[nodeId]` — a page that has nothing to do with the home page), suggesting a shared component (footer or similar) with a namespace declaration that was never corrected.
- **The `no-value` entries are a genuine content gap**, independent of the namespace migration: the key is correctly scoped, but the backend `TextContent` document has no value for it at all, for anyone, root-layout safety net included. All of the `no-value` entries seen in this pass' sample are `home`-namespace keys (`homeHeroBadge`, `homeHeroLiveVisitLabel`, `homeHeroLiveVisitValue`, `homeHeroAiAccuracyValue`, `homeHeroTitleHighlight1`, `homeHeroTitleHighlight2`, `homeHeroQuickLinkPharmacy`, `homeHeroQuickLinkLab`) — all confirmed present as valid, declared keys in `Components/Enums/contentKeys.tsx`, just with no configured value. This matches prior session memory of the home-page redesign leaving "backend contentKeys sync... unverified" — this log shows that gap is still open more than two weeks later.

- Severity: LOW for the `not-in-namespace` majority (dev-only, has a working fallback); MEDIUM for the `no-value` subset (real users see blank/fallback text on the home page hero section for at least 8 confirmed keys).
- Confidence: HIGH — the mechanism, its dev-only gating, and the log's live timestamps were all directly read, not inferred.
- Recommended action: for `no-value`, add the missing home-hero content values (small, bounded list). For `not-in-namespace`, find and fix the shared component requesting `blog`/`frequentlyAskedQuestions` under the wrong namespace scope, and consider periodically clearing/reviewing this log — the tool is working as designed, but nothing appears to have "skimmed and gone to fix" it since 2026-08-18.
- Dependencies: none blocking; this is exactly the kind of self-contained cleanup the tool was built to enable.

---

## Finding 5.2 — Pagination is implemented three different ways across the API, and at least two high-traffic user-facing lists have none at all

- **Public listing endpoints** (`publicController.ts` — doctors, blogs, diseases, drugs, clinics, hospitals, para-clinics, tests, specialities, symptoms): consistent `skip((page-1) * FIXED_PAGE_SIZE).limit(FIXED_PAGE_SIZE)` pattern, one named constant per entity type (`DOCTORS_PER_PAGE`, `BLOGS_PAGE_LIMIT`, etc.) — client controls only the page number, not the size. Internally consistent.
- **`callController.ts`**: `const limit = Number(req.query.limit) || undefined` — the *client* controls the page size directly, with no upper bound found in this pass. A different contract shape than the public listings, and, unbounded, a mild resource-exhaustion angle worth a second look (not deeply investigated this pass).
- **`autoController.getAll`** (the generic admin CRUD used for ~90 entity types): no pagination at all — `model.find(req.query)` returns every matching document, unbounded (already flagged for the query-injection angle in `10_SECURITY_FINDINGS.md` Finding 10.3; this is the separate, additive "and it's also unbounded" observation).
- **`userController.ts`'s own invoice and booking lists** (`Invoice.find({ user: req.user._id })`, `Booking.find({ user: req.user._id })`, lines ~377 and ~413): also fully unbounded — no `.limit()`/`.skip()` at all. This directly matches two literal, still-open `TODO.md` items: "Add invoice pagination," "Add booking pagination" — confirmed, tracked, not a surprise finding, but now pinned to exact code locations.

- Severity: MEDIUM (not a correctness bug for any user with a small history, but a real, unbounded-response-size issue that will degrade for active users over time — a doctor or patient with hundreds of bookings/invoices gets them all in one response today).
- Confidence: HIGH.
- Recommended action: for the two `TODO.md`-flagged endpoints, apply the same `skip`/`limit` pattern already used consistently in `publicController.ts` rather than inventing a fourth shape.

---

## Checked, no issue found

- **`reservationStatuses`/`reservationParties` enums**: hand-mirrored between `noyanai-back/Models/Reservation.ts` and `noyanai-front/Components/Dashboard/Booking/reservationStatus.ts`, with the frontend file carrying an explicit comment ("Mirrors Models/Reservation.ts's reservationStatuses on noyanai-back") and both value lists confirmed identical, same order, same casing. Given there's no shared types package (per `01_PROJECT_MAP.md`), this kind of hand-mirroring is a standing structural risk across the whole codebase — but this specific, actively-changing instance (the newest model in the system, per `11_GIT_ARCHAEOLOGY.md`) checked out clean.

## Not yet investigated

- No systematic sweep was made for other hand-mirrored enums/types beyond the one checked (reservation status/party). Given the pattern is structural (no shared package), similar mirrors likely exist for `doctorSessionTypes`, `UserRole`, and others — worth a dedicated pass.
- Error-response and success-response shape consistency across routers beyond what `09_FAILURE_PATHS.md` already covered for `errorController.ts` (which is consistent) — individual endpoints' *success* response shapes (some return `{data}`, some `{data: {data}}` per patterns glimpsed in `autoController.ts` vs. custom controllers) were not compared systematically.
- Endpoints with no frontend consumers at all (beyond the ones already found dead in `08_DEAD_CODE.md`) — no full route-by-route consumer sweep was run.
