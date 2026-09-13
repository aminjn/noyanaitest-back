// Shared type-safe camelCase-event -> SMS-pattern-field-name derivation,
// used by every model that defines its own list of SMS-eligible events
// (Models/UserAlert.ts's userAlertEvents, Models/Reservation.ts's
// reservationSmsEvents, ...) so none of them have to hand-list pattern
// names. Originally lived only in Models/UserAlert.ts; pulled out here once
// a second event list (reservationSmsEvents) needed the exact same
// derivation (2026-09).
//
// Every event gets its OWN pattern name - this is what guarantees two
// different events (e.g. "new ticket" and "new become-organization
// request", or "new reservation for doctor" and "new reservation for
// patient") can never end up silently sharing one generic pattern.

// Type-level camelCase -> snake_case (lowercase), e.g.
// "newBecomeDoctorRequest" -> "new_become_doctor_request". Only used to
// build SmsPatternNameFor below so the *type* of smsPatternNameForEvent's
// return value is a literal like "NEW_BECOME_DOCTOR_REQUEST_PATTERN"
// instead of plain `string` - i.e. a typo in a pattern name is a compile
// error, not a silent runtime miss.
type SnakeCase<S extends string> = S extends `${infer Head}${infer Rest}`
  ? Head extends Uppercase<Head>
    ? `_${Head}${SnakeCase<Rest>}`
    : `${Head}${SnakeCase<Rest>}`
  : S;

// The SMS pattern field name for a given event, e.g.
// SmsPatternNameFor<"newBecomeDoctorRequest"> is the literal type
// "NEW_BECOME_DOCTOR_REQUEST_PATTERN". Distributes over a union, so
// SmsPatternNameFor<SomeEventUnion> is the union of every event's pattern
// name.
export type SmsPatternNameFor<E extends string> =
  `${Uppercase<SnakeCase<E>>}_PATTERN`;

// camelCase event name -> SCREAMING_SNAKE_CASE + "_PATTERN", e.g.
// "newBecomeDoctorRequest" -> "NEW_BECOME_DOCTOR_REQUEST_PATTERN". The
// single source of truth for turning any event name into its SMS pattern
// field name - callers pass their own event union in as `E`.
export const smsPatternNameForEvent = <E extends string>(
  event: E,
): SmsPatternNameFor<E> =>
  `${event.replace(/([A-Z])/g, "_$1").toUpperCase()}_PATTERN` as SmsPatternNameFor<E>;
