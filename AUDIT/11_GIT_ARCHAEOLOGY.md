# 11 — Git Archaeology

Both repos are compact (50 commits front, 49 back) covering 2025-07-10 through 2026-09-02 — about 14 months, with long silent gaps (e.g. back: 2025-12-13 → 2026-02-09, a ~2-month gap; 2026-02-24 → 2026-05-11, a ~2.5-month gap) between bursts of dense same-day activity. History is linear on `master` in both repos, no merge commits, no `revert` commits found in either (searched `--all`). Commit messages are informal (`"oops"`, `"testing"`, `"fuck sake"`, `"wsl is fucked"`) but the *dates* and *diffs* are reliable evidence even where the messages aren't descriptive. This phase focuses on dating the two migrations already found (booking, prescription) and confirming/refuting whether "old" code has kept receiving fixes.

---

## 11.1 — The new booking system (`Reservation`) is genuinely new: introduced 2026-07-11, about 8 weeks before this audit, in one coordinated front+back rollout

| File | First introduced |
|---|---|
| `noyanai-back/Models/Booking.ts` | 2025-08-21 (`"stage"`) |
| `noyanai-back/Models/DoctorSession.ts` | 2025-08-21 (`"stage"`) |
| `noyanai-front/Components/Booking/SelectSessionToReservePopup.tsx` | 2025-09-03 (`"text chat complete"`) |
| `noyanai-back/Models/Reservation.ts` | **2026-07-11** (`"backup"`) |
| `noyanai-back/Controllers/bookingController.ts:submitBookingNew` | **2026-07-11**, same commit |
| `noyanai-front/Components/Booking/BookingSessionSelectorPopup.tsx` | **2026-07-11**, same day |
| `noyanai-front/Components/Booking/BookingPage2.tsx` | 2026-06-06 (5 weeks earlier — built ahead of the flow it would eventually host) |
| `noyanai-back/Models/CallRoom.ts`'s `reservation` field (vs. the model itself, from 2025-09-16) | 2026-08-17 (`"before"`) |

**Reading:** the old booking system (`Booking`/`DoctorSession`) is about a year old, present essentially since the project's early "stage" commits. The new system (`Reservation`) landed as a single coordinated push across both repos on **2026-07-11** — the backend model, the new controller function, and the new frontend popup component all trace to the same date. This is corroborating evidence, not new risk: it explains *why* Finding 7.1/F-01 exists (the new system had 8 weeks to reach every corner of the old one before this audit, and it plausibly hasn't yet) without excusing the fact that production has been running with the seam for that whole window.

**Confirmed: the old flow has received zero fixes since the new flow shipped.** `Controllers/bookingController.ts` had 3 further commits after 2026-07-11 (`2026-08-16`, `2026-08-17`, `2026-08-24`); none of their diffs touch `submitABooking` at all (checked directly, 0 matches each). The function has been left exactly as it was when the new system was introduced — a frozen, unmaintained, but still-live and still-linked-to code path, matching Phase 11's own "old systems that still receive fixes" check with a negative result on the *fixes* half (it doesn't) and a positive result on *still live* (it does — see `07_BUSINESS_LOGIC_DRIFT.md`/`08_DEAD_CODE.md`).

- Confidence: HIGH — all dates and diff contents directly read from git.

---

## 11.2 — The prescription v1→v2 migration has been running for ~7 months as of this audit, longer than the entire booking-system gap

| Event | Date |
|---|---|
| `Models/Prescription.ts` (v1) introduced | 2025-12-13 (`"testing"`) |
| `"start of remaking prescription"` commit (both repos, same message) | 2026-02-24 |
| `cd5b224 "moving shit to wsl"` bulk-import/squash commit — `prescriptionController.ts`, `prescriptionRouter.ts`, `Models/Prescription/Prescription2.ts` all first appear here (their true individual introduction dates are lost to this squash) | 2026-05-11 |
| This audit | 2026-09-03 |

**Reading:** v1 existed alone for about 2.5 months before the "start of remaking prescription" commit kicked off the v2 rebuild on 2026-02-24. As of this audit (2026-09-03), that's **~6.5 months** of an in-progress migration — longer-lived than the booking-system gap (11.1), and, per `03_LEGACY_AND_DUPLICATION.md` Finding 3.3, still incomplete (edit/print pages unmigrated on the frontend). Unlike the booking split, this one *is* self-acknowledged in `TODO.md` ("Migrate prescription edit to v2," "Migrate prescription print to v2," "Retire prescription v1") — so this is confirmed, tracked, known-long-running debt, not a surprise. Recorded here mainly to give it a concrete duration, which `TODO.md` itself doesn't state.

- Confidence: MEDIUM-HIGH — the 2025-12-13 and 2026-02-24 dates are directly read; the exact sequence of individual file introductions between 2026-02-24 and 2026-05-11 is obscured by the squash commit, so "how much was built when" within that window isn't recoverable from this repo's history.

---

## 11.3 — `_Stub` doctor-panel pages are over a year old, not a recent gap

`Components/DoctorPanel/_Stub/DoctorManageChatsPage.tsx` (and, by directory, its siblings) traces to **2025-08-05** (`"staging Clinic"`) — meaning the placeholder pages flagged in `08_DEAD_CODE.md` Finding 8.2 have been live, unbuilt, in this state for over 13 months as of the audit date, not a few weeks. This doesn't change the finding's severity (still LOW, still tracked in `TODO.md`), but it's useful context: these aren't freshly-stubbed pages waiting on an imminent follow-up commit, they're long-settled low-priority backlog.

- Confidence: HIGH.

---

## 11.4 — No revert commits, no repeated-regression hot spots found in the files this audit examined

A search for `revert` (case-insensitive) across the full history of both repos (`git log --all`) returned zero matches. This doesn't rule out a revert-without-saying-so-in-the-message, but combined with the linear, no-merge-commit history, there's no structural evidence of abandoned/reverted implementations among the files this audit looked at. Not exhaustive — this audit's file selection was driven by leads from Phases 3/6/7/8/9/10, not a full repo scan, so this is a "checked the files we looked at" result, not a repo-wide clearance.

---

## Not yet investigated

- No systematic "which files are modified most often" hot-spot analysis was run across either full repo — this phase followed specific files already implicated by earlier findings rather than mining broadly.
- The exact contents of the `cd5b224 "moving shit to wsl"` squash commit (which introduced `prescriptionController.ts`, `prescriptionRouter.ts`, `Prescription2.ts`, and the entire `Services/Call/` rebuild in one shot per `03_LEGACY_AND_DUPLICATION.md`) were not diffed in full — only specific files' presence/absence was checked. A full diff of that commit would likely surface more context on the call-service rebuild's origin.
- Author history wasn't examined (both repos show a single committer, `HajAbdolblack`, for every commit checked — consistent with a solo/small-team project, not independently verified across the full log).
