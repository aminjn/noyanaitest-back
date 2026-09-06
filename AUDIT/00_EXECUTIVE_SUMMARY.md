# 00 — Executive Summary

Audit scope: `noyanai-front` (Next.js 14 client) + `noyanai-back` (Express/Mongoose server), two repos forming one product — NoyanAI, a multi-sided healthcare marketplace (patients, doctors, clinics, pharmacies, para-clinics, insurance) with telemedicine (mediasoup WebRTC, SIP), an AI chat assistant (Ollama), and Tamin (Iranian social-insurance) integration.

**All 12 planned audit phases were run.** Depth reached: Phase 1 (project map), Phase 2 (dependency inventory), Phase 3 (legacy/duplication), Phase 4 (hardcoding/placeholder sweep), Phase 5 (contract drift), Phase 6 (database/schema drift), Phase 7 (business-logic drift), Phase 8 (dead code), Phase 9 (failure paths), Phase 10 (security), Phase 11 (git archaeology), Phase 12 (cross-system workflows). None of the twelve was exhaustive in the sense of "every file individually reviewed" — each followed evidence and specific leads across an ~1,800-file, two-repo codebase rather than attempting brute-force full coverage, and each phase document's own "not yet investigated" section says exactly what was left unchecked within its scope. Treat the absence of a finding in any specific area as "not yet found," not as a clean bill of health for that area.

**Total findings this pass: 28** (2 CRITICAL, 3 HIGH, 12 MEDIUM, 10 LOW, 1 trivial). Phase 11 (git archaeology) added no new independent findings — it dated and corroborated F-01, F-04, and F-15 with commit evidence. Phase 4 (hardcoding/placeholders) directly corroborated F-01, F-04, F-19, and F-23 with first-party TODO comments — the original author flagged several of this audit's findings themselves, in code comments, before this audit ran. Phase 2 (dependency inventory) found one confirmed circular source dependency. Phase 12 (a second full workflow trace, order fulfillment) found the codebase can do multi-org consistency well when built in one deliberate pass — a useful positive contrast to the booking split — alongside two real completeness gaps in the same workflow. See `02_DEPENDENCY_ANALYSIS.md`, `11_GIT_ARCHAEOLOGY.md`, `04_HARDCODING_AND_PLACEHOLDERS.md`, `12_CRITICAL_WORKFLOWS.md`, and the addenda under earlier findings below.

Every finding below cites the exact file(s)/function(s) it's based on; the full evidence and reasoning live in the phase documents (`03`, `07`, `08`, `09`, `10`) — this document is the ranked synthesis, not a replacement for them.

---

## Most dangerous architectural conflict

**Two independently-built doctor-booking systems are simultaneously live**, reachable from at least three separate frontend surfaces, writing to disjoint data models, with conflict-detection logic that cannot see each other — and the older system's payment-completion step is gated off in production entirely. See F-01 below; this single thread (traced across Phases 1, 7, and 8) is the strongest, most load-bearing finding in the audit.

## Most likely legacy systems

The `Models/Old/*` + `oldRouter` + `migrationController` trio (F-08) is a deliberate, well-isolated legacy/migration tool — not a risk in itself, but its destructive `dropAllX` verbs are (F-11). The first-generation call system in `noyanai-back/socket/` (F-13) is confirmed fully dead by the project's own documentation. The "old" booking flow (`Booking`/`Invoice`/`DoctorSession`) is legacy in spirit but, unlike the other two, is still load-bearing on live pages — it is the subject of F-01, not a simple cleanup candidate.

## Highest-risk workflow

**Doctor session booking, start to finish** — public search/profile pages → booking submission → availability calculation → doctor's own schedule view. Traced end-to-end in Phase 7/8; every layer of this workflow has at least one open question or confirmed defect (see F-01).

## Biggest sources of duplicated business logic

Booking/reservation (F-01) and prescriptions (F-02) — both are real, tracked v1→v2 migrations, one essentially finished at the data layer with one leftover bug, the other still splitting traffic across two live systems with no equivalent TODO.md acknowledgment.

## Biggest sources of drift

Money-movement sequencing (wallet debit before the record it pays for exists, F-03) recurs in at least two unrelated controllers — the clearest sign this is a systemic pattern rather than a one-off mistake.

---

## CRITICAL

