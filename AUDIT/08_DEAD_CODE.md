# 08 — Dead / Orphaned Systems

This phase consolidates dead/orphaned findings already surfaced in earlier phases (cross-referenced, not re-derived) and adds new ones from a dedicated sweep of both repos.

---

## Consolidated from earlier phases

| Item | Status | Source |
|---|---|---|
| `noyanai-back/socket/` (first-gen mediasoup/socket.io demo) | Confirmed dead — zero importers, explicitly documented as unused in `CALL_SERVICE.md` | `03_LEGACY_AND_DUPLICATION.md` Finding 3.1 |
| `Routers/prescriptionRouter.ts` mounted at `/api/v1/presc` | Orphaned stub — defines no routes, real API lives at `/api/v1/doctor/presc/*` | `03_LEGACY_AND_DUPLICATION.md` Finding 3.2 |
| `Components/DoctorPanel/Prescription/Create/DoctorCreatePrescriptionPage`, `.../Overview/PrescriptionOverviewPage` | Imported but commented out of JSX on the create/overview pages (v2 components render instead) — dead imports, not fully dead files (still used by other, unmigrated pages — see below) | `03_LEGACY_AND_DUPLICATION.md` Finding 3.3 |
| `Models/Old/*` (8 models) + `Routers/oldRouter.ts` + `Controllers/migrationController.ts` | Reachable, not dead — deliberate admin-only legacy browser/migration tool | `03_LEGACY_AND_DUPLICATION.md` Finding 3.4 |

---

## New findings from this pass

### 8.1 — `app/book/page/[page]/page.tsx` (old paginated booking list): unlinked from the live UI, but still routable, and self-documented as probably dead

No page or component in the current app tree links to `/book/page/[page]` — confirmed via a repo-wide search for the literal path. The one place it's mentioned is a comment the project itself left in `Components/Enums/contentNamespaces.tsx`:

> `// app/book/page/[page]/page.tsx (BookingPage) — the older/simpler paginated booking list. app/book/page.tsx no longer renders this component (it imports BookingPage but only uses BookingPage2), so this route may be dead; still scoped it since it's reachable.`

This is a direct, first-party confirmation of exactly the kind of finding this audit looks for, and it sharpens Finding 7.1 (`07_BUSINESS_LOGIC_DRIFT.md`): this route renders `Components/Booking/BookingPage.tsx`, which itself renders `DoctorCardWithSessions` — the same component that drives the *old* invoice-based booking flow (`SelectSessionToReservePopup` → `/booking/book`) on the main `/doctors` directory page. So this isn't just an orphaned page; it's a third, currently-unlinked-but-still-functional entry point into the old booking system, alongside the two actively-linked ones found in Phase 7 (`/doctors` directory, and `/dr/[slug]` via `PublicDrIntro` → `PublicDrSessions`, confirmed by import trace this pass).

- Severity: LOW as a dead-code item on its own (unlinked, low discoverability), but reinforces 7.1's severity as one more live surface for the old booking flow.
- Confidence: HIGH — both the "unlinked" claim (searched) and the "renders the old flow" claim (traced) are directly confirmed, plus first-party corroboration in the comment itself.

### 8.2 — `Components/DoctorPanel/_Stub/*`: named as stubs, and they are — confirmed placeholder pages live in production

The directory name `_Stub` turned out to be literal, not just a naming convention. `DoctorManageChatsPage.tsx` (backing the live `/doctorpanel/chat` route) is, in its entirety:

```tsx
const DoctorManageChats = () => {
  ...
  return <p>DoctorManageChat</p>;
};
```

Six live doctor-panel routes (`chat`, `discount`, `document`, `finance`, `license`, `offer`) render components from this `_Stub` directory (the `license` one is more substantial — it's shared with `PharmacyPanel/License` and includes a real `PurchaseLicensePopup`, so not all six are as bare as the chat example; the other five weren't individually re-verified for content, just confirmed to import from `_Stub`). This matches `TODO.md`'s Doctor-panel section exactly: "Build chat page," "Build discount page," "Build document page," "Build finance page," "Build offer page" are all listed as open work. This is confirmed, tracked, known placeholder code — not a surprise finding, but recorded here as the concrete evidence behind those TODO lines, per audit rule 6 (distinguish confirmed problems from suspicions, and this is about as confirmed as it gets).

