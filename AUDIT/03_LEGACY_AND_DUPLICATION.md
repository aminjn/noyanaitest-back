# 03 — Legacy & Duplicated Systems

Scope note: this pass followed the concrete leads surfaced in `01_PROJECT_MAP.md` §5, plus one new lead found while investigating them (the prescription item cleanup bug). It is not yet an exhaustive sweep of the whole codebase for duplication — that would need Phase 2's full dependency inventory as a base. Four groups were investigated to the depth the audit instructions ask for (what each does, where used, reachable, can they disagree, evidence of replacement intent, git history). One additional smaller inconsistency was confirmed opportunistically.

---

## Finding 3.1 — First-generation call/socket system is confirmed dead code, superseded by `Services/Call/`

**What each implementation does:**
- `noyanai-back/socket/` (`socket.ts`, `Client.ts`, `Room.ts`, `mediaSoupConfig.ts`, `mediasoup.ts`, `controller/`, `middleware/`): a self-contained socket.io + mediasoup video-room implementation (`initSocket(server, worker)` — join room, get RTP capabilities, create WebRTC transports, produce/consume streams).
- `noyanai-back/Services/Call/` (`CallService.ts`, `CallRuntime.ts`, `callSocket.ts`, `workerPool.ts`, `mediasoupConfig.ts`, `recordingService.ts`, `index.ts`): a more complete call subsystem — REST control-plane (create/list/end/kick/mute/recording/history via `callController.ts`), Mongo-backed durable state (`CallRoom`, `CallParticipant`, `CallRecording`, `CallEvent` models), in-memory live mediasoup state, and server-side recording via ffmpeg.

**Where each is used:** `noyanai-back/server.ts` calls `initCallService(server)` from `Services/Call/index.ts` only. A repo-wide grep for any import of `socket/socket`, `../socket`, or `./socket/*` from outside the `socket/` folder itself returns zero results — nothing in `app.ts`, `server.ts`, or anywhere else references it.

**Reachable:** No. `socket/` is never imported, so `initSocket` is never called and none of its handlers are ever registered on any server instance.