### F-01 — Two live, parallel doctor-booking systems; the older one's payment-completion step is disabled in production
- **Severity:** CRITICAL
- **Category:** Business logic drift / architectural conflict
- **Location:** `noyanai-back/Controllers/bookingController.ts` (`submitABooking`, `submitBookingNew`), `Controllers/checkoutController.ts` (`settleInvoice`), `Controllers/doctorController.ts` (`createSession`, `getMySchedule`), `Lib/updateDoctorAvailablity.ts`; frontend: `Components/Doctor/DoctorsListPage.tsx` → `Booking/DoctorCardWithSessions.tsx` → `Booking/SelectSessionToReservePopup.tsx`; `Components/Dr/PublicDoctorProfilePage.tsx` → `PublicDrIntro.tsx` → `PublicDrSessions.tsx`; `app/book/page/[page]/page.tsx` → `Booking/BookingPage.tsx`; vs. `app/book/page.tsx` → `Booking/BookingPage2.tsx` → `Booking/BookingSessionSelectorPopup.tsx` → `app/book/finalize/[nodeId]`.
- **Evidence:** Two backend endpoints (`POST /booking/book` and `POST /booking/reserve`) mounted and both reachable from currently-linked frontend pages (traced import chains, not inferred). System A's conflict check (`!!session.booking`) and System B's (`Reservation.exists(...)`) query disjoint collections; the canonical `DoctorAvailability` calculator (`updateDoctorAvailablity.ts`) reads only `DoctorShift`/`Reservation`, never `DoctorSession`/`Booking`. `Booking.create` is called from exactly one place (`settleInvoice`), which is gated by `if (NODE_ENV === "production") return next(new NotFoundError())` plus a hardcoded literal secret. Doctors' own "Schedule" page (`getMySchedule`) reads only `Booking`; their "Booking" detail page reads only `Reservation`; no unified or list view of `Reservation`s was found for doctors.
- **What currently happens:** A doctor can create a free-form "session" (System A) at a time that overlaps their own shift-derived availability (System B), because neither creation path checks the other. Patients can reach System A from the main `/doctors` directory, the `/dr/[slug]` profile page, and (unlinked but routable) `/book/page/[page]`. In a production deployment, System A's invoices can never be settled into a real `Booking` (the only code path is 404'd), so its own internal double-booking guard is also inert there.
- **Why it's suspicious/problematic:** This is precisely the "System A computes X, System B computes Y, they can disagree" pattern the audit brief flags as highest priority — plus a guaranteed-reproducible broken checkout on a primary public page in production, plus doctors lacking a unified view of their own appointments.
- **Affected systems:** Public booking (both surfaces), doctor availability, wallet/transaction ledger, invoice/payment, reservation lifecycle cron sweeps, doctor-panel schedule/booking views.
- **Likely root cause:** `Reservation`/`DoctorShift`-based booking is a newer, more capable rebuild (wallet integration, presence tracking, lifecycle sweeps) rolled out on the `/book` surface without retiring or redirecting the `/doctors`/`/dr` surfaces, and without unifying availability calculation or doctor-facing schedule views.
- **Confidence:** HIGH on architecture, reachability, and the production-gating mechanism (all directly read). MEDIUM on real-world double-booking incidence (no production DB access) and on the deployed `NODE_ENV` value (not independently confirmed).
- **Recommended action:** Confirm the deployed `NODE_ENV` value first. Then decide, with the project owner, whether System A (`/doctors`, `/dr`, `/book/page/[page]`) is meant to still be a live purchase path; if so it needs a real payment-settlement implementation and to be taught about System B's reservations (or vice versa). If not, retire its public entry points and merge `getMySchedule` to include `Reservation`s so doctors aren't missing appointments today.
- **Dependencies / migration considerations:** Any fix touches wallet/transaction accounting, the reservation lifecycle cron sweeps, and three separate frontend surfaces — not a small patch.
- **Git-archaeology addendum (Phase 11):** `Reservation`, `submitBookingNew`, and the new frontend popup all trace to the exact same commit date, 2026-07-11 — a single coordinated rollout, about 8 weeks before this audit. Since that date, `submitABooking` (the old flow) has received **zero** further edits in 3 subsequent commits that otherwise touched the same file — it's frozen, not actively maintained, while still being live and linked-to from three surfaces. See `11_GIT_ARCHAEOLOGY.md` §11.1.
- **Hardcoding-sweep addendum (Phase 4):** the new flow's own finalize page carries `//TODO: add logic if session is booked` — the frontend doesn't yet specifically handle the backend's conflict rejection on its canonical confirmation step. The backend still enforces the rule (this is a UX gap, not a data-integrity one), but it's confirmation the seam is felt on both sides of the split. See `04_HARDCODING_AND_PLACEHOLDERS.md` Finding 4.4.

