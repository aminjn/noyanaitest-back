# 07 — Business Logic Consistency

High-priority phase per audit brief. One concept (doctor session booking / availability) was traced end-to-end and produced the single strongest finding of the audit so far — two live, independently-reachable booking systems whose conflict checks cannot see each other. Two smaller concepts (commission/finance settings, org-type ACL) were checked and their results are reported for completeness, including the negative result (no drift found) for ACL, per audit rule 6 (don't report something as a problem merely because it's unusual — and don't skip reporting things that were checked and found fine).

---

## Finding 7.1 — Two live, parallel doctor-booking systems with non-unified conflict detection: a real slot can be double-sold

**Severity: CRITICAL. Confidence: HIGH on architecture and reachability; MEDIUM on whether double-booking has actually occurred in production data (no DB access in this audit — see "What wasn't checked" below).**

### The two systems

| | System A ("old") | System B ("new") |
|---|---|---|
| Entry point (public) | `/doctors` directory → `Components/Doctor/DoctorsListPage.tsx` → `DoctorCardWithSessions.tsx` → renders `SelectSessionToReservePopup` (line 77, live, not commented out) | `/book` search page → `Components/Booking/BookingPage2.tsx` → `DoctorCardBooking.tsx` → `BookingSessionSelectorPopup.tsx` → `/book/finalize/[nodeId]` → `FinalizeBookingPage.tsx` |
| Backend submit endpoint | `POST /api/v1/booking/book` → `bookingController.submitABooking` | `POST /api/v1/booking/reserve` → `bookingController.submitBookingNew` |
| Unit being booked | A pre-existing `DoctorSession` document (created ad hoc by the doctor via `doctorController.createSession`, see below) | A dynamically computed shift slot: `DoctorShift` + `getShiftSessionBounds()` |
| Conflict check | `!!session.booking` (a `DoctorSession` has a `booking` ref; `Booking.session` is schema-`unique`) | `Reservation.exists({ doctor, start, end, date })` |
| Payment | Creates an `Invoice` (`total: settings.price`); no wallet debit in this handler, no `Transaction`, no `Booking` document created in this handler either (that appears to happen later, on invoice payment — not traced in this pass) | Immediately debits `Wallet.balance` and creates a `Transaction` + `Reservation` in the same request |
| Resulting record | `Invoice` (→ eventually `Booking`, downstream of invoice payment, not traced this pass) | `Reservation` (feeds the whole lifecycle sweep system: activation/reminder/finalization, per `Models/Reservation.ts`'s own status-machine comments) |

### Why they can disagree

The canonical "what's free" calculation — `Lib/updateDoctorAvailablity.ts`, which populates the `DoctorAvailability` cache that (per `server.ts`) is recalculated on a cron and re-run after every new-flow booking — is built entirely from `DoctorShift` minus `Reservation`:

```ts
const shifts = await DoctorShift.find({ doctor: doctor._id });
...
const reservations = await Reservation.find({ doctor: doctor._id, date: {...} });
```

It never queries `DoctorSession` or `Booking`. Symmetrically, `doctorController.createSession` (System A's slot-creation endpoint) checks a new session for overlap only against other `DoctorSession` documents:

```ts
const isOverlapping = await DoctorSession.exists({
  doctor: req.doctor._id, date: dateKey,
  start: { $lt: data.end }, end: { $gt: data.start },
});
```

— it does not check `DoctorShift`/`Reservation` either. So a doctor can freely create a System-A session at a wall-clock time that is also inside one of their System-B shifts, and nothing in either codepath objects. Once created, that time slot is bookable through *both* front-end surfaces simultaneously: a patient going through `/doctors` → old popup books it as a `DoctorSession`/`Invoice`; a different patient going through `/book` → new flow books the same wall-clock time as a `Reservation`, because `Reservation.exists()` has no way to see the `DoctorSession`/`Booking` side and vice versa. Neither request would be rejected by the other system's conflict check.

### What's confirmed vs. not yet traced

Confirmed by direct code read: both endpoints are mounted (`Routers/bookingRouter.ts`), both are called from currently-live, currently-linked-to frontend surfaces (not orphaned components — traced the full chain from `app/doctors/[page]/page.tsx` and `app/book/page.tsx` down to the fetch calls), and the two conflict checks query disjoint collections.

Not yet traced (flagged as an open investigation rather than guessed at, per audit rule 7):
- Exactly how a `DoctorSession` (System A) becomes a `Booking` document after invoice payment — this happens somewhere in the checkout/invoice-payment flow (`checkoutController.ts` or `Controllers/CartController.ts`, not read in this pass) — so the full System-A write path from "doctor creates session" to "booking exists" wasn't verified end-to-end, only its two endpoints.
- Whether `DoctorSession` slots are, in current practice, mostly created *outside* configured `DoctorShift` windows (which would make real-world overlap rarer than the code alone suggests) — this is a question about doctor behavior/data, not code, and needs either production data access or a conversation with the project owner about how doctors are actually instructed to use the calendar UI.
- Whether one of the two public entry points (`/doctors` vs `/book`) is meant to be retired and the other is mid-rollout — `TODO.md` doesn't mention this split explicitly (unlike the prescription v1/v2 split, which it does call out), so unlike Finding 3.3 this does not have the project owner's own corroboration that it's known, tracked debt. That absence is itself worth noting: this may be a genuinely *undiscovered* seam rather than a known one.

- Likely root cause: `Reservation`/`DoctorShift`-based booking looks like a newer, more capable rebuild of the booking system (richer state machine, wallet integration, presence tracking — see `Models/Reservation.ts`'s extensive comments and the `[[project_reservation_lifecycle_2026_08]]` work) that was rolled out on one surface (`/book`) without removing or redirecting the other (`/doctors`'s card-level booking), and without teaching the availability calculator or either conflict check about the other system.
- Recommended action (for synthesis, not performed here): before any fix, confirm with the project owner whether `/doctors`-page booking (System A) is still intended to be a live purchase path or should be redirected into the `/book` flow; if System A must stay, the minimum fix is making one availability source of truth that both systems write to and check against.
- Affected systems: public booking (both entry points), doctor availability display, wallet/transaction ledger (System B only), invoice/payment (System A only), the reservation lifecycle cron sweeps (only ever see System-B bookings).

---

### Addendum (deeper trace, same session) — System A's completion step is gated off in production, and the two systems surface on completely separate doctor-facing pages

Two follow-up questions from the "not yet traced" list above were closed:

**1. How does a System-A `DoctorSession` become a `Booking`?** Traced to `Controllers/checkoutController.ts:settleInvoice`, the only code path anywhere that calls `Booking.create(...)` (confirmed via a repo-wide grep — one hit). This function:

```ts
export const settleInvoice: RequestHandler = catchAsync(
  async (req, res, next) => {
    //TODO: add Banking shit here later
    if (NODE_ENV === "production") return next(new NotFoundError());
    if (!req.user) return next(new MiddlewareError());
    if (req.body.secret !== "HAJI") return next(new NotFoundError());
    ...
```

is gated by (a) an explicit `NODE_ENV === "production"` check that 404s the entire endpoint in production, and (b) a hardcoded literal string secret (`"HAJI"`) even outside production. The `//TODO: add Banking shit here later` comment, plus `TODO.md`'s own cross-cutting item "Implement payment settlement," both confirm this is known, tracked, intentionally-unfinished work — a payment-gateway integration that was never built, stubbed with a dev-only bypass.

**Effect on Finding 7.1:** this changes the shape of the risk, not its existence. In a production deployment (`NODE_ENV=production`), `settleInvoice` always returns 404, so **`Booking.create` can never execute in production** — meaning:
- The `/doctors`-page booking flow (System A) can create an `Invoice` but can never be completed into a real `Booking` in production through this code path. That's a live, guaranteed-reproducible broken checkout on a primary public page, not just a theoretical risk — assuming the deployed backend does set `NODE_ENV=production` (the env template's own comment, `NODE_ENV=development ( production | development )`, confirms this is the expected production value; this audit did not confirm the live server's actual runtime value).
- Because `Booking` is never created, `session.booking` is never set, so System A's *own* internal conflict check (`!!session.booking` in `submitABooking`) is also permanently inert in production — two different patients could each successfully create an `Invoice` against the same `DoctorSession` without either request being rejected, independent of System B entirely.
- The cross-system double-booking risk described in the main finding above therefore still stands (System B's `Reservation`-based booking is unaffected by any of this and works end-to-end), but the specific scenario of "a System-A booking silently blocks or is blocked by a System-B booking" is less likely than a first read suggests, precisely because System A rarely reaches a fully-committed state in production. The more certain, higher-likelihood problem is the broken/incomplete checkout experience on System A itself.

**2. Do doctors see both systems' bookings in one place?** No. They're on two separate, non-obviously-connected pages:
- `app/doctorpanel/schedule` → `Components/DoctorPanel/Schedule/DoctorManageSchedulePage.tsx` → `GET /doctor/schedule` → `doctorController.getMySchedule`, which queries **`Booking` only** (System A) — confirmed at `doctorController.ts:796-814`, no `Reservation` reference.
- `app/doctorpanel/booking/[nodeId]` → `Components/DoctorPanel/Booking/DoctorManageBookingPage.tsx` → `GET /doctor/reservation/:nodeId` — **`Reservation` only** (System B). Notably, this route has no list/index page in the frontend (`app/doctorpanel/booking` has no `page.tsx`, only the `[nodeId]` detail route) — there is no discoverable doctor-facing list of their `Reservation`s in the app tree found this pass; a doctor would need to already have a specific reservation's id (e.g. from a notification link) to reach this page at all.

So even setting aside the production-gating issue, a doctor logging into their panel and clicking "Schedule" would see only their old-style `Booking`s, not their `Reservation`s, and there's no obvious equivalent "list of my Reservations" page to check instead.

- Severity: revised to **CRITICAL**, now for two independent reasons: (1) a broken production checkout path on a primary public page, not just a data-integrity risk, and (2) doctors have no unified or even reliably-reachable view of all their actual appointments.
- Confidence: HIGH on the production-gating mechanism and the doctor-page split (both directly read in full). MEDIUM-HIGH on "this behaves this way in the live deployment," since the actual runtime `NODE_ENV` value of the production server wasn't verified in this audit — recommended first step before acting on this finding.

---

## Finding 7.2 — Commission/finance-settings models exist and are admin-editable, but no pricing logic anywhere reads them yet

`DoctorFinanceSettings`, `PharmacyFinanceSettings`, `ParaClinicFinanceSettings`, and `GlobalFinanceSettings` (fallback) are all real, admin-CRUD-able models (confirmed in `01_PROJECT_MAP.md` and prior session memory). A repo-wide search of `Controllers/` for `commission` or `FinanceSettings` usage outside the admin CRUD routers themselves returns nothing — `checkoutController.ts`, `CartController.ts`, and `bookingController.ts` (the three places that actually move money) never reference commission or finance-settings at all.

This is not two systems disagreeing — it's one system (pricing/checkout) that hasn't yet been connected to a second, already-built system (commission configuration). Framing matters: this is closer to Phase 4 (placeholder/incomplete feature) than Phase 7 (drift), but it's recorded here because it's exactly the kind of thing that becomes a Phase 7 finding retroactively the moment someone wires it up inconsistently in two of the three money-movement paths instead of one shared place.

- Severity: MEDIUM (no current behavioral bug — a configured commission rate simply has no effect anywhere yet — but a real product gap if commission is expected to be live).
- Confidence: HIGH (absence confirmed by direct search, corroborated by prior session's own note that "no commission-application logic yet" existed as of the finance-settings build).

---

## Checked, no drift found — Org-type ACL / permission gating

`aclController.ts` is the single shared implementation used by every org-type router (`doctorRouter`, `clinicRouter`, `pharmacyRouter`, `paraClinicRouter`, plus `aclRouter`/`blogRouter` generically) and by each org's own controller (`doctorController`, `clinicController`, `pharmacyController`, `paraClinicController`) — confirmed via direct grep, not reimplemented per org type. This is a "checked and clean" result, recorded per audit rule 6 rather than omitted, since permissions was explicitly named as a concept to verify.

---

## Not yet investigated (candidates for a future pass)

- Pricing calculation for products/orders (separate from doctor sessions) — not traced this pass.
- Notification delivery consistency (in-app `Notification` model vs. `web-push` — do both paths fire for the same events, or can one fire without the other?).
- Whether the `Booking` (System A) vs `Reservation` (System B) split also affects the **doctor-side** calendar/schedule views — i.e., does a doctor's `doctorpanel/calendar` or `doctorpanel/schedule` page show both kinds of bookings, or only one? Not checked; if only one, doctors may not even see System-A bookings on their own calendar, which would make this finding worse, not better.