**Evidence of replacement intent:** Confirmed directly, not inferred. `noyanai-back/CALL_SERVICE.md` (the project's own architecture doc for the current call system) states explicitly: *"The old `socket/` folder (mediasoup demo) is untouched and unused - do not import from it."*

**Git history:** `socket/` has 14 commits, the earliest labelled `"added video call"`, `"testing"` ×4, `"fuck sake"`, `"wsl is fucked"` — consistent with an early, exploratory first pass. `Services/Call/` has only 2 commits (`"checkpoint"`, `"preview"`), consistent with being authored later, likely as a single larger commit or squashed history, and it is the one actually wired up.

**Can they disagree / same DB:** N/A for current risk — since `socket/` is unreachable it cannot execute and cannot diverge from `Services/Call/` at runtime. The risk is purely maintenance/onboarding confusion (a future change could accidentally re-wire or copy from the dead folder) and repo bloat, not a live behavioral bug.

- Severity: LOW (confirmed dead, self-documented as such, no runtime risk)
- Confidence: HIGH (no importers found + explicit doc confirmation + git history all agree)
- Recommended action for synthesis: safe removal candidate, but out of scope for this audit to delete (rule 1).

---

## Finding 3.2 — `prescriptionRouter.ts` is an orphaned stub; the real prescription API is wired through `doctorRouter.ts`

**What it does:** `noyanai-back/Routers/prescriptionRouter.ts` imports `prescriptionController`, `aclController`, and `uploadController`, applies `authController.protect` and a debug `console.log("hit")` middleware to every request, and then... defines no routes at all. `export default router` is the entire remainder of the file.

**Where it's mounted:** `app.ts` mounts it at `app.use("/api/v1/presc", prescriptionRouter)`.

**What actually happens at runtime:** Any request to `/api/v1/presc/*` passes `protect` + logs `"hit"`, matches no route inside the router, falls through, and ultimately hits the app-level 404 handler in `app.ts`. None of `prescriptionController`'s 14 exported handlers (`getPrescriptions`, `getPrescription`, `createPrescription`, `editPrescription`, `deletePrescription`, `commitPrescription`, `editTaminPrescription`, `deleteTaminPrescription`, `getVisitPrescriptions`, `newVisitPrescription`, `deleteVisitPrescription`, `getReferralBaseData`, `submitReferralPrescription`, `getReferralPrescriptions`) are reachable through this router.

**Where the real functionality lives:** `noyanai-back/Routers/doctorRouter.ts` imports the same `prescriptionController` and wires all 14 handlers to routes under `/api/v1/doctor/presc/*` (confirmed at doctorRouter.ts lines 781–868). The frontend confirms this is the live path — e.g. `Components/DoctorPanel/Prescription/Edit/DoctorEditPrescriptionPage.tsx` fetches `${API}/doctor/presc/${nodeId}`, not `/presc/...`.

**Git history:** `prescriptionRouter.ts` has exactly one commit in its log (`"moving shit to wsl"`), a bulk-import-style commit — there is no visible history of routes ever being added and later removed from this specific file; it appears to have shipped in this empty/stub state and simply never been finished or deleted.

- Severity: LOW–MEDIUM. Not a live bug (nothing depends on `/api/v1/presc/*`), but it is a real dead route mount with a stray debug `console.log`, and its presence is actively misleading — a reader auditing routers would reasonably assume this is where prescription auth/logic lives.
- Confidence: HIGH (direct code read; router body is fully visible and unambiguous).
- Cross-reference: candidate for `08_DEAD_CODE.md`.

---

## Finding 3.3 — Prescription v1 → v2 migration is real, tracked, and mostly complete on the backend; a leftover v1 reference causes a confirmed data-cleanup bug

**The two systems:**
- v1: `Models/Prescription.ts` (flat `IPrescription` schema, `items`/`labItems` embedded arrays).
- v2: `Models/Prescription/Prescription2.ts` + `Models/Prescription/PrescriptionItem.ts` (items split into a separate collection, referenced by `prescription`) + `Models/Prescription/TaminPrescription2.ts`.

**Where each is used (backend):** `prescriptionController.ts` imports both. Of its 14 handlers, every read/create/delete/commit path (`getPrescriptions`, `getPrescription`, `createPrescription`, `editPrescription`, `deletePrescription`, `commitPrescription`, `editTaminPrescription`, `deleteTaminPrescription`, etc.) operates on `Prescription2`/`PrescriptionItem`/`TaminPrescription2`. The v1 `Prescription` model is referenced exactly **once** anywhere in the controller — as a delete target inside a cleanup helper (see below). It is never created, read, or listed anywhere in current code. This is consistent with the migration being effectively complete on the data-access side, with one leftover reference.

**Where each is used (frontend):** `TODO.md` (dated 2026-08-15) independently lists "Migrate prescription edit to v2," "Migrate prescription print to v2," "Style prescription print PDF," and "Retire prescription v1" as still-open. This matches the code exactly: the **create** page (`app/doctorpanel/prescription/page.tsx`) and **overview** page (`app/doctorpanel/prescription/[nodeId]/page.tsx`) already render the v2 components (`Prescription2/CreatePrescriptionPage`, `Prescription2/Preview/PreviewPrescription2Page`), with their v1 equivalents still imported but commented out of the JSX. The **edit** page and **print** page still render the v1 components (`Prescription/Edit/DoctorEditPrescriptionPage`, `Prescription/Print/PrintPrescriptionPage`). Traced one level deeper: the v1 edit UI itself calls `GET ${API}/doctor/presc/${nodeId}` — the same v2-backed endpoint the v2 overview page uses — so this is a genuinely unmigrated *UI wrapper*, not a UI pointed at a dead backend. Functionally it still works; it's tracked debt, not a live break.

**Confirmed bug — wrong model referenced during item cleanup (`Controllers/prescriptionController.ts:445-462`):**

```ts
const editTaminPrescriptionItemsCleanUp = async ({
  existingItems, incomingItems, prescription,
}: {
  existingItems: IPrescriptionItem[];   // <- typed as v2 PrescriptionItem
  incomingItems: ValidatedItems;
  prescription: IPrescription2;
}) => {
  const toDelete = existingItems.filter(
    (el) => !incomingItems.find((e) => e.service._id.toString() === el.service._id.toString())
  );
  for (let c = 0; c < toDelete.length; c++) {
    await Prescription.findByIdAndDelete(toDelete[c]._id);   // <- deletes from the v1 Prescription collection
  }
  ...
```

`toDelete` is an array of `IPrescriptionItem` (v2) documents — items being removed from a Tamin prescription during an edit. `toDelete[c]._id` is a `PrescriptionItem` ObjectId. But the delete call targets `Prescription` — the unrelated, effectively-retired v1 model — instead of `PrescriptionItem`. This function is called once, at line 706, inside `editTaminPrescription`, the handler behind the doctor's "edit a committed Tamin/insurance prescription" flow.

**Effect:** `Prescription.findByIdAndDelete(<a PrescriptionItem's id>)` queries the v1 `prescriptions` collection for that id. Since the id belongs to a different collection's document, this will essentially always match nothing (ObjectIds are not guaranteed globally unique across collections, but a collision is astronomically unlikely) — the call is a silent no-op. The intended deletion of the removed `PrescriptionItem` document never happens, so it stays in the database still `ref`-ing the same `prescription`. Confirmed downstream impact: `getPrescription` (line 63-80) populates `items` via a `path: "items"` populate that reads from the `PrescriptionItem` collection — so an item a doctor removed during an edit can resurface on the next read, because the deletion silently failed.

- Severity: **HIGH**. Silent data-integrity bug in an insurance/prescription edit flow (removed drug items are not actually removed), no error surfaced to the doctor or logs.
- Confidence: **HIGH**. Directly read the function, its single call site, the type of `existingItems`, and the downstream populate that would surface stale items. Not confirmed against a live database (out of scope / no DB access in this audit), so root-cause is code-certain but real-world data impact (how many prescriptions currently carry orphaned items) is unverified.
- Likely root cause: leftover/copy-paste artifact from the v1→v2 migration — a plausible original version of this helper deleted from the v1 `Prescription`-embedded-items model, and the model reference was never updated to `PrescriptionItem` when the code was restructured around the v2 split collection.
- Cross-reference: also relevant to `07_BUSINESS_LOGIC_DRIFT.md` (prescription editing) and `09_FAILURE_PATHS.md` (silent no-op deletion, no error path).

---

## Finding 3.4 — `Models/Old/*` legacy entity system: reachable, but isolated and behaves as a deliberate, re-runnable migration/ETL tool, not accidental leftover code

**What it is:** Eight legacy Mongoose models (`OldBlog`, `OldDisease`, `OldDrug`, `OldPart`, `OldSymptom`, `oldDoctor`, `oldSpeciality`, `oldUser`) representing a pre-migration data shape for doctors, specialities, blogs, diseases, drugs, body parts, and symptoms.

**Where it's used — two call sites, both admin-gated:**
1. `Routers/oldRouter.ts`, mounted at `/api/v1/old`: read-only (`getAll`/`getOne`) admin-authenticated browsing of the old data, plus create/edit only for `doctor` (via a declarative `map` config). Frontend equivalent exists at `app/[adminKey]/old/*` (blog, disease, doctor, drug, part, speciality, symptom, user) — an admin-only legacy data browser.
2. `Controllers/migrationController.ts` + `Routers/migrationRouter.ts`, mounted at `/api/v1/migrate`, also admin-only: a **one-directional, idempotent import tool**. For each entity type it exposes `POST` (import: read all `Old*` docs, upsert into the corresponding new model keyed by an `old: <old _id>` cross-reference field, so it's safe to re-run), `PUT` (drop: delete new-model docs that came from the old import), `PATCH` (purge: strip the `old` cross-reference field from new-model docs without deleting them), and `DELETE` (drop-all: delete every doc of that new model, migrated or not — the most destructive verb).

**Is the old system still read by any business logic path?** No. A repo-wide grep for the eight `Old*`/`old*` model names outside `Models/Old/`, `Routers/oldRouter.ts`, `Controllers/migrationController.ts`, and `app.ts`'s import list returns nothing. Public-facing doctor/blog/disease/drug/part/speciality/symptom endpoints all read exclusively from the new models.

**Can old and new disagree?** Not through normal use — the old system is never read by anything user-facing, so there is no dual-read path that could diverge. The only way old and new data can interact is the explicit, admin-triggered, one-way `import*` action, which upserts by the `old` foreign key (safe to re-run without duplicating). The `dropAllDoctors`/`dropAllParts`/`dropAllBlogs`/etc. verbs are a genuine operational risk (an admin calling `DELETE /api/v1/migrate/doctor` deletes **every** doctor, not just migrated ones) but that is a Phase 10 (security/safety-of-destructive-endpoint) concern, not a legacy-duplication concern — flagging here for cross-reference only.

- Severity: LOW as a legacy-duplication finding (well-isolated, intentional tool, not reachable from any user-facing path).
- Confidence: HIGH.
- Cross-reference: the `dropAllX` verbs belong in `10_SECURITY_FINDINGS.md` / `09_FAILURE_PATHS.md` as a destructive-endpoint-with-no-confirmation-step concern.

---

## Finding 3.5 — License/module-gating pattern covers 4 of 5 org types; Insurance has no equivalent (likely roadmap gap, not regression)

Doctor, Pharmacy, Clinic, and ParaClinic each have a full license-gating implementation: a `Base*License` admin-managed plan model, a `*ProfileLicense` per-org assignment model, and a frontend `*LicenseGate` component (`DoctorLicenseGate.tsx`, `PharmacyLicenseGate.tsx`, `ClinicLicenseGate.tsx`, `ParaClinicLicenseGate.tsx`). Insurance has neither a `BaseInsuranceLicense` model nor an `InsuranceLicenseGate` component — confirmed absent via search, not just unlinked.

This reads as a build-order gap rather than an inconsistency bug: `TODO.md` independently lists the insurance panel as the least-built org panel ("Build home dashboard," "Define insurance business features," "Build claims review," "Build plan management," "Build doctor network view" all open, plus an explicit open question "Insurance: what features needed?"). It would be premature to gate a feature set that hasn't been defined yet.

- Severity: LOW (documented as pending work, not a discovered defect).
- Confidence: MEDIUM — confirms absence of the pattern, but the *reason* (deprioritized vs. forgotten) is inferred from TODO.md, not from a direct statement of intent.
- Cross-reference: worth re-checking in `07_BUSINESS_LOGIC_DRIFT.md` if/when insurance licensing is ever discussed, since the skill this project uses for replicating the license pattern (`noyan-org-licensing`) explicitly generalizes to "any other org type."

---

## Minor / low-priority observation

- **ACL model naming casing is inconsistent**: `DoctorAcl.ts`, `InsuranceAcl.ts`, `ParaClinicAcl.ts` (PascalCase file names) vs. `clinicAcl.ts`, `pharmacyAcl.ts` (camelCase). Cosmetic; no evidence of functional impact found. Not investigated further — flagged for completeness only, per audit rule 5 (don't over-weight style-only findings).

---

## Not yet investigated (candidates for a future pass)

- Full sweep for duplicated *utility* functions (date/timezone handling, validation, slug generation) across `Lib/` vs. per-controller inline logic — TODO.md's "Fix timezone shift bug" suggests this is worth a dedicated look.
- Whether `Models/Bot/` and the `/wizard` (Ollama-backed AI chat) subsystem has any old/new split, not yet examined.
- Whether the ACL pattern itself (`aclController.ts`, `nodesWithAcl`) has diverged per-org-type in ways that matter (deferred to `07_BUSINESS_LOGIC_DRIFT.md`, since this is about behavioral consistency of a single system rather than two competing systems).
