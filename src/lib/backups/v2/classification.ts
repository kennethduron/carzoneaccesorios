import {
  CATALOG_RELATION_KINDS, normalizeCatalogDiscovery, type CatalogClassification,
  type ClassifiedCatalogRelation, type DiscoveredCatalogRelation,
} from "./catalog.ts";

const REQUIRED_BUSINESS_RELATIONS = new Set([
  "accounting_accounts", "accounting_automation_settings", "accounting_entry_date_repair_batches",
  "accounting_entry_date_repair_manifest", "accounting_entry_date_repairs", "accounting_event_log",
  "accounting_feature_flags", "accounting_mapping_authorization_audit", "accounting_mappings",
  "accounting_opening_balance_batches", "accounting_outbox", "accounting_outbox_recovery_audit",
  "accounting_outbox_v2", "accounting_periods", "accounting_reversal_requests", "accounting_settings",
  "accounting_shadow_observations", "accounting_technical_reversal_date_repairs",
  "accounting_v1_v2_supersessions", "accounts_payable", "accounts_receivable",
  "accounts_receivable_payments", "admin_dashboard_notification_reads", "audit_logs", "backup_logs",
  "backup_runs", "categories", "checkout_feature_flags", "checkout_idempotency_requests",
  "checkout_observability_events", "checkout_order_commercial_repair_requests", "checkout_requests_v4",
  "company_settings", "crm_followups", "crm_notes", "customer_credit_accounts", "customer_feature_flags",
  "customer_identity_values", "customer_merge_operations", "customer_portal_link_history",
  "customer_portal_link_idempotency_requests", "customer_portal_notifications", "customers", "email_queue",
  "error_logs", "fcm_device_tokens", "financial_events", "fiscal_invoice_requests_v2", "fiscal_settings",
  "holiday_banners", "import_audit_events", "import_batches", "import_rows", "internal_notifications",
  "inventory_adjustment_lines", "inventory_adjustments", "inventory_movements", "inventory_reservations",
  "invoice_items", "invoices", "journal_entries", "journal_entry_lines", "notification_logs",
  "notification_preferences", "notification_user_preferences", "operational_backup_checks",
  "operational_cron_runs", "order_internal_notes", "order_items", "order_price_confirmation_context",
  "order_price_feature_flags", "orders", "payments", "portal_customer_link_reviews",
  "portal_customer_profile_sync_requests", "portal_customer_profile_syncs", "pos_credit_overdue_override_context",
  "pos_feature_flags", "pos_idempotency_requests", "pos_sale_confirmation_context", "pos_sale_draft_items",
  "pos_sale_drafts", "product_images", "products", "purchase_feature_flags", "purchase_items",
  "purchase_return_items", "purchase_returns", "purchases", "roles", "shipment_tracking", "supplier_credits",
  "supplier_invoices", "supplier_payment_accounting_repairs", "supplier_payment_applications",
  "supplier_payments", "suppliers", "technical_alert_settings", "users", "wholesale_access_history",
  "wholesale_codes", "wholesale_idempotency_requests",
]);

const BACKUP_CONTROL_PLANE = new Set([
  "backup_v2_runs", "backup_v2_run_events", "backup_v2_recovery_sets",
  "backup_v2_recovery_set_components", "backup_v2_measurements", "backup_v2_artifacts",
  "backup_v2_artifact_copies", "backup_v2_catalog_snapshots",
]);

const EXPLICIT_SAFE_EXCLUSIONS = new Map([
  ["rate_limits", "ephemeral request-throttling counters; authoritative state is not business data"],
  ["commercial_snapshot_repair_context", "transaction-local security context with no durable business authority"],
  ["sale_terms_write_context", "transaction-local write context reconstructed by application operations"],
]);

function classified(
  relation: DiscoveredCatalogRelation, classification: CatalogClassification, reason: string,
): ClassifiedCatalogRelation {
  const normalized = normalizeCatalogDiscovery(relation);
  return { ...normalized, relationKind: CATALOG_RELATION_KINDS.includes(
    normalized.relationKind as (typeof CATALOG_RELATION_KINDS)[number],
  ) ? normalized.relationKind as ClassifiedCatalogRelation["relationKind"] : "unknown",
  classification, classificationReason: reason };
}

export function classifyDatabaseRelation(relation: DiscoveredCatalogRelation): ClassifiedCatalogRelation {
  if (!CATALOG_RELATION_KINDS.includes(relation.relationKind as (typeof CATALOG_RELATION_KINDS)[number])) {
    return classified(relation, "review_required", "unknown relation kind requires explicit policy review");
  }
  if (relation.relationKind === "view") {
    return classified(relation, "reconstructable", "ordinary view definition is reconstructed from migrations");
  }
  if (relation.relationKind === "materialized_view") {
    return classified(relation, "review_required", "materialized data requires an explicit recovery policy");
  }
  if (relation.schemaName !== "public") {
    return classified(relation, "review_required", "non-public schema is handled by a separate recovery component");
  }
  const exclusionReason = EXPLICIT_SAFE_EXCLUSIONS.get(relation.relationName);
  if (exclusionReason) return classified(relation, "exclude_with_justification", exclusionReason);
  if (BACKUP_CONTROL_PLANE.has(relation.relationName)) {
    return classified(relation, "metadata_only", "Backup V2 audit/control evidence; not a backup execution dependency");
  }
  if (REQUIRED_BUSINESS_RELATIONS.has(relation.relationName)) {
    return classified(relation, "required_backup", "durable Car Zone business or security state");
  }
  return classified(relation, "review_required", "unclassified application base table fails closed");
}

export interface AuthRecoveryClassification {
  category: "users" | "identities" | "configuration" | "sessions_tokens";
  classification: "required_backup" | "reconstructable" | "review_required";
  reason: string;
}
export const AUTH_RECOVERY_POLICY: readonly AuthRecoveryClassification[] = [
  { category: "users", classification: "required_backup", reason: "account identity is durable recovery state" },
  { category: "identities", classification: "required_backup", reason: "identity-provider linkage is durable" },
  { category: "configuration", classification: "required_backup", reason: "required Auth configuration must be evidenced" },
  { category: "sessions_tokens", classification: "reconstructable", reason: "sessions and one-time tokens require reauthentication" },
];

export interface StorageRecoveryPolicy {
  bucketMetadata: "required_backup";
  objectBytes: "required_backup";
  metadataAloneIsComplete: false;
}
export const STORAGE_RECOVERY_POLICY: StorageRecoveryPolicy = {
  bucketMetadata: "required_backup", objectBytes: "required_backup", metadataAloneIsComplete: false,
};

export type ExternalAssetKind = "original" | "derived_transformation" | "reference_metadata";
export function classifyExternalAsset(kind: ExternalAssetKind): "required_backup" | "reconstructable" {
  return kind === "derived_transformation" ? "reconstructable" : "required_backup";
}
