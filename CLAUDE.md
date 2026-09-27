# NoyanAI: project rules (backend)

Backend (Express + Mongoose) of NoyanAI. The frontend is `aminjn/noyanaitest`, which has the same rules.

## 1. Benchmark against the market leaders first (required)

Before you design or build a feature (booking flow, payments, reminders, telemedicine, e-prescription, AI triage, reviews, and so on), check how the leaders handle it:

| Area | Reference products |
|---|---|
| Booking | Doctolib, Zocdoc, Docplanner, Practo |
| Telemedicine and AI | Teladoc, One Medical, K Health, Ada |
| One app for pharmacy, lab and insurance | Halodoc, Vezeeta, Altibbi, Seha |
| Iranian market | Paziresh24, DrDr, Nobat, Doctoreto, SnappDoctor |

- Ground the comparison in the benchmark report (`docs/market-benchmark.md` in the frontend repo).
- In the PR, say in a few lines which pattern the leaders use and what NoyanAI copies, changes, or does better.
- Keep the Iranian context in mind: Tamin / Salamat e-prescription, SMS OTP, domestic gateways (SEP), and hosting inside Iran (ArvanCloud).

## 2. Code rules
- Every new user-visible text key goes into `contentKeys` in `Models/TextContent.ts`, and into the frontend's 15 message files.
- Error messages are Persian and are translated through `Lib/i18n/errorMessages.ts`. When you add a new message, add its translations there too.
- New public-facing text models: add the `translatable` plugin and their fields to `Lib/i18n/translatableFields.ts`.
- `ADMIN_KEY=notadmin` is intentional: do not change it.
- Before a PR: `npx tsc --noEmit`.

## 3. Deploy
- ArvanCloud server: `bash /root/setup.sh` (source in `deploy/arvan/setup.sh`). It keeps `.env`, the database and generated secrets across re-runs.