### F-02 — Unrestricted file upload with path-traversal-capable filename handling, reachable by any authenticated user
- **Severity:** CRITICAL
- **Category:** Security
- **Location:** `noyanai-back/Controllers/uploadController.ts` (`upload`, `saveUplaodsToBody`)
- **Evidence:** `multer({ fileFilter: (req, file, cb) => cb(null, true) })` with an adjacent `//TODO: add filter` comment; the saved filename's extension is taken verbatim from `req.files[i].originalname.split(".").findLast(() => true)` and concatenated into a path passed to `path.join(process.cwd(), "Public", filename)`, which normalizes `..` segments. `uploadController.upload` is wired into 22 of 27 routers, including plain end-user routes (`userRouter.ts` avatar upload, 57 mount points in `doctorRouter.ts`).
- **What currently happens:** Any authenticated user (not just admins) can upload a file of any type/content, written into the publicly-served `Public/` directory; a crafted original filename can, in principle, cause the write to land outside `Public/` entirely.
- **Why it's suspicious/problematic:** Combines unrestricted content type (stored-XSS-via-served-upload risk) with a path-traversal write primitive — the most severe class of upload vulnerability, and self-acknowledged as incomplete in the code's own TODO.
- **Affected systems:** Every feature that accepts an upload — avatars, gallery items, patient documents, prescriptions attachments, admin media.
- **Likely root cause:** Filtering was deferred (per the TODO) and never revisited; the filename-building helper was written for the happy path without considering adversarial `originalname` input.
- **Confidence:** HIGH on the missing filter and its unconditional truth. MEDIUM on the traversal write's practical exploitability without further live testing (target directory must already exist for `fs.writeFile` to succeed).
- **Recommended action:** Add MIME/content allowlisting by byte inspection (not extension trust), regenerate extensions from a fixed allowlist rather than trusting `originalname`, add `multer` size limits.
- **Dependencies / migration considerations:** Touches every upload call site (130+ route mounts) — a shared fix in `uploadController.ts` covers all of them at once, which is the good news.

---

## HIGH

### F-03 — Wallet debited before the record it pays for exists, no rollback, in two independent flows
- **Severity:** HIGH
- **Category:** Failure paths / data integrity
- **Location:** `noyanai-back/Controllers/bookingController.ts:submitBookingNew` (lines ~205-233), `Controllers/CartController.ts` checkout (lines ~247-273)
- **Evidence:** Both functions call `Wallet.findByIdAndUpdate(..., { $inc: { balance: -amount } })` before `Reservation.create`/`Order.create` and `Transaction.create`, with no Mongo transaction wrapping the sequence. `Lib/updateDoctorAvailablity.ts` independently carries a `//TODO: this whole shit needs to be in a transaction` comment, corroborating awareness of this general risk class.
- **What currently happens:** If the process crashes or a write fails between the debit and the follow-up `create()` calls, the user's balance is permanently reduced with no compensating record and nothing flags the orphaned debit.
- **Why it's suspicious/problematic:** Silent, unrecoverable loss of user funds; appears twice in unrelated code paths, suggesting a systemic gap rather than a one-off.
- **Affected systems:** Doctor-session booking, cart/product checkout, wallet ledger.
- **Likely root cause:** Debit-first was chosen as the simplest way to atomically claim funds, without a matching rollback-on-failure step.
- **Confidence:** HIGH on the code ordering; MEDIUM on real-world incidence (no DB access) and on whether the deployed Mongo topology even supports transactions (replica set vs. standalone — not confirmed).
- **Recommended action:** Wrap in a Mongo transaction if a replica set is available; otherwise create the record first (pending state) and debit second, or add a reconciliation job.
- **Dependencies / migration considerations:** None blocking — additive change to two functions.

