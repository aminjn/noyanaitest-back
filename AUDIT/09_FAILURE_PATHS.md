# 09 — Error Handling / Failure Paths

---

## Finding 9.1 — Wallet is debited before the record it's paying for is created, with no rollback, in at least two independent money-movement flows

**Severity: HIGH. Confidence: HIGH (both instances directly read; the ordering is unambiguous in the code).**

### Instance A — `bookingController.submitBookingNew` (`Controllers/bookingController.ts:205-233`)

```ts
const wallet = await Wallet.findOneAndUpdate(
  { user: req.user._id }, { user: req.user._id }, { upsert: true, new: true },
);
if (wallet.balance < price) return next(new AppError("موجودی شما کافی نیست", 400));
await Wallet.findByIdAndUpdate(wallet._id, { $inc: { balance: -price } });   // <- money leaves the wallet here
const reservation = await Reservation.create({ ... });                        // <- if this throws, money is already gone
const transaction = await Transaction.create({ user: req.user._id, amount: -price, reservation: reservation._id });
reservation.transaction = transaction._id as unknown as IReservation["transaction"];
await reservation.save();
```

### Instance B — cart checkout (`Controllers/CartController.ts`, around lines 247-273)

The same shape: `Wallet.findByIdAndUpdate(wallet._id, { $inc: { balance: -total } })` at line 254-255, followed by `Order.create(...)` at line 261 and `Transaction.create(...)` at line 273 — the debit happens first, the records that justify and account for it are created afterward.

**Why this matters:** none of these three-to-four writes are wrapped in a Mongo/Mongoose transaction (no `session`/`startTransaction` used in either function). If the process crashes, a validation error fires, or the DB hiccups between the balance decrement and the follow-up `create()` calls, the user's wallet balance is permanently reduced with no `Reservation`/`Order` and no `Transaction` record to show for it — an unrecoverable, invisible loss of the user's money from the application's point of view (no error surfaces to support/admin tooling pointing at the orphaned debit, since the debit itself doesn't fail or log anything unusual). This is the inverse of Finding 3.3 (the confirmed prescription-item cleanup bug) in shape: there, a delete silently no-oped; here, a debit silently succeeds while its purpose silently fails.

**What would need to be true for this to be safe (not verified, flagged as open):** if the deployed MongoDB is a replica set, Mongoose multi-document transactions are available and would be the standard fix; if it's a standalone instance (which the connection string in `server.ts` — `mongodb://host:port/db`, no replica set option — is at least consistent with, though not proof), transactions aren't available at all and a different compensating-write or outbox-pattern strategy would be needed. This audit did not have DB access to confirm topology.

- Likely root cause: both flows appear to prioritize "reject fast if balance is insufficient" (the debit is the simplest way to atomically claim the funds) without a corresponding rollback-on-failure step for the record creation that follows.
- Recommended action (for synthesis): wrap each flow's writes in a Mongo transaction if a replica set is available, or restructure to create the record first (in a "pending payment" state) and debit second, or add a reconciliation job that detects wallet debits with no matching `Transaction`.
- Cross-reference: `Lib/updateDoctorAvailablity.ts` carries the exact same class of self-acknowledged gap — a comment reading `//TODO: this whole shit needs to be in a transaction` — independent evidence that the project owner is already aware this general category of risk exists somewhere in the codebase, though not confirmed to be aware of these two specific call sites.

---

## Finding 9.2 — Reminder sweep doesn't persist failure state, unlike its sibling activation/finalization sweeps

`Services/reservationActivationService.ts` contains three cron-driven sweeps over `Reservation` documents. The activation sweep (`runReservationActivationSweep`) persists failures to `reservation.dispatchError` on catch, so a stuck reservation is inspectable later. The reminder sweep (`runReservationReminderSweep`, lines 251-263) catches the same class of failure but only `console.log`s it — no field on the reservation records that its reminder has been failing, so an operator can't distinguish "reminder never due yet" from "reminder has been silently failing on every tick" without reading server logs.

- Severity: LOW (reminders are a convenience notification, not money- or correctness-critical, and the sweep will keep retrying every tick within the reminder window regardless).
- Confidence: HIGH.

---

## Finding 9.3 — Process-level uncaught-error handlers only log; the process is left running after unknown-severity failures

`server.ts`, final lines:
```ts
process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);
```
Both Node's own documentation and common production practice treat `uncaughtException` in particular as a signal the process is in a potentially corrupted state that should be logged and then exited (ideally under a process manager that restarts it), not merely logged and continued from. As written, any truly unexpected/unhandled error anywhere in the app (not just inside an Express request, which `catchAsync` already handles safely) leaves the process running in whatever state it was in when the error fired — including, plausibly, mid-way through one of the multi-step writes in Finding 9.1.

- Severity: MEDIUM (a general robustness gap, not a specific confirmed incident).
- Confidence: HIGH on the code; the practical impact depends on how often truly-uncaught errors occur in practice, which wasn't measurable from source alone.

---

## Checked, no issue found

- **`Lib/catchAsync.ts`**: a clean, consistently-applied Express async-handler wrapper (`fn(req,res,next).catch(err => next(err))`) used throughout every controller read in this audit. No route was found bypassing it in a way that could leak an unhandled promise rejection past Express's own handling.
- **`Controllers/errorController.ts`**: a conventional centralized error handler — defaults `statusCode` to 500, distinguishes `isOperational` (expected `AppError`s) from unknown errors in production (generic "something went very wrong" message, full error only logged server-side), and normalizes common Mongoose error classes (`CastError`, duplicate key `11000`, `ValidationError`) plus JWT errors into user-facing messages. No path found that converts an error into a 200-level "success" response.
- **`Services/reservationProgressService.ts:handleReservationSuccess`** (the doctor-payout-on-completion function): explicitly designed for the exact race this phase looks for — a code comment states *"Idempotent - the finalization sweep only persists reservation.status after this resolves, so a retry ... must not double-credit the doctor"* and the function backs that claim with a real guard (`Transaction.exists({ reservation, doctor })` checked before crediting). This is a genuine positive finding: the one place in the reservation lifecycle where a retry-after-partial-failure scenario was clearly anticipated and defended against, in contrast to Finding 9.1 where the equivalent scenario (retry/crash after a wallet debit) has no such guard.
- **Reservation activation/finalization sweeps' batching**: capped at `MAX_RESERVATIONS_PER_RUN = 200` with an explicit comment that leftovers are picked up next tick — a deliberate, documented choice to avoid blocking the event loop on a large backlog, not an accidental limit.

## Not yet investigated

- `Services/Call/CallService.ts` and `CallRuntime.ts` were only spot-checked (two catch blocks seen in the earlier grep, both logged with context); the mediasoup/recording failure paths were not traced end-to-end for partial-state risk (e.g., a `Producer`/`Transport` left open in memory after a failed downstream step).
- `initCallService(server).then().catch(err => console.log(...))` in `server.ts`: if mediasoup/socket.io initialization fails, the server continues running with calling entirely non-functional and no retry — acceptable as a boot-time fail-safe (the HTTP API stays up), but worth confirming there's no silent partial-init state (e.g., `io` left non-null but half-configured) — not traced this pass.
- Order/checkout flows for products (pharmacy/paraClinic order fulfillment) were not re-examined for the same debit-before-create ordering as Finding 9.1 beyond the one `CartController.ts` checkout path found — worth a targeted follow-up given the pattern has now appeared twice.
