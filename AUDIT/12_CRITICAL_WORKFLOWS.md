# 12 — Cross-System Workflow Audit

`07_BUSINESS_LOGIC_DRIFT.md` already traced the doctor-booking workflow end-to-end (UI → API → availability calculation → doctor schedule view), producing this audit's single largest finding (F-01). This phase traces a second full workflow — product/service order fulfillment — chosen because it spans the same UI → state → API → controller → database → notification layers the audit brief asks for, and because it involves the same three-org-type pattern (pharmacy/doctor/para-clinic) that showed real drift in the booking case, making it a natural comparison point.

```
Cart UI (Components/Cart/*)
  → CartCheckoutPopup → POST /api/v1/cart/submit
    → CartController.submitCart: wallet debit → Order.create → Transaction.create
      → Order document (multi-seller: products/productPackages/services/servicePackages/tests,
         each line item independently owned by a pharmacy/doctor/paraClinic)
Seller UI (*panel/order/[nodeId])
  → GET .../order/[nodeId] → {pharmacy,doctor,paraClinic}Controller.getMyIncomingOrder
  → seller marks an item fulfilled/cancelled → POST .../order/[nodeId]
    → {pharmacy,doctor,paraClinic}Controller.mutateIncomingOrderItem
      → Order.<model>.$.status updated in place
Buyer UI (dashboard/order/[nodeId])
  → GET .../order/[nodeId] → reads the same Order document, sees per-item status
```

---

## Finding 12.1 (positive) — Order-item fulfillment is implemented consistently across all three seller org types, in contrast to the booking split

`mutateIncomingOrderItem` exists once per seller controller (`pharmacyController.ts`, `doctorController.ts`, `paraClinicController.ts`), and all three:
- share the same function name and the same `mutateIncomingOrderItemSchema` shape (`status: z.enum(["fulfilled", "cancelled"])` — identically restricted in all three, not looser in any one of them);
- use the same ownership-scoping helper pattern (`getMyIncomingOrderOwnedIds`) to guarantee a seller can only mutate its own line items within a shared, multi-seller order;
- use the same `Order.findOneAndUpdate({_id, "<model>.item": itemId}, {$set: {"<model>.$.status": status}})` positional-update pattern;
- correctly adapt to each org type's actual item-model count (pharmacy/doctor each own two item arrays — products/productPackages and services/servicePackages respectively — paraClinic owns exactly one, `tests`, and its schema/comment correctly reflects that rather than carrying dead unused branches).

This is a genuine, confirmed example of the "same business rule, replicated correctly across org types" outcome the audit brief holds up as the goal — worth recording explicitly as a positive per audit rule 6, and as a useful contrast: this codebase is capable of clean multi-org consistency when the three implementations are built together in one deliberate pass (per prior session memory, this was a single 2026-08 build), unlike the booking system's split, which happened across two rollouts roughly 11 months apart (`11_GIT_ARCHAEOLOGY.md`).

- Confidence: HIGH (all three implementations read in full and compared line-by-line).

---

## Finding 12.2 — No seller payout exists anywhere in the order/cart workflow

Traced the full money path: `CartController.ts`'s checkout debits the buyer's wallet and creates `Order`/`Transaction` records (already covered for its debit-before-create ordering risk in `09_FAILURE_PATHS.md` Finding 9.1/F-03). Searched `CartController.ts` for any corresponding credit to a seller's wallet — none found. Searched all three `mutateIncomingOrderItem` implementations for the same — none found; marking an item "fulfilled" only changes its status field, nothing else.

**Contrast with the booking/reservation workflow**, which this audit already traced in full: `Services/reservationProgressService.ts:handleReservationSuccess` *does* credit the doctor's wallet when a session completes, and does so with an explicit, verified idempotency guard (`09_FAILURE_PATHS.md`'s "checked, no issue found" section). No equivalent function exists anywhere in the order-fulfillment path for pharmacy/doctor/para-clinic sellers.

**Reading:** this isn't a bug in the sense of incorrect behavior — it's an absent feature. It's consistent with, and likely explained by, Finding 7.2/F-06 (commission/finance-settings models built but never applied): if commission math isn't wired into any money-movement path yet, a seller-payout step has nothing to subtract commission from, so it makes sense neither exists yet. Recorded as its own finding because "sellers are never paid for filled orders" is a more complete/severe way to state the gap than "commission isn't calculated" — the order-fulfillment workflow trace makes that concrete in a way the model-search in Finding 7.2 alone didn't.

- Severity: MEDIUM (a real product-completeness gap on a workflow that already moves buyer money — but not a data-integrity bug, and very plausibly just not-yet-built rather than broken).
- Confidence: HIGH on the absence; the "why" (sequencing/priority, not a discovered defect) is inferred, consistent with Finding 7.2's own framing.
- Recommended action: build seller payout as part of whatever work eventually wires up commission/finance-settings application (F-06), rather than as a separate effort — they're the same missing piece viewed from the buyer-debit side (F-06) versus the seller-credit side (this finding).

---

## Finding 12.3 — No notification fires when a seller changes an order item's status

Neither `mutateIncomingOrderItem` (all three org types) nor the `Order` model itself (no Mongoose hooks found on `Order.ts`, unlike `Notification.ts`'s confirmed save-hook wiring to push notifications per `02_DEPENDENCY_ANALYSIS.md` Finding 2.2) triggers a `Notification.create(...)` or push notification when a seller fulfills or cancels an item. A buyer finds out their order status changed only by revisiting the order detail page themselves.

- Severity: LOW-MEDIUM (a UX completeness gap on an otherwise-working workflow, not a correctness issue).
- Confidence: MEDIUM — confirmed absent in the three fulfillment functions and the `Order` model directly; did not exhaustively check every code path that touches an `Order` document for a notification trigger elsewhere (e.g. a cron sweep analogous to the reservation lifecycle jobs) — no such sweep was found referencing `Order` in this pass, but that search wasn't as exhaustive as the fulfillment-function read.

---

## Not yet investigated

- The call/video workflow (mediasoup signaling → `CallRuntime` in-memory state → `CallRoom`/`CallParticipant`/`CallRecording` persistence → recording pipeline) was not traced end-to-end this pass, despite being flagged as architecturally interesting in `01_PROJECT_MAP.md` and `06_DATABASE_DRIFT.md`. It's the other clear candidate for a full Phase 12 trace and was not reached given the time available in this audit.
- The Tamin/insurance prescription submission workflow (already touched on in `03_LEGACY_AND_DUPLICATION.md`, `04_HARDCODING_AND_PLACEHOLDERS.md`, and `09_FAILURE_PATHS.md` for specific bugs within it) was not traced as a complete UI-to-external-API-and-back workflow — only specific functions within it were examined.
- The secretary/ACL delegation workflow (a secretary acting on behalf of a doctor/clinic/pharmacy/paraClinic/insurance) referenced in prior session memory was not traced this pass.