### F-04 — Prescription item cleanup deletes from the wrong model, silently no-ops
- **Severity:** HIGH
- **Category:** Legacy/duplication bug (v1→v2 migration leftover)
- **Location:** `noyanai-back/Controllers/prescriptionController.ts:445-462` (`editTaminPrescriptionItemsCleanUp`), called from `editTaminPrescription` (line 706)
- **Evidence:** `toDelete` is typed and populated as `IPrescriptionItem[]` (v2), but the delete call is `Prescription.findByIdAndDelete(toDelete[c]._id)` — the v1 model, which is otherwise never created or read anywhere in the current codebase (confirmed via grep). `getPrescription`'s `items` populate (line 63-80) reads from `PrescriptionItem`, confirming removed items can resurface.
- **What currently happens:** When a doctor removes a drug item while editing a committed Tamin/insurance prescription, the intended deletion silently fails (near-certain no-op against the wrong collection), and the item can reappear on the next read.
- **Why it's suspicious/problematic:** Classic copy-paste/migration-leftover bug — exactly the "old system reference surviving inside new-system code" pattern this audit prioritizes.
- **Affected systems:** Doctor prescription editing, Tamin/insurance prescription submission.
- **Likely root cause:** Leftover reference from before the v1→v2 collection split; never updated when the code was restructured.
- **Confidence:** HIGH (function, call site, and downstream populate all directly read). Real-world data impact (how many prescriptions currently carry orphaned items) not verified — no DB access.
- **Recommended action:** Change the delete target to `PrescriptionItem.findByIdAndDelete`; audit existing data for orphaned `PrescriptionItem` docs.
- **Hardcoding-sweep addendum (Phase 4):** the Tamin-submission code path in the same subsystem (`doctorController.ts:submitASegmentForTamin`) sends hardcoded fake patient/doctor identity data to the Tamin sandbox, behind its own author's `//TODO: this is definitely not the way` comment — see F-24 below. Not the same bug, but the same subsystem showing the same "known-wrong, not yet fixed" pattern twice.
- **Dependencies / migration considerations:** None — isolated one-line fix, though a data cleanup pass may be warranted separately.
- **Git-archaeology addendum (Phase 11):** the migration began 2026-02-24 ("start of remaking prescription") and is ~7 months old as of this audit — longer-running than the booking-system gap (F-01), and unlike it, explicitly tracked in `TODO.md`. See `11_GIT_ARCHAEOLOGY.md` §11.2.

### F-05 — `[adminKey]` provides no real access control, and file-upload aside, is the second-clearest security gap
*(Filed as HIGH here because of the volume of admin surface area affected — 163 of 165 pages — even though the backend role check that actually protects data appears sound; see F-10 in `10_SECURITY_FINDINGS.md` for the full writeup, summarized as F-10.2 below.)*

---

## MEDIUM

### F-06 — Commission/finance-settings models are fully built and admin-editable but applied nowhere
- **Location:** `DoctorFinanceSettings`/`PharmacyFinanceSettings`/`ParaClinicFinanceSettings`/`GlobalFinanceSettings` models vs. `checkoutController.ts`/`CartController.ts`/`bookingController.ts` (zero references).
- **What happens:** Configuring a commission rate currently has no effect on any money-movement path.
- **Confidence:** HIGH (absence confirmed by search). **Recommended action:** wire into checkout/booking pricing when commission is meant to go live, or note explicitly in `TODO.md` if not yet prioritized (currently not mentioned there, unlike most other known gaps).

### F-07 — Process-level uncaught-error handlers only log, never exit
- **Location:** `noyanai-back/server.ts`, final two lines (`process.on("unhandledRejection", console.error)`, `process.on("uncaughtException", console.error)`).
- **What happens:** Any truly unexpected error outside Express's own request handling leaves the process running in a possibly-corrupted state.
- **Confidence:** HIGH on the code; impact depends on real-world frequency of such errors (not measurable from source).
- **Recommended action:** Log and exit under a process manager that restarts the service (pm2/systemd/etc.), rather than continuing silently.

