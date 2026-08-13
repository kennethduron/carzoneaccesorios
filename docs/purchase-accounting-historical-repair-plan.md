# Future historical purchase-accounting repair plan

Status: design only. Execution is not authorized by this change.

The five previously identified historical purchase/AP candidates remain outside
the prospective `purchase_recognition_draft_v2` cutover. No candidate identifier,
outbox row, accounting event, draft, payment, inventory movement, accounting date,
or feature flag is changed by this implementation.

For each of the five candidates, a separately authorized repair run must complete
the following checklist independently and retain its evidence:

1. Perform a read-only preflight and confirm the purchase, supplier invoice,
   payable, inventory movement, and payment state.
2. Resolve the canonical accounting date from the supplier invoice date when
   present, otherwise from `purchase.purchase_date`.
3. Verify the canonical date's accounting period is open; do not substitute a
   later date when it is closed.
4. Search for duplicate automated drafts and any manual journal that may already
   recognize the purchase obligation.
5. Validate the immutable purchase/fiscal snapshot and reconcile the inventory
   product subtotal, recoverable tax, freight, discount, and payable total.
6. Reconcile all existing supplier-payment accounting without modifying or
   duplicating its Dr Accounts Payable / Cr payment-account entries.
7. Assign and preflight a deterministic, candidate-specific idempotency key using
   the canonical AP source, purchase-recognition purpose, and repair version.
8. Produce a read-only preview of the exact balanced lines, mappings, date, and
   source identity for accounting review.
9. Only after independent owner/accounting authorization, generate a draft-only
   repair through a dedicated controlled operation. Never auto-publish it.
10. Require human/accounting comparison of the preview, supporting documents,
    inventory reconciliation, tax treatment, and existing payment journals.
11. Publish manually through the existing accounting workflow only under a
    further explicit approval and with retained audit evidence.

The repair procedure must stop for a closed period, unsupported currency,
missing mapping, unknown line classification, snapshot mismatch, amount mismatch,
or possible duplicate/manual recognition. It must not reuse the prospective
cutover as an implicit backfill mechanism.
