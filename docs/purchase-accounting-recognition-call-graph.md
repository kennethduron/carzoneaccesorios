# Purchase → AP → accounting call graph (origin/main 55a259c)

This document records the versioned implementation as audited before the
purchase-accounting recognition fix. It is intentionally code/schema based;
no production connection was used.

## Purchase save and physical inventory

1. `savePurchaseAction` validates and recomputes the purchase totals in
   `src/app/admin/compras/actions.ts`.
2. It invokes `save_purchase_with_inventory` with canonical item and purchase
   totals.
3. That RPC writes the draft purchase/items and the purchase inventory
   movements. Purchase confirmation does not re-value those movements.

## Purchase confirmation and AP automation

1. `confirmPurchaseAction` checks `purchase_ap_automation_enabled_v1()`.
2. With the flag enabled it calls `confirm_purchase_with_payable_v1` from
   `202608090002_purchase_ap_automation_v1.sql`.
3. The RPC locks the purchase, validates/reuses an active supplier invoice and
   active payable, creates/adopts the payable, optionally calls
   `register_supplier_payment_v2`, confirms the purchase through
   `_confirm_purchase_state_v1`, and records two V1 financial events.
4. `accounts_payable_created` is the canonical economic recognition source.
   `purchase_confirmed` is explicitly an operational control event whose
   snapshot points back to AP recognition to prevent duplicate accounting.
5. The V1 financial-event uniqueness key is
   `(source_type, source_id, event_purpose, posting_version)`.

## Existing AP draft generation

1. `purchase-financial-events.ts` can reconstruct an AP fiscal snapshot from
   supplier invoice, purchase, or purchase items, and uses invoice date before
   purchase date.
2. `journal-draft-generator.ts` accepts `accounts_payable_created`, requires a
   complete fiscal breakdown and HNL, resolves payable/inventory/tax/discount/
   freight mappings, and calls `buildPurchasePayableJournalLines`.
3. The resulting V1 shape is debit purchase inventory/cost, debit recoverable
   tax, debit freight, credit discount, and credit AP; zero optional lines are
   omitted and totals must balance to cents.
4. `dispatchAccountingEvent` only creates a draft immediately when the global
   automation mode is `draft_only`. Purchase confirmation does not dispatch the
   AP event, and the production policy is disabled. Therefore the persisted V1
   AP event is not a durable V2 draft obligation.

## Accounting outbox V2

1. `route_accounting_fact_v2` applies a named feature state/cutover, derives a
   canonical accounting date, and inserts one row into `accounting_outbox_v2`.
2. V2 uniqueness covers both the accounting fact and the stable idempotency
   key, including source, purpose, and posting version.
3. The cron route calls `processDueAccountingOutboxesV2`, which claims due IDs
   and invokes the service-role-only `process_accounting_outbox_v2` RPC.
4. The purchase-recognition specialization creates/reuses one V2 financial
   event and one manual-publication journal draft. Reuse is allowed only through
   `purchase_recognition_validity_v2`: ownership, routing, operational state,
   source-resolved snapshot/date, event identity, balanced journal economics,
   and absence of a competing V1 chain must all be valid.
5. `resolve_canonical_accounting_date_v1` already resolves AP recognition to
   supplier invoice date when present, otherwise `purchases.purchase_date`.

## Supplier payment (preserved economic model)

1. `register_supplier_payment_v2` and
   `register_supplier_multi_payment_v1` persist settlement and route one V2
   `supplier_payment` fact when their feature/cutover permits it.
2. The single-payment worker resolves `default_account:accounts_payable` and a
   configured supplier-payment account, then creates exactly:
   `Dr Accounts Payable / Cr configured payment account` for the payment amount.
3. The multi-invoice path validates applications and recognition dates and
   creates the same aggregate settlement economics. Inventory, purchase tax,
   freight, and purchase discount are absent from payment lines.
4. Recording the supplier payment remains an operational business action. Its
   accounting outbox may be durably queued before recognition is ready, but the
   accounting worker calls the shared purchase-recognition validity gate and
   cannot create or treat a settlement draft as healthy while any V2-owned AP
   recognition is pending, retryable, failed, cancelled, or conflicted. The
   same aggregate check covers every V2 component of a multi-invoice payment;
   historical V1 APs remain outside that requirement.

## Canonical V2 chain validity

1. The accounting date is resolved on every semantic check from
   `supplier_invoices.invoice_date` when a linked active supplier invoice
   exists, otherwise from `purchases.purchase_date`. Both are date-only values.
2. A later supplier-invoice link/date change is not frozen: it makes an older
   snapshot or draft conflict and requires explicit reconciliation. No worker
   overwrites the old date or draft automatically.
3. `completed` with no explicit error and an exact linked event/draft is
   healthy. An exact chain in `queued`, `processing`, or `pending_data` without
   an error is retryable, not healthy; only an explicit worker retry may
   reconcile it. `failed`, `cancelled`, conflict codes, and failed event states
   never satisfy completeness or payment dependencies.
4. Routing instants such as `cutover_at` are normalized to UTC in the semantic
   snapshot. Generation/creation timestamps are excluded, so changing a worker
   timestamp or session timezone does not change accounting equivalence.

## Root cause and narrow insertion point

The atomic `confirm_purchase_with_payable_v1` transaction is the narrowest safe
place to require a prospective AP-recognition outbox obligation. The new V2
purchase-recognition feature must remain disabled by default and must use the
AP source only. New-scope payment routing may be durable, but its worker must
wait until the corresponding purchase-recognition draft is valid; historical
AP/payment behavior must remain outside that gate.