### F-08 — `[adminKey]` route segment is not a real access boundary
- **Location:** `noyanai-front/next.config.mjs`, `Components/Admin/UI/CheckAdminKey.tsx`, `app/[adminKey]/**` (163 of 165 pages don't use the check; the value is bundled into client JS regardless).
- **What happens:** Trivial disclosure of the admin panel's existence and route structure; the two "protected" pages give false assurance since the mechanism is broken on its own terms.
- **Confidence:** HIGH on mechanism; MEDIUM on downstream data-exposure impact (not all 163 pages individually re-verified).
- **Recommended action:** Either remove the mechanism (rely solely on the backend role check, which is sound) or, if kept for UX/obscurity reasons, apply it consistently via a shared layout and stop treating it as a security control in documentation/mental model.

### F-09 — Generic admin CRUD (`autoController`) does unfiltered mass-assignment and passes raw query strings into Mongo filters
- **Location:** `noyanai-back/Controllers/autoController.ts` (`create`, `edit`, `getAll`).
- **What happens:** `req.body` → `model.create`/`findByIdAndUpdate` and `req.query` → `model.find()` with no allowlisting, reachable by any admin or granted-access "notadmin" staff account.
- **Confidence:** HIGH. **Recommended action:** field allowlisting per model; sanitize/validate query filters instead of passing `req.query` through directly.

### F-10 — Destructive, single-call, no-confirmation `dropAllX` migration endpoints
- **Location:** `noyanai-back/Routers/migrationRouter.ts` / `Controllers/migrationController.ts`.
- **What happens:** A single authenticated-admin `DELETE` request wipes an entire production collection (not just migrated docs), no audit trail, no undo.
- **Confidence:** HIGH. **Recommended action:** require explicit confirmation (e.g. a body flag matching the collection name), log who/when, consider soft-delete.

### F-11 — `prescriptionRouter.ts` orphaned stub mounted at `/api/v1/presc`
- **Location:** `noyanai-back/Routers/prescriptionRouter.ts`.
- **What happens:** Dead route mount with a stray debug `console.log("hit")`; misleading to future readers since the real prescription API lives under `doctorRouter.ts`.
- **Confidence:** HIGH. **Recommended action:** remove the dead mount, or finish wiring it if it was meant to be the canonical location.

### F-22 — The project's own content-key contract-drift detector has an active, still-growing, currently-firing backlog
- **Location:** `publicController.ts`'s diagnostics endpoint, `Components/Hooks/useScopedLocale.tsx`, log file `missing-content-keys.txt`.
- **What happens:** A self-built dev-only tool (explicitly commented "just something to skim and go fix") has logged 5,312 entries since 2026-08-18, the most recent from hours before this audit ran. 97% are namespace-scope mismatches that don't currently break anything (a migration safety net covers them); the remaining 160 are genuine missing content values, at least 8 of them on the home page hero section, unresolved since the home-page redesign over two weeks earlier.
- **Confidence:** HIGH. **Recommended action:** fill the missing home-hero values; find and fix the shared component requesting `blog`/`frequentlyAskedQuestions` under the wrong namespace scope; periodically clear/review the log.

### F-23 — Pagination implemented three different ways; two user-facing lists (invoices, bookings) have none at all
- **Location:** `publicController.ts` (consistent fixed-page-size pattern) vs. `callController.ts` (client-controlled, unbounded limit) vs. `autoController.getAll` and `userController.ts`'s invoice/booking lists (no pagination at all).
- **What happens:** Matches two literal open `TODO.md` items ("Add invoice pagination," "Add booking pagination") pinned to exact code locations — a user with a long history gets their entire invoice/booking list in one unbounded response. Phase 4 found the author's own `//TODO: maybe add pagination shit` / `//TODO: may be add pagination maybe not` sitting directly above both handlers.
- **Confidence:** HIGH. **Recommended action:** apply the existing `publicController.ts` skip/limit pattern to the two flagged endpoints rather than inventing a new shape.

### F-19 — `DoctorSession` and `Reservation` use two different, non-equivalent calendar-day representations
- **Location:** `Models/DoctorSession.ts` (`date: String`, via `getSessionDateKey` — UTC-based `toISOString()` split) vs. `Models/Reservation.ts` (`date: Date`, via `dateStartOfDay` — local-timezone midnight).
- **What happens:** A booking made late in the evening could be filed under different calendar dates by the two systems depending on server timezone vs. Iran Standard Time (UTC+3:30). A plausible, not confirmed, root cause for `TODO.md`'s "Fix timezone shift bug" item.
- **Confidence:** upgraded to HIGH after Phase 4 — `Lib/helpers.ts:59` carries the author's own `//TODO: this will shift dates across timezones` directly above `getSessionDateKey`, confirming the mismatch was known, not just plausible (server's actual timezone still not independently confirmed). **Recommended action:** standardize on one representation.

