import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertCatalogUnchanged, catalogFingerprint, classifyDatabaseRelation, createCatalogSnapshot,
} from "../src/lib/backups/v2/index.ts";

const fixture = JSON.parse(await readFile(new URL("./fixtures/backup-v2-catalog.synthetic.json", import.meta.url)));
const classified = fixture.map(classifyDatabaseRelation);
assert.equal(classified.find(({ relationName }) => relationName === "products").classification, "required_backup");
assert.equal(classified.find(({ relationName }) => relationName === "accounting_balance_view").classification, "reconstructable");
const excluded = classified.find(({ relationName }) => relationName === "rate_limits");
assert.equal(excluded.classification, "exclude_with_justification");
assert.ok(excluded.classificationReason.length > 20);
assert.equal(classified.find(({ relationName }) => relationName === "backup_v2_runs").classification, "metadata_only");
const discoveredAt = "2026-08-14T12:00:00.000Z";
function relation(relationName, relationKind = "base_table") {
  return { schemaName: "public", relationName, relationKind, estimatedRows: "0", totalBytes: "0",
    tableBytes: "0", indexBytes: "0", discoveredAt, evidenceOrigin: "synthetic_fixture" };
}
for (const critical of [
  "products", "product_images", "inventory_movements", "inventory_adjustments", "customers", "users",
  "customer_identity_values", "crm_notes", "crm_followups", "orders", "order_items", "payments", "invoices",
  "invoice_items", "fiscal_invoice_requests_v2", "purchases", "purchase_items", "purchase_returns",
  "accounts_payable", "accounts_receivable", "supplier_payments", "suppliers", "journal_entries",
  "journal_entry_lines", "financial_events", "accounting_outbox_v2", "pos_sale_drafts",
  "pos_idempotency_requests", "roles", "accounting_feature_flags", "company_settings", "audit_logs",
  "backup_runs", "backup_logs", "operational_backup_checks", "wholesale_codes", "customer_credit_accounts",
]) assert.equal(classifyDatabaseRelation(relation(critical)).classification, "required_backup", critical);
for (const unknown of [relation("new_business_module"), relation("future_sales_state"),
  relation("unknown_kind", "partitioned_future_kind")]) {
  assert.equal(classifyDatabaseRelation(unknown).classification, "review_required");
}
assert.equal(classifyDatabaseRelation(relation("snapshot", "materialized_view")).classification, "review_required");

const fingerprint = catalogFingerprint(classified);
assert.equal(fingerprint, catalogFingerprint([...classified].reverse()));
assert.throws(() => catalogFingerprint([classified[0], { ...classified[0] }]), /Duplicate catalog identity/);
assert.throws(() => catalogFingerprint([{ ...classified[0], classification: "trusted" }]));
assert.throws(() => catalogFingerprint([{ ...classified[0], classificationReason: "" }]));
assert.throws(() => catalogFingerprint([{ ...classified[0], classification: "exclude_with_justification",
  classificationReason: "too short" }]));
for (const changed of [
  [...classified, classifyDatabaseRelation(relation("new_business_module"))],
  classified.slice(1),
  classified.map((entry, index) => index ? entry : { ...entry, classification: "review_required" }),
  classified.map((entry, index) => index ? entry : { ...entry, relationKind: "view" }),
]) assert.notEqual(catalogFingerprint(changed), fingerprint);
const before = createCatalogSnapshot(classified, "catalog-policy-v1", discoveredAt);
assert.doesNotThrow(() => assertCatalogUnchanged(before, { ...before }));
assert.throws(() => assertCatalogUnchanged(before,
  createCatalogSnapshot([...classified, classifyDatabaseRelation(relation("new_business_module"))],
    "catalog-policy-v1", discoveredAt)), /Catalog changed/);
console.log("Backup V2 Phase 4B.1 catalog contracts: PASS");