- Severity: LOW (self-labeled, tracked in `TODO.md`, not misleading anyone who reads the code).
- Confidence: HIGH.

### 8.3 — `_to_delete/` and `_to_delete_tsconfig.scoped.json` (frontend root)

Contents: `tsconfig.wizard.json`, `tsconfig.wizard2.json` — scoped TypeScript configs, presumably superseded by the `.tsbuildinfo` files of the same names still present at the repo root (`tsconfig.wizard.tsbuildinfo`, `tsconfig.wizard2.tsbuildinfo`), which per prior session memory were used to work around a `tsc --noResolve` scoped-typecheck quirk. Self-named for removal; not imported or referenced by any build script (`package.json`'s `build`/`dev`/`lint` scripts only reference the root `tsconfig.json`). Confirmed inert, not re-verified beyond that in this pass.

- Severity: LOW (already flagged for deletion by the project owner; audit rule 1 prohibits performing the deletion here).
- Confidence: MEDIUM (didn't verify no build tooling references these paths by exact name outside `package.json`'s own scripts).

### 8.4 — `Controllers/deleteme/` (backend)

An empty directory (confirmed no files inside), self-named for removal, not imported anywhere (nothing to import — it's empty). Included for completeness only.

- Severity: trivial.
- Confidence: HIGH.

### 8.5 — ARI/SIP telephony: package present, types declared, only call site fully commented out

Cross-referencing `01_PROJECT_MAP.md` §5.2: `ari-client` is a real `package.json` dependency, imported in `server.ts`, with SIP-related fields still present on the `Reservation` model (`sipBridgeId`, `sipDoctorChannelId`, `sipPatientChannelId`) and a `Lib/sipService.ts` file. The one place that would actually open an ARI connection (`listenForCall` in `server.ts`) is entirely commented out. `TODO.md` independently lists "Resolve telephony test endpoints" and "Delete leftover SIP config" as open cross-cutting work, and `Reservation.ts`'s own status-machine comments reference "sipCall" as a `sessionType` still modeled as first-class (not itself dead — `sessionType: doctorSessionTypes` includes `sipCall`, and `Lib/sipService.ts` is referenced from `bookingController.ts`'s settings dictionary). So this is a more nuanced case than "fully dead": the *data model and per-session-type plumbing* for SIP calls appears live and intended, while the specific *inbound ARI listener bootstrap* in `server.ts` is the dead/disabled piece. Not re-traced further in this pass (would need to check `Lib/sipService.ts` and `originateSipCall` — referenced in `reservationActivationService.ts` — to determine whether outbound SIP call origination is live even though the inbound `listenForCall` bootstrap is not).

- Severity: LOW as dead code specifically (the disabled piece is small and isolated); flagged mainly to avoid the false conclusion that "SIP/telephony is entirely unused," which the commented-out `listenForCall` alone might suggest.
- Confidence: MEDIUM — the disabled bootstrap is certain; whether the rest of the SIP plumbing is fully live wasn't traced end-to-end this pass.

---

## Not yet investigated (candidates for a future pass)

- No systematic unused-npm-dependency check was run against either `package.json` (e.g. confirming every listed dependency is actually imported somewhere) — this pass only followed specific named leads.
- No systematic unused-export sweep (e.g. a TypeScript/ESLint unused-exports tool) was run across either repo; all findings here came from targeted greps following specific leads from earlier phases, not an exhaustive pass.
- Backend `Models/Bot/`, `Models/Geo/` namespaces (noted in `01_PROJECT_MAP.md`) were not checked for dead code this pass.
- Whether any of the ~28 backend routers have individual route handlers that are wired but never called from any frontend code (the mirror image of Finding 3.2, but for individual routes rather than a whole router) was not swept exhaustively.