### F-20 — Index coverage doesn't match query patterns on the two most-queried booking models
- **Location:** `Models/DoctorSession.ts` (zero indexes despite `{doctor,date,start,end}` overlap-check queries), `Models/Reservation.ts` (one index, `{status,date,start}`, missing `doctor` despite that being the leading filter in its own conflict-check query).
- **What happens:** Not a correctness bug today; becomes a scaling problem as collections grow.
- **Confidence:** MEDIUM (absence confirmed directly; query-planner behavior not verified against a live database). **Recommended action:** add `{doctor,date,start}`-shaped indexes to both.

### F-26 — Confirmed circular source dependency between a data model and a controller
- **Location:** `Models/Secretary.ts` imports a type from `Controllers/aclController.ts`; `Controllers/aclController.ts` imports the `Secretary` model (a runtime value) back from `Models/Secretary.ts`.
- **What happens:** A real layering inversion at the source level. Whether it produces an actual runtime circular module load depends on TypeScript's type-only import elision, which wasn't confirmed by running a build.
- **Confidence:** HIGH on the source-level cycle; LOW-MEDIUM on runtime impact. **Recommended action:** move the shared type into `Lib/enums.ts` or similar so neither file needs the other.

### F-27 — No seller payout exists anywhere in the order/cart fulfillment workflow
- **Location:** `CartController.ts` checkout, all three `mutateIncomingOrderItem` implementations (pharmacy/doctor/paraClinic).
- **What happens:** The buyer's wallet is debited at checkout; no code path anywhere credits the seller when an order item is fulfilled. Contrasts directly with the booking workflow's `handleReservationSuccess`, which does credit the doctor with a verified idempotency guard.
- **Confidence:** HIGH on the absence; the gap is consistent with F-06 (commission settings never applied) viewed from the seller side rather than the buyer side. **Recommended action:** build seller payout alongside whatever work wires up F-06.

### F-24 — Hardcoded fake identity data sent to the Tamin insurance sandbox API
- **Location:** `doctorController.ts:submitASegmentForTamin` (~line 2805-2825), targeting `ep-test.tamin.ir`.
- **What happens:** Every Tamin prescription submission during the sandbox period sends fabricated patient/doctor national-ID and mobile-number values instead of real ones, behind the author's own `//TODO: this is definitely not the way` comment.
- **Confidence:** HIGH — self-flagged in both the code and `TODO.md`'s "Tamin sandbox ≠ real API... gets rewritten once real access lands" framing. **Recommended action:** already the project's own stated plan — ensure this is genuinely rewritten, not just parameterized, before any real-Tamin cutover.

### F-12 — Insurance org type has no license/module gating, unlike the other four org types
- **Location:** absence of `BaseInsuranceLicense`/`InsuranceLicenseGate` vs. present equivalents for Doctor/Pharmacy/Clinic/ParaClinic.
- **What happens:** Nothing broken — insurance is the least-built-out panel per `TODO.md`, so this reads as sequencing, not a regression.
- **Confidence:** MEDIUM (absence confirmed; "why" is inferred from TODO.md, not stated directly). **Recommended action:** apply the existing `noyan-org-licensing` pattern when insurance features are defined.

---

## LOW

