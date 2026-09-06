# 06 — Database / Schema Drift

Scope note: not an exhaustive field-by-field pass over all ~180 models — that would need Phase 2's dependency inventory as a base. This pass followed the `Booking`/`DoctorSession` vs. `Reservation` seam already established in Phases 1, 7, and 8 down to the schema level, since that's where the audit's evidence so far said drift was most likely to be concrete and consequential, plus a couple of opportunistic checks (indexes, a `role` field, a widely-reused `old` field).

---

## Finding 6.1 — `DoctorSession.date` and `Reservation.date` use two different, and possibly non-equivalent, calendar-day representations

**Location:** `noyanai-back/Models/DoctorSession.ts` (`date: { type: String, required: true }`) vs. `Models/Reservation.ts` (`date: { type: Date, required: true }`).

- `DoctorSession.date` is populated via `Lib/helpers.ts:getSessionDateKey`:
  ```ts
  export const getSessionDateKey = (date: Date): string =>
    new Date(date).toISOString().split("T")[0];
  ```
  — a UTC-based `YYYY-MM-DD` string (`toISOString()` always renders in UTC, regardless of server or user timezone).

- `Reservation.date` is populated via `Lib/dateUtils.ts:dateStartOfDay`:
  ```ts
  export const dateStartOfDay = (t: Date) => {
    const then = new Date(t);
    then.setHours(0, 0, 0, 0);
    return then;
  };
  ```
  — a native `Date` set to local midnight, where "local" is whatever timezone the Node process is running in (`setHours` is local-time, not UTC).

