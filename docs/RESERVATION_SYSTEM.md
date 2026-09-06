# Working with the Reservation System

This is the doctor-booking system referred to as **System B** in `AUDIT/`. As of F-01 (see `AUDIT/FIXES_TODO.md`), it is the *only* live doctor-booking path — the older `DoctorSession`/`Invoice`/`Booking` flow ("System A") has been retired. `Booking`/`DoctorSession` still exist in the database for historical records (old invoices, doctors' existing schedule history) but nothing can create new ones anymore.

This doc is a map of how the pieces fit together, not a line-by-line spec — read the cited files for exact behavior.

---

## 1. Mental model

A patient books a **shift-derived slot** with a doctor. The doctor doesn't create individual bookable sessions by hand (that was System A); instead the doctor defines recurring **weekly shifts** (`DoctorShift`), and the system mechanically slices each shift into fixed-length sessions. A background job pre-computes which of those slices are actually free right now into a cache (`DoctorAvailability`) that both search and booking read from. Booking a slot creates a `Reservation`, debits the patient's wallet immediately, and a set of cron sweeps carry the reservation through its lifecycle — opening the right communication channel when it's due, tracking who showed up, and deciding the outcome once it's over.

```
DoctorShift (doctor's recurring weekly availability)
      │  getShiftSessionBounds() slices it into fixed slots
      ▼
DoctorAvailability (cache: which slots are still free, per day)
      │  read by search (/public/filterBooking2) and the booking popup
      ▼
Reservation (created on submitBookingNew, wallet debited immediately)
      │  picked up by cron sweeps as its start time arrives
      ▼
activation → (reminder already sent earlier) → in-progress channel (Chat / CallRoom / SIP) → finalization → payout
```

---

## 2. Backend

### 2.1 Data model

| Model | File | Role |
|---|---|---|
| `DoctorShift` | `Models/DoctorShift.ts` | A doctor's recurring weekly template: `day` (0–6, Saturday-based — see `saturdayBasedDay`), `start`/`end` (minutes from midnight), `duration` + `gap` (how it's sliced into sessions), `office`, `sessionTypes`, `patientTypes`. Doctor-managed, full-replace CRUD (`setShifts` deletes and re-inserts all of a doctor's shifts). |
| `DoctorAvailability` | `Models/DoctorAvailability.ts` | Cache of *actually free* slots per calendar day: `doctor`, `date`, `bounds: {start,end}[]`, plus a flattened `start`/`end`/`isAvailable` for quick filtering. Rebuilt, never patched in place — see 2.2. |
| `Reservation` | `Models/Reservation.ts` | The booking itself. `user` (who booked), `patient` (`UserIdentity` — may differ from `user`, e.g. booking for a relative), `doctor`, `date` (day, see the date-representation note in §5), `start`/`end` (minutes), `office`, `sessionType`, `status` (state machine, see 2.4), `transaction` (the patient's debit), `chat`/`callRoom` (set once dispatched), presence/timing fields for the lifecycle sweeps. |
| `Transaction` | `Models/Transaction.ts` | Wallet ledger entries. A booking creates one (negative `amount`) for the patient; a completed reservation later creates a second one (positive `amount`) for the doctor, linked via `reservation` + `doctor`. |
| `Wallet` | `Models/Wallet.ts` | One per user, `balance`. Debited/credited directly, no escrow/hold step. |
| `CallRoom` / `Chat` | `Models/CallRoom.ts`, `Models/Chat.ts` | Communication channels. A reservation's `chat` or `callRoom` field is set by the activation sweep when it opens the channel for that session type. |

### 2.2 Availability: how the cache gets built and kept fresh

`Lib/updateDoctorAvailablity.ts` is the single function that (re)computes availability for one doctor over a date range:

1. Deletes existing `DoctorAvailability` docs for that doctor in that range.
2. Loads the doctor's `DoctorShift`s, groups by weekday.
3. Loads existing `Reservation`s in that range, groups by day.
4. For each day in range: takes that weekday's shifts, slices each into session bounds via `Lib/shiftUtils.ts:getShiftSessionBounds` (fixed `duration` steps of `duration + gap`), subtracts any bounds that overlap an existing reservation, and inserts one `DoctorAvailability` doc per day that still has free bounds.

This runs in three places — **always call it after anything that changes what "free" means for a doctor**, or the cache goes stale:
- `Controllers/doctorController.ts:setShifts` — after a doctor replaces their shifts (single day → whole booking horizon, `env.BOOKING_HORIZON_DAYS`).
- `Controllers/bookingController.ts:submitBookingNew` — after a booking, for just that one day (the slot that was just taken needs to disappear from the cache).
- `server.ts`'s `startDoctorAvailabilityCron` — a full recompute for every doctor on an interval (`recalculateDoctorAvailabilityInterval` from `AppConfig`), plus `cleanUpExpiredDoctorAvailabilities` to drop past days. This is the safety net that fixes any drift the two targeted recomputes above miss.

If you add a new way to change a doctor's bookable time (a new shift-editing endpoint, a manual admin override, etc.), call `updateDoctorAvailability` from it too.

### 2.3 Booking creation — `POST /booking/reserve`

`Controllers/bookingController.ts:submitBookingNew`, mounted in `Routers/bookingRouter.ts`. Given `{ doctor, date, start, end, sessionType, patient, method }`:

1. Validates the date isn't in the past, resolves `patient` (must be the requester or one of their `Relative`s), resolves `doctor`.
2. Re-derives the shift and its session bounds server-side from `DoctorShift` + `getShiftSessionBounds` (doesn't trust the client's start/end blindly) and confirms the requested slot is one of them.
3. Confirms the slot isn't already reserved: `Reservation.exists({ doctor, start, end, date })`. **This is the actual conflict check** — `DoctorAvailability` is a cache for *display*, this is the source of truth at write time.
4. Looks up the session-type settings model for pricing (`sesstionTypeToDoctorSettings`) and confirms it's active and priced.
5. Debits the patient's `Wallet` (`$inc: { balance: -price }`), creates the `Reservation` (`status: "pending"`), creates a negative `Transaction` linked to it.
6. Responds, **then** (after responding) calls `updateDoctorAvailability` for that one day.

Known gap (tracked separately, not fixed by this doc): F-03 in the audit — the wallet is debited before the `Reservation`/`Transaction` exist, with no rollback if something after the debit throws. Don't copy this pattern into new code without addressing it.

### 2.4 Lifecycle sweeps — `Services/reservationActivationService.ts`

Three independent `setInterval` jobs, started in `server.ts:init()`, each reading its interval from `AppConfig` (changeable in admin settings, but only takes effect on the next server restart — see the comment in `server.ts`):

**Reminder sweep** (`runReservationReminderSweep`) — for `pending` reservations starting within `reservationReminderMinutesBefore` minutes, sends a "starts in N minutes" notification once (`reminderSentAt` guards against re-sending).

**Activation sweep** (`runReservationActivationSweep`) — for `pending` reservations whose start time has arrived (`isDue`), dispatches the right channel per `sessionType` via `activationHandlerBySessionType`:
- `textChat` → creates a `Chat`, sets `reservation.chat`.
- `voiceCall` / `videoCall` → creates a `CallRoom`, sets `reservation.callRoom`.
- `sipCall` → originates a SIP call via `Lib/sipService.ts` (fire-and-forget from the sweep's perspective; each leg's answer callback calls `markReservationPresent`).
- `inPerson` → no channel, just a notification ("patient is arriving" / "session is starting").
- `phone` → currently aliased to the `inPerson` handler (no-op beyond notifying) — flagged in the code as needing its own dispatch before relying on it.

On success: `status → "active"`, `activatedAt` set. On failure: `dispatchError` recorded, left `pending` for the next tick (or eventually caught by finalization as `error`, see below).

**Finalization sweep** (`runReservationFinalizationSweep`) — for `pending`/`active` reservations whose *end* time has passed, decides the outcome from presence timestamps and calls exactly one trigger in `Services/reservationProgressService.ts`:

| Condition | `status` becomes | Trigger |
|---|---|---|
| Still `pending` at end time (activation never succeeded) | `error` | `handleReservationError` (TODO, no-op) |
| Both `patientPresentAt` and `doctorPresentAt` set | `completed` | `handleReservationSuccess` — **implemented**: credits the doctor's wallet the exact amount the patient paid (no fee/commission logic yet, see §5), idempotent via `Transaction.exists` check |
| Only doctor present | `noShow` (`noShowParty: "patient"`) | `handlePatientNoShow` (TODO, no-op) |
| Only patient present | `noShow` (`noShowParty: "doctor"`) | `handleDoctorNoShow` (TODO, no-op) |
| Channel opened, neither ever present | `error` | `handleReservationError` (TODO, no-op) |

**Presence** (`patientPresentAt`/`doctorPresentAt`) is set once, idempotently, by `reservationProgressService.ts:markReservationPresent`, called from wherever a party is first observed for that channel type: a chat message, a call participant joining, an answered SIP leg, or (inPerson only) the doctor's manual check-in action (`Controllers/doctorController.ts:checkInReservation`, `PATCH /doctor/reservation/:nodeId/check-in`). If you add a new session type or channel, you must wire its own "someone showed up" signal to call `markReservationPresent` — nothing does this automatically.

If you need a new terminal outcome or a new state, extend `reservationStatuses` in `Models/Reservation.ts` and add the branch to the finalization sweep — don't overload an existing status with a new meaning.

### 2.5 Reading endpoints

| Endpoint | Handler | Who | Notes |
|---|---|---|---|
| `GET /public/dr/:nodeId/availability` | `publicController.getDoctorAvailabilities` | anyone | Raw `DoctorAvailability[]` for one doctor — what `BookingSessionSelectorPopup` fetches. |
| `GET /public/dr/:nodeId/id` | `publicController.getDoctorProfileById` | anyone | Doctor profile + shifts + session-type settings, used by the finalize page. |
| `GET /public/filterBooking2` | `publicController.filterBooking2` | anyone | The `/book` search results grid — specialty/disease/location/date/time/gender/etc. filters over `DoctorProfile`, populates `availabilities` per result. |
| `GET /doctor/schedule` | `doctorController.getMySchedule` | doctor | Returns `{ bookings, reservations }` — both System A and B, merged (F-01). Gated by `readCalendar` ACL + `schedule` license module. |
| `GET /doctor/reservation/:nodeId` | `doctorController.getMyDoctorReservation` | doctor | One reservation's detail, scoped to that doctor. Gated by `shifts` license module. |
| `PATCH /doctor/reservation/:nodeId/check-in` | `doctorController.checkInReservation` | doctor | inPerson-only manual presence marking. |
| `GET /user/reservation` | `userController.getMyReservations` | patient | List, for `/dashboard/booking`. |
| `GET /user/reservation/:nodeId` | `userController.getMyReservation` | patient | Detail, for `/dashboard/booking/:nodeId`. |

---

## 3. Frontend

### 3.1 Public booking flow (patient-facing)

**Search entry point** — `app/book/page.tsx` → `Components/Booking/BookingPage2.tsx`, which switches between `DoctorBooking` / `ClinicBooking` / `PharmacyBooking` by node type. `DoctorBooking.tsx` builds a query string from filter state and hits `/public/filterBooking2`, rendering results via `DoctorBookingResults` → `DoctorCardBooking.tsx`.

**Per-doctor slot picker** — `DoctorCardBooking.tsx`'s day badges and its own "more" button both open `Components/Booking/BookingSessionSelectorPopup.tsx`, passing just the doctor object (only `_id`/`slug` are actually used). This popup is **self-contained**: it fetches its own availability (`/public/dr/:id/availability`), lets the patient page through the next 5 (tab view) or 30 (list view) days, and on confirm navigates to `/book/finalize/:doctorId?d=<date>&s=<start>&e=<end>`. It requires login only at the confirm step (shows `AuthPopup` if not logged in).

Because this popup only needs a bare doctor id, it's reused as **the one booking entry point everywhere a doctor is shown to a patient**:
- `/doctors` listing cards — `Components/Booking/DoctorCardWithSessions.tsx`'s `Sessions` sub-component.
- `/dr/[slug]` profile page — `Components/Dr/PublicDrSessions.tsx`.
- `/book` search results — `DoctorCardBooking.tsx` (original use).

If you add another place that shows a doctor and want a "book with them" action, reuse `BookingSessionSelectorPopup` rather than building a new picker — don't fetch `/public/doctor/:id/day/:stamp` or `/public/doctor/:id/week` for this; those are the retired System-A endpoints (still present server-side but unused by any live page — see F-01's follow-up note in `AUDIT/FIXES_TODO.md`).

⚠️ **Timezone note when computing which calendar day a slot belongs to**: `getSessionDateKey` (`Lib/helpers.ts` / `Components/helpers/lib.tsx`) was fixed under F-19 to key off the `Date`'s *local* calendar-day components — it used to use `toISOString()` (UTC), which rolled over 8:30pm-ish local time in Tehran and silently misfiled evening `DoctorSession`s under the wrong day. It's safe to use again now, but note it uses the *caller's own* local timezone — the backend's process timezone server-side, the viewer's browser timezone client-side — so it's still not a reliable way to compare a day across the client/server boundary if they could ever differ. When you need to match a specific `Date`/timestamp against a day range regardless of whose "local" is asking, prefer explicit range comparison instead, the way `DoctorCardBooking.tsx`'s `DayCard` and `DoctorCardWithSessions.tsx`'s `Sessions` do:
```ts
const start = new Date(date); start.setHours(0, 0, 0, 0);
const end = new Date(start); end.setDate(end.getDate() + 1);
data.find(el => new Date(el.date) >= start && new Date(el.date) < end);
```
See `AUDIT/06_DATABASE_DRIFT.md` Finding 6.1 / F-19 (now fixed, going forward only — existing `DoctorSession` records created before the fix under the old UTC-based key were not repaired).

**Finalize page** — `app/book/finalize/[nodeId]/page.tsx` → `Components/Booking/Finalize/FinalizeBookingPage.tsx`. Reads `d`/`s`/`e` query params (redirects to `/book` if missing/invalid), fetches the doctor fresh by id, re-derives the shift from the doctor's own `shifts` array client-side (just for display — the server re-validates everything in `submitBookingNew`), and walks the patient through three stages: pick patient (`PatientStage`, defaults to self, can add a relative or pick an existing one) → pick session type (`SessionTypeStage`, filtered to what that shift + doctor settings actually support) → checkout (`CheckoutStage`, wallet-only for now, shows balance). Submits `POST /booking/reserve` and routes to `/dashboard/booking/:id` on success.

### 3.2 Patient dashboard

- `/dashboard/booking` — `Components/Dashboard/Booking/DashboardManageBookingsPage.tsx`, a table of the patient's reservations (`GET /user/reservation`).
- `/dashboard/booking/[nodeId]` — `DashboardManageBookingPage.tsx`, single reservation detail: status badge (`ReservationStatusBadge`), info grid, a "join session" button (`ReservationJoinButton`, renders for `chat`/`callRoom` only when `status === "active"` — nothing for `sipCall`/`inPerson`, which don't populate either field), and a timeline (`ReservationTimeline`).

Both types (`IReservation`, `ITransaction`, `ICheckout`, status enum + display dicts) are defined in `DashboardManageBookingsPage.tsx` / `./reservationStatus.ts` and reused everywhere else on the frontend that touches a reservation (doctor panel included) — import from there rather than redefining.

### 3.3 Doctor panel

- `/doctorpanel/shift` (`DoctorManageShiftsPage.tsx`) — full-replace CRUD over `DoctorShift`, `GET`/`POST /doctor/shift`.
- `/doctorpanel/schedule` (`DoctorManageSchedulePage.tsx`) — the doctor's day-grouped view of *everything* on their calendar. Since F-01, `GET /doctor/schedule` returns `{ bookings, reservations }`; the page merges both into one day-keyed list and renders `ScheduleBookingCard` or `ScheduleReservationCard` per entry depending on which system it came from.
- `/doctorpanel/booking/[nodeId]` (`DoctorManageBookingPage.tsx`) — single reservation detail, mirrors the patient-side detail page plus the inPerson check-in button (`canCheckIn`, `PATCH /doctor/reservation/:nodeId/check-in`) when applicable. There is deliberately no `/doctorpanel/booking` index route — a doctor reaches a reservation via the merged schedule page or a notification link, not a standalone reservation list.
- `/doctorpanel/calendar/[stamp]` — the day-detail calendar view; still System-A (`DoctorSession`)-oriented, not part of the Reservation flow.

---

## 4. Common tasks

**Add a new session type** (rare — the five existing ones are `inPerson | sipCall | textChat | voiceCall | videoCall`, plus the half-wired `phone`):
1. Add it to `doctorSessionTypes` in `Models/DoctorSession.ts` (shared enum, used by both systems).
2. Add its settings model to `sesstionTypeToDoctorSettings` in `bookingController.ts` (pricing/active toggle).
3. Add an `ActivationHandler` case in `activationHandlerBySessionType` (`reservationActivationService.ts`) — decide what "the session is starting" means for it and how presence gets marked.
4. Wire a `markReservationPresent` call from wherever that channel signals someone joined.
5. Handle it in `ReservationJoinButton.tsx` if it needs a "join" action.

**Add a new reservation outcome / status**: extend `reservationStatuses` in `Models/Reservation.ts`, add the branch in `runReservationFinalizationSweep`, add a display entry in `reservationStatus.ts`'s content-key/badge-color dicts (frontend).

**Show a doctor's availability somewhere new**: fetch `/public/dr/:id/availability` and either render your own summary from the `bounds` (local-date-range matching, see the timezone gotcha above) or just drop in `BookingSessionSelectorPopup` — it needs nothing but the doctor id.

**Change how commission/payout works**: currently `handleReservationSuccess` credits the doctor the patient's exact payment, no cut taken. Real commission-settings models (`DoctorFinanceSettings`, etc.) exist and are admin-editable but aren't read anywhere yet — this is tracked as F-06/F-27 in the audit, scoped as one piece of work.

---

## 5. Known caveats

- **F-19 (fixed)** — `Reservation.date` (a `Date` set to the backend process's local midnight, `Lib/dateUtils.ts:dateStartOfDay`) and `DoctorSession.date` (a day-key string, `Lib/helpers.ts:getSessionDateKey`) used to disagree because the latter was UTC-based while the former was local-based, and production runs in a local timezone ahead of UTC (confirmed: Tehran-like). `getSessionDateKey` is now local-day-based too, in both repos. Existing `DoctorSession` records written before the fix under the old UTC-based key were not repaired — they may still be off by one day for sessions created in the evening.
- **F-03 (open)** — wallet debit happens before the `Reservation`/`Transaction` are confirmed created, no rollback on a later failure.
- **No commission/payout formula** — see §4 above.
- **No-show / error outcomes are detection-only** — `handlePatientNoShow`, `handleDoctorNoShow`, `handleReservationError` are empty stubs; only the success path actually does something (credits the doctor).
- **`DoctorAvailability` is a read cache, not the source of truth** — `submitBookingNew` re-checks `Reservation.exists(...)` directly. Never trust the availability cache for a write-time decision.
- The retired System-A public endpoints (`getUpcomingWeekAvailabelSessions`, `getAvailableSessionsByDay`, `getFirstAvailableSession`, `getSessionDetails`, `getDoctorConfig` in `publicController.ts`) still exist server-side but have no live frontend caller as of F-01 — don't build new features on top of them.