- **F-13 — First-generation call system (`noyanai-back/socket/`) confirmed fully dead**, self-documented as such in `CALL_SERVICE.md`. Safe removal candidate. Confidence: HIGH.
- **F-14 — `/book/page/[page]` old paginated booking route: unlinked, still routable**, renders the same old-flow component as F-01. Self-flagged as "may be dead" in the project's own `contentNamespaces.tsx` comment. Confidence: HIGH.
- **F-15 — `Components/DoctorPanel/_Stub/*`**: literal placeholder pages (one confirmed to be `return <p>DoctorManageChat</p>`) live on 6 production doctor-panel routes, matching open `TODO.md` items exactly. Confidence: HIGH.
- **F-16 — `_to_delete/` and `_to_delete_tsconfig.scoped.json`** (frontend root): self-named for removal, not referenced by build scripts. Confidence: MEDIUM.
- **F-17 — Reminder sweep doesn't persist failure state** (`runReservationReminderSweep`), unlike its sibling activation/finalization sweeps which do (`dispatchError`). Low impact — reminders are non-critical and retried automatically. Confidence: HIGH.
- **F-18 — Hardcoded dev-bypass secret `"HAJI"`** in `checkoutController.ts:settleInvoice`, gated off in production (see F-01 for the business-impact framing of the same code). Confidence: HIGH.
- **F-28 — No notification fires when a seller changes an order item's status.** A buyer only learns their order status changed by revisiting the order page themselves; the `Notification` model's push-notification hooks aren't triggered anywhere in the fulfillment path. Confidence: MEDIUM (confirmed absent in the fulfillment functions and the `Order` model; not exhaustively checked for a sweep/cron elsewhere).
- **F-25 — Five admin-only "Temperory" (sic) debug/test endpoints left live**, wired into `adminRouter.ts` and gated by `restrictTo("admin")` (not a security exposure, just dead weight): `debug`, `testSip` (very plausibly the code behind `TODO.md`'s "Resolve telephony test endpoints"), `callUser`, `fillUserIdentity`, `pod`. Confidence: HIGH.
- **F-21 — `CallRoom.source` enum wasn't extended for `Reservation`-based rooms**; `"booking"` is now used generically for both `Booking`- and `Reservation`-linked call rooms, even though the model's own code comment explicitly calls `Reservation` "the new" model. A small, precise instance of the pattern this audit looks for, and further first-party corroboration that the dual booking systems in F-01 are a known, live seam. Confidence: HIGH.

## Trivial

- `Controllers/deleteme/` — empty directory, self-named for removal.

---

## Checked and found clean (recorded per audit rule 6 — don't only report problems)

- Auth core (`authController.ts`): JWT/cookie handling, OTP throttling, stale-session invalidation via `UserSecurity.lastLogin` vs. token `iat` — no bypass found.
- Centralized error handling (`errorController.ts`): no path converts an error into a false-success response; Mongoose/JWT error classes normalized consistently.
- `Lib/catchAsync.ts`: consistently applied across every controller read; no unhandled-rejection leaks found in Express routes.
- `handleReservationSuccess` (doctor payout on session completion): explicitly designed and guarded to be idempotent against sweep retries — a genuine positive contrast to F-03.
- Org-type ACL (`aclController.ts`): single shared implementation across all 5 org types, not reimplemented per org — no drift found.
- Reservation activation sweep's `dispatchError` persistence: failures are inspectable, not silently swallowed (contrast with F-17's reminder sweep).
- `User.role`: a single field, no competing `roles`/`userType`/`permissions` representation found — the audit brief's own worked example for this category of drift doesn't apply here.
- The `old: <ObjectId>` migration cross-reference field: consistently named and typed across all seven models that carry it, despite being defined in seven separate schema files.
- `reservationStatuses`/`reservationParties`: hand-mirrored between front and back with an explicit "mirrors backend" comment, values confirmed identical — the one hand-mirrored contract checked this pass held up, though the lack of a shared types package makes this a standing structural risk worth a broader sweep later.
- **Order-item fulfillment across pharmacy/doctor/paraClinic** (`12_CRITICAL_WORKFLOWS.md` Finding 12.1): all three sellers' `mutateIncomingOrderItem` implementations share the same function name, schema, ownership-scoping pattern, and update logic, each correctly adapted to its own item-model count rather than blindly copy-pasted. A genuine positive example of consistent multi-org business logic, and a useful contrast with the booking split (F-01) — this codebase can do it well when the three implementations are built together in one pass.

---

## Where deeper coverage would most likely find more

All 12 phases ran, but each was evidence-driven rather than brute-force-exhaustive on a codebase this size (~1,800 source files across two repos). The likeliest places a further pass would surface more: (1) a tool-verified circular-dependency graph — this audit's sandbox had no npm registry access, so `02_DEPENDENCY_ANALYSIS.md`'s circular-dependency check was manual and targeted, not a full graph traversal; (2) the ~170 backend models not already implicated by `03`/`07`/`08`'s findings, for schema drift; (3) the call/video and Tamin-submission workflows end-to-end, flagged as open in `12_CRITICAL_WORKFLOWS.md`; (4) a blanket magic-number/hardcoded-value sweep beyond the comment-marker-driven pass in `04_HARDCODING_AND_PLACEHOLDERS.md`; (5) every individual TODO in the largest files (`doctorController.ts` at 3,505 lines, `publicController.ts` at 3,632) — only a sample was triaged.
