# 02 — Dependency / Symbol Inventory

**Method note:** an automated circular-dependency tool (`madge`) was attempted but the sandbox this audit ran in has no outbound npm registry access (`npm error 403 ... registry.npmjs.org`). This phase is therefore a targeted manual check — largest files by line count, and explicit `grep`-based verification of import direction between architectural layers (Models/Lib/Controllers/Routers on the backend; Components/app on the frontend) — not an exhaustive, tool-verified dependency graph. Route/controller/model counts are carried over from `01_PROJECT_MAP.md` rather than re-derived.

---

## Largest modules

### Backend

| File | Lines | Character |
|---|---|---|
| `Lib/Cities.ts` | 6,721 | Static geographic reference data (city list) — not logic, not a coupling concern |
| `Controllers/publicController.ts` | 3,632 | **Genuine god-module**: every public-facing read endpoint (doctors, blogs, diseases, drugs, clinics, hospitals, para-clinics, tests, specialities, symptoms, and more) lives in one file |
| `Controllers/doctorController.ts` | 3,505 | **Genuine god-module**: sessions, schedule, prescriptions-adjacent logic, Tamin submission, patient records, and more all in one file |
| `Models/TextContent.ts` | 1,542 | Large but plausibly legitimate — backs the content-key system covering every namespace in the app |
| `Routers/autoRouter.ts` | 1,401 | Declarative map of ~90 admin-managed entity types (per `03_LEGACY_AND_DUPLICATION.md`'s reference to the same pattern in `oldRouter.ts`) — long by repetition, not by complexity |
| `Controllers/pharmacyController.ts` | 1,205 | |
| `Controllers/prescriptionController.ts` | 1,196 | Already the subject of `03_LEGACY_AND_DUPLICATION.md` Finding 3.3 |
| `Services/Call/CallService.ts` | 1,031 | Documented in `CALL_SERVICE.md` as "the service — all business logic" for calls; large by design, not by accident |

### Frontend

| File | Lines | Character |
|---|---|---|
| `Components/Enums/Cities.ts` | 6,732 | Same static city data, front-end copy |
| `Components/Home/HomeHeroBg.tsx` | 3,655 | **Not a logic concern** — confirmed to be a single raw Figma-exported SVG (212 `<path>` elements, `data-figma-skip-parse` markers), i.e. a large decorative asset checked in as a component, not a large component |
| `Components/Enums/contentNamespaces.tsx` | 1,701 | Namespace-to-key mapping for the content-key system — long by enumeration, matches backend's `TextContent.ts` in spirit |
| `Components/Enums/contentKeys.tsx` | 1,518 | The canonical content-key registry — same |
| `Components/Call/CallClient.ts` | 864 | |
| `Components/Booking/Finalize/FinalizeBookingPage.tsx` | 827 | The new booking flow's confirmation page — see `07_BUSINESS_LOGIC_DRIFT.md`/F-01 |

**Reading:** `publicController.ts` and `doctorController.ts` are the two real "too much in one file" candidates on the backend — both mixing many unrelated read/write responsibilities. Everything else large is either static data, a generated asset, or a declarative table that's long because it enumerates many entities, not because any single piece of logic is complex.

---

## Finding 2.1 — Confirmed source-level circular dependency: `Models/Secretary.ts` ↔ `Controllers/aclController.ts`

```ts
// Models/Secretary.ts
import { NodeWithAcl } from "../Controllers/aclController";   // Model → Controller

// Controllers/aclController.ts
import Secretary, {
  SecretaryAclPath, SecretaryNodePath, nodesWithAclToSecreataryAclPathDict,
} from "../Models/Secretary";                                  // Controller → Model (the Mongoose model itself, a runtime value)
```

Both directions are confirmed by direct read. `Secretary.ts`'s import of `NodeWithAcl` is used only in a type position; `aclController.ts`'s import of `Secretary` is the actual Mongoose model (a runtime value), not just a type. Whether this manifests as an actual circular `require`/ES-module load at runtime depends on whether TypeScript's compiler elides the type-only half during transpilation — plausible, but not confirmed (no build was run in this audit; `noyanai-back/tsconfig.json` has `isolatedModules: true`, which makes cross-file type-only elision less certain than it would be under full-program type-checking). Independent of that runtime question, this is a real, confirmed architectural layering inversion at the source level: a data model depends on a controller.

- Severity: LOW-MEDIUM (an architecture smell with unconfirmed runtime impact — could be entirely harmless if elided, or a genuine circular module load if not).
- Confidence: HIGH on the source-level cycle; LOW-MEDIUM on whether it manifests at runtime (would need to run the actual build/compile, which this audit didn't do).
- Recommended action: move `NodeWithAcl` (or the broader ACL node-name type) into `Lib/enums.ts` or a similar foundational module both `Models/Secretary.ts` and `Controllers/aclController.ts` can import from without depending on each other.

---

## Finding 2.2 — Two smaller, non-circular but backwards dependency directions

- **`Models/Notification.ts` → `Services/pushNotificationService.ts`**: a data model imports a service function (`sendPushToUser`) to fire push notifications from a Mongoose save/insertMany hook — confirmed intentional (matches prior session memory of this exact wiring) and confirmed *not* circular (`pushNotificationService.ts` does not import `Notification` back). A deliberate design choice, not an accident — Models normally shouldn't reach into Services, but the alternative (every caller remembering to trigger the push separately) is also a legitimate trade-off. Recorded as an architecture note, not a defect.
- **`Lib/Podium.ts` → `Controllers/authController.ts`**: imports four response-shape types (`PodiumReponse`, `PodiumIdentityInfo`, `IdentityResponse`, `MatchNationalIdAndPhoneNumberResponse`) that are defined at the bottom of `authController.ts` but conceptually belong to `Podium.ts` (the actual Podium API client). Confirmed not circular. A minor code-organization issue — those types would more naturally live in `Podium.ts` itself or a shared types module.

- Severity: LOW for both.
- Confidence: HIGH.

---

## Finding 2.3 — Frontend Components routinely import prop types from their corresponding `app/` page files

Three confirmed instances (`Components/Admin/UI/CheckAdminKey.tsx` ← `app/[adminKey]/page.tsx`; `Components/Doctor/DoctorsListPage.tsx` ← `app/doctors/[page]/page.tsx`; `Components/Store/LocaleContext.tsx` ← `app/layout.tsx`), all type-only imports. This is the frontend mirror of the backend's `Lib/Podium.ts` situation: a component depends on the page that renders it for its prop-type definition, rather than the type living in the component's own file or a shared types module. Given `app/` pages are meant to be thin wrappers around `Components/*` (per the structural pattern in `01_PROJECT_MAP.md`), this is a consistent, repeated instance of the "wrong direction" dependency, not a one-off.

- Severity: LOW (type-only, no runtime circularity, and TypeScript's own compiler handles this fine) — recorded because it's a repeated pattern worth a consistent fix if the team ever formalizes a layering rule, not because it's currently causing any problem.
- Confidence: HIGH for the three confirmed instances; not swept exhaustively across all ~1,500 frontend files, so the true count is likely higher.

---

## Not yet investigated

- No tool-verified circular-dependency graph could be produced (network-restricted sandbox, see method note above) — the findings above are targeted manual checks of specific suspicious pairs, not a full graph traversal. A future pass with registry access should run `madge --circular` (or equivalent) across both repos for a complete answer.
- No duplicated-utility-function sweep was run (e.g., comparing `Lib/helpers.ts`, `Lib/dateUtils.ts`, and any per-controller inline date/string helpers for near-duplicate logic) — flagged as a candidate in `03_LEGACY_AND_DUPLICATION.md`'s "not yet investigated" section and still open.
- No dead-export sweep (TypeScript/ESLint unused-exports tooling) was run; `08_DEAD_CODE.md`'s findings all came from following specific leads, not a blanket unused-export scan.
- Full React component/hook inventory (props, state stores, custom hooks) was not built — this phase prioritized dependency-direction and module-size checks over a complete symbol catalog, given the size of the codebase (~1,800 source files combined) and the time available.