**Why this matters:** these are two different definitions of "which calendar day does this booking fall on" for what is, per Finding 7.1, the same real-world concept (a patient reserving a doctor's time). If the backend process's timezone is anything other than UTC, a booking made late in the evening (Iran Standard Time is UTC+3:30) could be filed under different calendar dates by the two systems for the same wall-clock moment — `getSessionDateKey` rolls over to the next day at UTC midnight (8:30pm Tehran time), while `dateStartOfDay` rolls over at local midnight. `TODO.md`'s cross-cutting item "Fix timezone shift bug" is a plausible match for exactly this kind of representation mismatch, though this audit did not confirm that TODO item refers to this specific code (no ticket/description beyond the one line exists to cross-check against).

- Severity: MEDIUM (plausible root cause for a bug the project owner has already flagged as real, but not confirmed as *the* cause).
- Confidence: MEDIUM — the representational mismatch itself is HIGH confidence (both functions read directly); its connection to the specific "Fix timezone shift bug" TODO item is a reasonable inference, not a confirmed link. The actual server timezone (which determines whether this manifests in practice) was not accessible from this audit.
- Recommended action: standardize on one date representation (a `Date` at UTC midnight is the more common convention) across both systems, or explicitly document why they differ if intentional.

---

## Finding 6.2 — `CallRoom.source` enum wasn't extended when the model gained a `reservation` field alongside `booking`; "booking" is now used to mean either

**Location:** `noyanai-back/Models/CallRoom.ts`

```ts
// "adhoc": started directly between users through the call API.
// "booking": generated for/linked to a Booking (a scheduled doctor session).
export const callSources = ["adhoc", "booking"] as const;
...
booking?: IBooking;
// set when this room was opened for a booked session on the new
// Reservation model, by the reservation activation cron
reservation?: IReservation;
```

Both `booking` and `reservation` reference fields exist on the model (with the comment on `reservation` explicitly calling `Reservation` "the new" model — first-party language, not this audit's framing), and both have their own index (`CallRoomSchema.index({ booking: 1 })`, `CallRoomSchema.index({ reservation: 1 })`). But `callSources` — the enum meant to categorize *why* a room exists — was never given a third value for the new model. Confirmed at the call site: `Services/reservationActivationService.ts` creates the room for a Reservation-based session with `source: "booking"` (line ~73), the same literal used for the old model's rooms.

- Severity: LOW (cosmetic/semantic — `source: "booking"` still functions as "this is a scheduled-session room, not adhoc," which is arguably still correct; the two rooms are distinguishable regardless by which of `booking`/`reservation` is populated). Recorded because it's a small, precise instance of the exact pattern Phase 6 looks for: a field whose meaning silently broadened without the schema being updated to say so.
- Confidence: HIGH.

---

## Finding 6.3 — Index coverage doesn't match query patterns on the two most-queried booking-adjacent models

- `DoctorSession` (`Models/DoctorSession.ts`) has **no indexes defined at all**, despite being queried by `{doctor, date, start, end}` on every session-creation overlap check (`doctorController.createSession`) and by `{date, doctor}` on day-view reads (`getSessionsByDayFull`). Every one of these is a collection scan as the model grows.
- `Reservation` has one compound index — `{ status: 1, date: 1, start: 1 }` — but its own most common conflict-check query, `Reservation.exists({ doctor, start, end, date })` (`bookingController.submitBookingNew`), filters by `doctor` first in the code, and `doctor` isn't in the index at all. MongoDB can still use the index for the `date`/`start` portion in some query shapes, but a leading `doctor` filter with no supporting index means this specific, high-frequency query (it runs on every booking attempt) likely isn't served efficiently by the one index that exists.

- Severity: MEDIUM (performance/scalability, not correctness — not a bug today at low data volume, but exactly the kind of thing that becomes a production incident once collections grow).
- Confidence: MEDIUM — index *absence* is directly confirmed by reading both schema files in full; actual query-planner behavior (whether Mongo picks a different, adequate plan) wasn't verified against a live database or `explain()` output, which this audit didn't have access to.
- Recommended action: add `{doctor: 1, date: 1, start: 1}`-shaped indexes to both models matching their actual conflict-check query shape.

---

## Checked, no issue found

- **`User.role`**: a single `role: { type: String, enum: userRoles }` field — no parallel `roles`/`userType`/`permissions` field found on `User.ts` that could drift from it. The audit brief's own worked example (`role`/`roles`/`userType`/`permissions` all meaning the same thing) does not appear to apply here; the ACL/access-level system (`AccessLevel`, `UserAccessLevel`) is a separate, intentionally-additional layer for granular "notadmin" staff permissions (already reviewed in `07_BUSINESS_LOGIC_DRIFT.md`'s "checked, no drift found" section), not a competing representation of the same concept.
- **`DoctorSession`'s `oldPatient`/`newPatient` boolean flags**: confirmed actively written (`doctorController.ts:756-757`) — not dead schema fields, despite the "old" in the name being coincidentally reminiscent of the unrelated `Models/Old/*` legacy system (they are unrelated; `oldPatient` here means "this patient has been seen by this doctor before," nothing to do with the legacy data migration).
- **The `old: <ObjectId>` cross-reference field** present on `Doctor`, `Speciality`, `Blog`, `Part`, `Disease`, `Drug`, `Symptom` (per `03_LEGACY_AND_DUPLICATION.md` Finding 3.4): consistent naming and consistent purpose (provenance pointer back to the pre-migration `Models/Old/*` record) across all seven models — not drifted, despite being spread across seven separate schema files that could each have named or typed it differently.

## Not yet investigated

- No pass was made over the ~170 remaining models beyond the ones already implicated by Phases 3/7/8's findings — this phase followed evidence rather than sampling broadly.
- `Invoice`/`InvoiceCheckout` vs. `Transaction`/`Wallet` as two different payment-record shapes (one for the old booking flow, one for the new) was not compared field-by-field, only functionally (in `07_BUSINESS_LOGIC_DRIFT.md`).
- Geo-indexed models (`Clinic`, `DoctorProfile`, `Hospital`, `Insurance`, `Paraclinic`, `Office`, `UserAddress`, `Models/Geo/*`) all carry `2dsphere` indexes consistently — noted in passing while scanning the index list, not independently verified for correctness of the underlying `location`/`geometry` field shapes.
