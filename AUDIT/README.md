# NoyanAI — Architecture & Technical-Debt Audit

Audit performed 2026-09-03 across `noyanai-front` and `noyanai-back`. Read-only forensic audit — no source code was modified. All 12 planned phases were run. Start with `00_EXECUTIVE_SUMMARY.md` for the ranked findings; this file is the index and consolidated table.

## Documents

| Doc | Phase | Covers |
|---|---|---|
| [00_EXECUTIVE_SUMMARY.md](00_EXECUTIVE_SUMMARY.md) | Synthesis | Ranked findings (CRITICAL→LOW), what's clean, where deeper coverage would find more |
| [01_PROJECT_MAP.md](01_PROJECT_MAP.md) | 1 | Repo structure, tech stack, entry points, config, data stores, 8 flagged architectural seams |
| [02_DEPENDENCY_ANALYSIS.md](02_DEPENDENCY_ANALYSIS.md) | 2 | Largest modules, one confirmed circular Model↔Controller dependency, backwards type-import patterns |
| [03_LEGACY_AND_DUPLICATION.md](03_LEGACY_AND_DUPLICATION.md) | 3 | Old/new system pairs: call service, prescription router, prescription v1/v2, `Models/Old`, insurance licensing gap |
| [04_HARDCODING_AND_PLACEHOLDERS.md](04_HARDCODING_AND_PLACEHOLDERS.md) | 4 | Hardcoded fake Tamin identity data, 5 leftover admin debug endpoints, first-party TODOs corroborating F-01/F-04/F-19/F-23 |
| [05_CONTRACT_DRIFT.md](05_CONTRACT_DRIFT.md) | 5 | Live content-key/namespace contract-drift log (self-built by the project, actively firing), pagination inconsistency across 4 shapes |
| [06_DATABASE_DRIFT.md](06_DATABASE_DRIFT.md) | 6 | `DoctorSession`/`Reservation` date-representation mismatch, index coverage, `CallRoom.source` enum drift |
| [07_BUSINESS_LOGIC_DRIFT.md](07_BUSINESS_LOGIC_DRIFT.md) | 7 | The dual booking-system finding (this audit's centerpiece), commission settings, ACL consistency |
| [08_DEAD_CODE.md](08_DEAD_CODE.md) | 8 | Dead/orphaned code catalog: `socket/`, stub pages, `_to_delete`, old booking route, ARI/SIP |
| [09_FAILURE_PATHS.md](09_FAILURE_PATHS.md) | 9 | Wallet-debit-before-create bug, error-handling review, sweep idempotency |
| [10_SECURITY_FINDINGS.md](10_SECURITY_FINDINGS.md) | 10 | File upload vulnerability, admin-key boundary, mass-assignment, auth core review |
| [11_GIT_ARCHAEOLOGY.md](11_GIT_ARCHAEOLOGY.md) | 11 | Dates the booking-system split (single coordinated rollout, 2026-07-11) and confirms the old flow has had zero fixes since; dates the prescription migration (~7 months running) |
| [12_CRITICAL_WORKFLOWS.md](12_CRITICAL_WORKFLOWS.md) | 12 | Order-fulfillment workflow traced end-to-end: consistent 3-org implementation (positive), no seller payout, no order-status notifications |

## Findings count

28 findings + 1 trivial. **2 CRITICAL, 3 HIGH, 12 MEDIUM, 10 LOW, 1 trivial.**

## Consolidated findings table

| ID | Severity | Category | Problem | Location | Confidence | Recommended Action |
|---|---|---|---|---|---|---|
| F-01 | CRITICAL | Business logic drift | Two live parallel booking systems can't see each other; old system's payment step is dead in production | `bookingController.ts`, `checkoutController.ts`, `doctorController.ts`, `updateDoctorAvailablity.ts` + 3 frontend surfaces | HIGH (arch), MEDIUM (real-world incidence) | Confirm deployed `NODE_ENV`; decide fate of old flow with owner; unify availability + doctor schedule view |
| F-02 | CRITICAL | Security | Unrestricted file upload + path-traversal-capable filename handling | `Controllers/uploadController.ts` | HIGH | Allowlist content by byte inspection; sanitize extension; add size limits |
| F-03 | HIGH | Failure paths | Wallet debited before paying record exists, no rollback, in 2 flows | `bookingController.ts:submitBookingNew`, `CartController.ts` checkout | HIGH (code), MEDIUM (incidence) | Wrap in Mongo transaction or reorder + add reconciliation |
| F-04 | HIGH | Legacy/duplication bug | Prescription item cleanup deletes from wrong model, silent no-op | `prescriptionController.ts:445-462` | HIGH | Fix to `PrescriptionItem.findByIdAndDelete`; audit for orphaned data |
| F-05 | HIGH | Security | `[adminKey]` gives false assurance across 163 of 165 admin pages | `next.config.mjs`, `CheckAdminKey.tsx`, `app/[adminKey]/**` | HIGH (mechanism), MEDIUM (impact) | Remove or apply consistently; don't rely on it as real access control |
| F-06 | MEDIUM | Business logic gap | Commission/finance settings built but applied nowhere | Finance settings models vs. checkout/booking/cart controllers | HIGH | Wire in when commission is meant to go live |
| F-07 | MEDIUM | Failure paths | Uncaught-error handlers only log, never exit | `server.ts` | HIGH | Log-and-exit under a process manager |
| F-08 | MEDIUM | Security | (Same as F-05, filed once under security phase) | — | HIGH | — |
| F-09 | MEDIUM | Security | Generic admin CRUD: mass-assignment + raw-query Mongo filter | `autoController.ts` | HIGH | Field allowlisting; sanitize query filters |
| F-10 | MEDIUM | Security | Destructive `dropAllX` migrate endpoints, no confirmation | `migrationRouter.ts`/`migrationController.ts` | HIGH | Require explicit confirmation; add audit log |
| F-11 | MEDIUM | Dead code | `prescriptionRouter.ts` orphaned stub at `/api/v1/presc` | `Routers/prescriptionRouter.ts` | HIGH | Remove dead mount |
| F-12 | MEDIUM | Consistency | Insurance org type lacks license/module gating others have | Model/component absence | MEDIUM | Apply existing pattern when insurance features are defined |
| F-19 | MEDIUM | Database drift | `DoctorSession`/`Reservation` use non-equivalent date representations (UTC string vs. local Date) | `Models/DoctorSession.ts`, `Lib/dateUtils.ts` | MEDIUM | Standardize on one representation; plausible cause of TODO's "timezone shift bug" |
| F-20 | MEDIUM | Database drift | Index coverage doesn't match query patterns on the two booking models | `Models/DoctorSession.ts`, `Models/Reservation.ts` | MEDIUM | Add `{doctor,date,start}`-shaped indexes |
| F-22 | MEDIUM | Contract drift | Self-built content-key drift detector has an active, still-firing backlog (5,312 log lines since Aug 18, most recent hours before this audit) | `publicController.ts` diagnostics endpoint, `missing-content-keys.txt` | HIGH | Fill missing home-hero values; fix mis-scoped shared component; review log periodically |
| F-23 | MEDIUM | Contract drift | Pagination implemented 4 different ways; invoice/booking lists fully unbounded | `userController.ts`, `autoController.ts`, `callController.ts`, `publicController.ts` | HIGH | Apply existing `publicController.ts` pattern to the two TODO.md-flagged endpoints |
| F-24 | MEDIUM | Hardcoding | Hardcoded fake identity data sent to Tamin insurance sandbox API | `doctorController.ts:submitASegmentForTamin` | HIGH | Rewrite before any real-Tamin cutover (already project's own stated plan) |
| F-26 | MEDIUM | Dependency inventory | Confirmed circular source dependency: `Models/Secretary.ts` ↔ `Controllers/aclController.ts` | `Models/Secretary.ts`, `Controllers/aclController.ts` | HIGH (source), LOW-MEDIUM (runtime) | Move shared type into `Lib/enums.ts` |
| F-27 | MEDIUM | Cross-system workflow | No seller payout exists anywhere in order/cart fulfillment | `CartController.ts`, 3x `mutateIncomingOrderItem` | HIGH | Build alongside F-06's commission wiring |
| F-13 | LOW | Dead code | First-gen call system (`socket/`) confirmed fully dead | `noyanai-back/socket/` | HIGH | Safe removal candidate |
| F-14 | LOW | Dead code | Old paginated booking route unlinked but still routable | `app/book/page/[page]/page.tsx` | HIGH | Reinforces F-01; remove or redirect |
| F-15 | LOW | Placeholder | `_Stub` doctor-panel pages are literal placeholders, live in prod | `Components/DoctorPanel/_Stub/*` | HIGH | Tracked in TODO.md already — build out |
| F-16 | LOW | Dead code | `_to_delete/` scratch files at frontend root | `noyanai-front/_to_delete/` | MEDIUM | Safe to remove per its own name |
| F-17 | LOW | Failure paths | Reminder sweep doesn't persist failure state (siblings do) | `reservationActivationService.ts` | HIGH | Add `dispatchError`-equivalent for symmetry |
| F-18 | LOW | Security | Hardcoded dev-bypass secret `"HAJI"` | `checkoutController.ts:settleInvoice` | HIGH | Remove once real payment settlement exists |
| F-21 | LOW | Database drift | `CallRoom.source` enum not extended for `Reservation`-based rooms | `Models/CallRoom.ts` | HIGH | Extend enum, or document `"booking"` as generic |
| F-25 | LOW | Hardcoding | Five leftover admin "Temperory" debug/test endpoints, live but harmless | `adminController.ts` (`debug`, `testSip`, `callUser`, `fillUserIdentity`, `pod`) | HIGH | Remove once telephony testing is resolved |
| F-28 | LOW | Cross-system workflow | No notification fires when a seller changes an order item's status | `mutateIncomingOrderItem` (x3), `Models/Order.ts` | MEDIUM | Wire into existing `Notification`/push system |
| — | trivial | Dead code | Empty `Controllers/deleteme/` directory | `noyanai-back/Controllers/deleteme/` | HIGH | Remove |

## Most dangerous architectural conflicts

1. F-01 — dual booking systems (see Executive Summary for full trace).
2. F-02 — file upload path traversal, exposed to every authenticated user via 130+ route mounts.

## Most likely legacy systems

`Models/Old/*` + `oldRouter` + `migrationController` (intentional, isolated — not a risk beyond F-10's destructive verbs); `noyanai-back/socket/` (confirmed dead); the old booking flow (`Booking`/`Invoice`/`DoctorSession`) — legacy in spirit but still load-bearing, which is exactly what makes F-01 dangerous rather than merely untidy.

## Highest-risk workflow

Doctor session booking end-to-end — see F-01.

## Biggest sources of duplicated business logic

Booking/reservation (F-01) and prescriptions (F-04) — both real v1→v2 migrations at different stages of completion.

## Biggest sources of schema/API drift

The `Booking`/`DoctorSession` vs. `Reservation` conflict goes deeper than business logic: the two systems use incompatible date representations (F-19), mismatched index shapes (F-20), and even the shared `CallRoom` model shows the seam (F-21, `source` enum never extended for the new model). Separately, the project's own self-built content-key contract-drift detector (F-22) has an active backlog it was specifically designed to catch — the clearest example of API/content-contract drift found this pass, and one the project already has tooling for.

## Where the codebase does multi-org consistency well

Order-item fulfillment across pharmacy/doctor/paraClinic (F-12.1 in `12_CRITICAL_WORKFLOWS.md`) — three implementations built together in one pass, correctly adapted to each org's item-model count rather than copy-pasted. Worth naming explicitly: it shows the booking split (F-01) is a consequence of timing (two rollouts ~11 months apart, per `11_GIT_ARCHAEOLOGY.md`) rather than a general inability to keep multi-org logic in sync.
