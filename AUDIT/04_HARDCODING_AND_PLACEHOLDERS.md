# 04 — Hardcoding & Placeholders

70 `TODO`/`FIXME`/`HACK`/`XXX` comments in `noyanai-back`'s own source (excluding `node_modules`), 25 in `noyanai-front`'s `app`/`Components`. Most are ordinary in-progress-work markers (`//TODO: add validation`, `//TODO: hook this up`) — legitimate, low-signal, not itemized individually below. This phase reports the ones that are either confirmed-dangerous, or that directly corroborate/extend findings from earlier phases with first-party evidence.

---

## Finding 4.1 — Hardcoded fake patient/doctor identity data sent to the Tamin insurance API

**Location:** `noyanai-back/Controllers/doctorController.ts`, inside `submitASegmentForTamin` (~line 2805-2825), immediately after a `//TODO: this is definitely not the way` comment:

```ts
const body = {
  patient: "0123456789",
  mobile: "09129999999",
  prescType: { prescTypeId: args.items ? 1 : 2 },
  prescDate: moment(new Date()).format("jYYYYjMMjDD"),
  docId: "2000200092",
  docMobileNo: "09991111111",
  docNationalCode: "1234567891",
  comments: "",
  expireDate: "14030102",
  clientId: "0123456789",
  ...
};
const response = await makeTaminRequest({
  path: "https://ep-test.tamin.ir/api/v2/SendEpresc",
  ...
});
```

**Classification:** obvious placeholder, but a self-acknowledged and scope-limited one. The patient/mobile/doctor-ID/national-code values are all sequential or repeated-digit fakes (`"0123456789"`, `"09129999999"`, `"1234567891"`), and the request target is `ep-test.tamin.ir` — the sandbox host, matching `TODO.md`'s own framing: *"Tamin sandbox ≠ real API — all Tamin integration gets rewritten once real access lands."* The developer's own `//TODO: this is definitely not the way` comment confirms this was known to be wrong even as placeholder code, not an oversight this audit is the first to notice.

- Severity: MEDIUM. Not exploitable by an external attacker (it's the *outbound* payload to a third-party sandbox, not something a user controls), but every real prescription submitted through this code path during the sandbox period sends fabricated identity data to Tamin's test system rather than the actual doctor/patient's real identifiers — meaning sandbox testing results may not reflect what will happen once real credentials/data are used, and if this code ships unchanged when "real access lands" (per `TODO.md`'s own framing of the risk), it would submit fake data to a live government/insurance system.
- Confidence: HIGH — directly read; explicitly self-flagged in both the code comment and `TODO.md`.
- Recommended action: ensure this is rewritten (not just parameterized) before any production/real-Tamin-API cutover — already the project's own stated plan, not new guidance from this audit.

---

## Finding 4.2 — Five admin-only "Temperory" (sic) debug/test endpoints, live and wired, doing little or nothing

**Location:** `noyanai-back/Controllers/adminController.ts`, each preceded by `//TODO: Temperory` or `//TODO: Temp`: `debug` (returns `{message:"test"}`, contains a commented-out reference to the legacy `OldDoctor` model), `testSip` (manual SIP-connection test trigger), `callUser` (manually places a user-to-user call between two IDs from the request body), `fillUserIdentity` (manually backfills a `UserIdentity` record for a given user), `pod` (a Podium API-key smoke test, just logs and returns `{message:"pod"}`).

All five are wired into `Routers/adminRouter.ts` (`/api/v1/admin/debug`, etc.) and gated by `authController.protect` + `restrictTo("admin")` — confirmed not reachable by anyone below full-admin. `testSip` in particular is very plausibly the concrete code behind `TODO.md`'s cross-cutting item "Resolve telephony test endpoints."

- Classification: confirmed leftover developer-testing code, self-labeled as temporary, admin-gated so not a security exposure — but still live, still occupying route space, and (per Finding 8.5's SIP/ARI note) `testSip` is another data point that the telephony integration was actively being poked at during development and then left half-wired.
- Severity: LOW.
- Confidence: HIGH.

---

## Finding 4.3 — First-party TODO comments that directly corroborate three findings from earlier phases

Recorded here rather than as new findings, since each is the *cause* comment for something already independently confirmed by reading the code's actual behavior:

- `Lib/helpers.ts:59`, directly above `getSessionDateKey`: **`//TODO: this will shift dates across timezones`** — the developer's own flag for exactly the UTC-vs-local date mismatch this audit found independently in `06_DATABASE_DRIFT.md` Finding 6.1 (F-19). This upgrades F-19 from "plausible inferred cause of a TODO.md line" to "the specific function's own author left a comment describing this exact failure mode."
- `Controllers/userController.ts:376` and `:411`, directly above the invoice- and booking-list handlers: **`//TODO: maybe add pagination shit`** / **`//TODO: may be add pagination maybe not`** — the exact two functions `05_CONTRACT_DRIFT.md` Finding 5.2/F-23 flagged as unbounded, with the author's own acknowledgment sitting right above them.
- `Models/Blog.ts:25`: **`//TODO: auto fill author with currently logged in user`** — matches `TODO.md`'s "Auto-fill blog author" line to an exact field.

---

## Finding 4.4 — Even the new booking flow has an acknowledged gap in handling "someone else booked this slot first"

`noyanai-front/Components/Booking/Finalize/FinalizeBookingPage.tsx:589`: **`//TODO: add logic if session is booked`**, sitting directly above the shift/slot-resolution logic on the finalize page. The backend does reject a conflicting `submitBookingNew` call (`Reservation.exists(...)` check, per `07_BUSINESS_LOGIC_DRIFT.md`), but this comment confirms the frontend doesn't yet have specific handling for that rejection on the one page that's supposed to be the new system's canonical booking-confirmation step — a small addendum to Finding 7.1/F-01, on the "new" side of that finding rather than the "old" side.

- Severity: LOW (the backend still enforces the rule; this is a UX gap, not a data-integrity one).
- Confidence: HIGH.

---

## Checked, not flagged further

- The remaining ~85 TODO/FIXME comments across both repos (sampled broadly) are unremarkable in-progress-work markers — missing validation, "hook this up," "calculate this," image-placeholder notes — consistent with normal incremental development rather than any of the suspicious/obvious-placeholder/temporary-code categories this phase specifically looks for. Not itemized individually per audit rule 5 (don't report every marker as a problem).
- No hardcoded production credentials, API keys, or connection strings were found in application source in this pass (the one hardcoded secret found, `"HAJI"`, was already reported in `10_SECURITY_FINDINGS.md` Finding 10.5/F-18 — not re-listed here to avoid duplication).

## Not yet investigated

- No systematic magic-number sweep was run (e.g., unexplained numeric literals for limits/timeouts/thresholds scattered through business logic) — this pass focused on comment markers and known hardcoded-value patterns, not a blanket numeric-literal audit.
- The other ~15 unexamined TODOs in `doctorController.ts` (a 2,800+ line file) beyond the ones already sampled were not individually triaged.
