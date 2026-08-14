-- Modern Backup V2 Phase 4B.1: authoritative execution-control contracts only.
-- This unreleased migration performs no export, provider operation, restore, or business-row write.

create function public.backup_v2_normalize_scope_set(input_scopes text[])
returns text[]
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(array_agg(scope order by convert_to(scope, 'UTF8')), '{}'::text[])
  from (select distinct unnest(input_scopes) as scope) normalized;
$$;

create function public.backup_v2_catalog_field(input_value text)
returns text
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select octet_length(convert_to(input_value, 'UTF8'))::text || ':' || input_value;
$$;

alter table public.backup_v2_runs drop constraint if exists backup_v2_runs_scope_check;
alter table public.backup_v2_runs add constraint backup_v2_runs_scope_check
  check (scope in ('database', 'auth', 'storage_metadata', 'storage_objects', 'external_assets'));
alter table public.backup_v2_run_events drop constraint if exists backup_v2_run_events_scope_check;
alter table public.backup_v2_run_events add constraint backup_v2_run_events_scope_check
  check (scope in ('database', 'auth', 'storage_metadata', 'storage_objects', 'external_assets'));
alter table public.backup_v2_recovery_set_components
  drop constraint if exists backup_v2_recovery_set_components_scope_check;
alter table public.backup_v2_recovery_set_components
  add constraint backup_v2_recovery_set_components_scope_check
  check (scope in ('database', 'auth', 'storage_metadata', 'storage_objects', 'external_assets'));
alter table public.backup_v2_measurements drop constraint if exists backup_v2_measurements_measurement_scope_check;
alter table public.backup_v2_measurements add constraint backup_v2_measurements_measurement_scope_check
  check (measurement_scope in (
    'database', 'auth', 'storage_metadata', 'storage_objects', 'external_assets',
    'full_recovery_set', 'runtime'
  ));
alter table public.backup_v2_recovery_sets
  drop constraint if exists backup_v2_recovery_sets_required_scopes_check;
alter table public.backup_v2_recovery_sets
  add constraint backup_v2_recovery_sets_required_scopes_check check (
    cardinality(required_scopes) between 1 and 5
    and required_scopes <@ array[
      'database', 'auth', 'storage_metadata', 'storage_objects', 'external_assets'
    ]::text[]
    and required_scopes @> array['database']::text[]
    and (
      (policy_version like 'car-zone-phase4b1%'
        and required_scopes = array[
          'auth','database','external_assets','storage_metadata','storage_objects'
        ]::text[]
        and required_scopes = public.backup_v2_normalize_scope_set(required_scopes))
      or
      (policy_version not like 'car-zone-phase4b1%'
        and cardinality(array_positions(required_scopes, 'database')) <= 1
        and cardinality(array_positions(required_scopes, 'auth')) <= 1
        and cardinality(array_positions(required_scopes, 'storage_metadata')) <= 1
        and cardinality(array_positions(required_scopes, 'storage_objects')) <= 1
        and cardinality(array_positions(required_scopes, 'external_assets')) <= 1)
    )
  );
alter table public.backup_v2_recovery_sets
  alter column required_scopes set default
  array['database', 'auth', 'storage_objects']::text[];

alter table public.backup_v2_runs
  add column contract_version text not null default 'phase4a'
    check (contract_version in ('phase4a', 'phase4b1')),
  add column semantic_request_key text
    check (semantic_request_key is null or semantic_request_key ~ '^backup-v2:[0-9a-f]{64}$'),
  add column generation_key text
    check (generation_key is null or generation_key ~ '^backup-v2-generation:[0-9a-f]{64}$'),
  add column generation_scope_set text[],
  add column source_environment text
    check (source_environment is null or source_environment ~ '^[a-z0-9._:@/-]{1,160}$'),
  add column generation_boundary timestamptz,
  add column catalog_policy_version text
    check (catalog_policy_version is null or length(catalog_policy_version) between 1 and 80),
  add column preflight_snapshot_id uuid,
  add column preflight_outcome text
    check (preflight_outcome is null or preflight_outcome in ('go', 'blocked', 'review_required')),
  add column preflight_reasons text[] not null default '{}'::text[],
  add column failure_reason text check (failure_reason is null or failure_reason in (
    'database_unavailable', 'catalog_changed', 'unknown_relation', 'export_failed', 'encryption_failed',
    'integrity_failed', 'runner_capacity', 'provider_unavailable', 'quota_blocked', 'key_metadata_missing',
    'lease_lost', 'artifact_conflict', 'auth_export_failed', 'storage_metadata_export_failed',
    'storage_export_failed',
    'external_asset_export_failed'
  )),
  add column retry_classification text check (retry_classification is null or retry_classification in (
    'retryable', 'terminal', 'manual_review', 'fail_closed'
  )),
  add column lease_acquired_at timestamptz,
  add column lease_generation bigint not null default 0 check (lease_generation >= 0),
  add constraint backup_v2_runs_phase4b_identity_complete check (
    contract_version = 'phase4a'
    or (
      semantic_request_key is not null
      and generation_key is not null
      and generation_scope_set is not null
      and cardinality(generation_scope_set) between 1 and 5
      and generation_scope_set <@ array[
        'database', 'auth', 'storage_metadata', 'storage_objects', 'external_assets'
      ]::text[]
      and generation_scope_set = public.backup_v2_normalize_scope_set(generation_scope_set)
      and scope = generation_scope_set[1]
      and source_environment is not null
      and generation_boundary is not null
    )
  ),
  add constraint backup_v2_runs_preflight_binding_complete check (
    (preflight_snapshot_id is null and preflight_outcome is null)
    or (preflight_snapshot_id is not null and preflight_outcome is not null)
  ),
  add constraint backup_v2_runs_lease_complete check (
    (lease_owner_ref is null and lease_acquired_at is null and lease_expires_at is null)
    or (lease_owner_ref is not null and lease_acquired_at is not null and heartbeat_at is not null
      and lease_expires_at is not null and lease_generation > 0
      and lease_acquired_at <= heartbeat_at and heartbeat_at < lease_expires_at)
  );

alter table public.backup_v2_runs
  add constraint backup_v2_runs_id_generation_key_key unique (id, generation_key);

create unique index backup_v2_runs_semantic_request_key_idx
  on public.backup_v2_runs (semantic_request_key) where contract_version = 'phase4b1';
create unique index backup_v2_runs_generation_key_idx
  on public.backup_v2_runs (generation_key) where contract_version = 'phase4b1';
create index backup_v2_runs_generation_state_idx
  on public.backup_v2_runs (generation_key, lifecycle_state) where contract_version = 'phase4b1';
create index backup_v2_runs_lease_expiration_idx
  on public.backup_v2_runs (lease_expires_at, lease_owner_ref, lease_generation)
  where contract_version = 'phase4b1' and lease_owner_ref is not null;

alter table public.backup_v2_measurements
  add column measurement_quality text not null default 'unknown'
    check (measurement_quality in ('measured', 'observed', 'estimated', 'unknown')),
  add column database_total_bytes numeric(78,0) check (database_total_bytes >= 0),
  add column table_bytes numeric(78,0) check (table_bytes >= 0),
  add column index_bytes numeric(78,0) check (index_bytes >= 0),
  add column estimated_logical_bytes numeric(78,0) check (estimated_logical_bytes >= 0),
  add column observed_artifact_bytes numeric(78,0) check (observed_artifact_bytes >= 0),
  add column storage_metadata_bytes numeric(78,0) check (storage_metadata_bytes >= 0),
  add column storage_object_bytes numeric(78,0) check (storage_object_bytes >= 0),
  add column external_asset_bytes numeric(78,0) check (external_asset_bytes >= 0),
  add column runner_temp_disk_available_bytes numeric(78,0) check (runner_temp_disk_available_bytes >= 0),
  add column provider_quota_bytes numeric(78,0) check (provider_quota_bytes >= 0);

create table public.backup_v2_catalog_snapshots (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null unique references public.backup_v2_runs(id),
  generation_key text not null check (generation_key ~ '^backup-v2-generation:[0-9a-f]{64}$'),
  policy_version text not null check (length(policy_version) between 1 and 80),
  catalog_fingerprint text not null check (catalog_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  relation_count integer not null check (relation_count >= 0),
  required_backup_count integer not null check (required_backup_count >= 0),
  metadata_only_count integer not null check (metadata_only_count >= 0),
  reconstructable_count integer not null check (reconstructable_count >= 0),
  excluded_count integer not null check (excluded_count >= 0),
  review_required_count integer not null check (review_required_count >= 0),
  classification_entries jsonb not null check (
    jsonb_typeof(classification_entries) = 'array' and pg_column_size(classification_entries) <= 2097152
  ),
  measurement_evidence jsonb not null check (
    jsonb_typeof(measurement_evidence) = 'array' and pg_column_size(measurement_evidence) <= 65536
  ),
  findings jsonb not null check (jsonb_typeof(findings) = 'array' and pg_column_size(findings) <= 262144),
  preflight_outcome text not null check (preflight_outcome in ('go', 'blocked', 'review_required')),
  discovered_at timestamptz not null,
  preflight_expires_at timestamptz not null,
  evidence_origin text not null check (evidence_origin in ('runtime_verified', 'synthetic_fixture')),
  created_at timestamptz not null default now(),
  check (
    relation_count = required_backup_count + metadata_only_count + reconstructable_count
      + excluded_count + review_required_count
  ),
  check (discovered_at <= created_at),
  check (preflight_expires_at >= discovered_at)
);

alter table public.backup_v2_catalog_snapshots
  add constraint backup_v2_catalog_snapshots_run_generation_fk
  foreign key (run_id, generation_key)
  references public.backup_v2_runs(id, generation_key);

alter table public.backup_v2_runs
  add constraint backup_v2_runs_preflight_snapshot_fk
  foreign key (preflight_snapshot_id) references public.backup_v2_catalog_snapshots(id);

create index backup_v2_catalog_snapshots_fingerprint_idx
  on public.backup_v2_catalog_snapshots(catalog_fingerprint, preflight_outcome);
create index backup_v2_catalog_snapshots_generation_idx
  on public.backup_v2_catalog_snapshots(generation_key);

alter table public.backup_v2_recovery_set_components
  drop constraint if exists backup_v2_recovery_set_components_run_id_key;
alter table public.backup_v2_recovery_set_components
  add column generation_key text
    check (generation_key is null or generation_key ~ '^backup-v2-generation:[0-9a-f]{64}$'),
  add column evidence_lease_owner_ref text
    check (evidence_lease_owner_ref is null or length(evidence_lease_owner_ref) between 1 and 160),
  add column evidence_lease_generation bigint check (evidence_lease_generation is null or evidence_lease_generation > 0),
  add column canonical_evidence_recorded_at timestamptz,
  add constraint backup_v2_component_fenced_evidence_complete check (
    (evidence_lease_owner_ref is null and evidence_lease_generation is null and canonical_evidence_recorded_at is null)
    or (evidence_lease_owner_ref is not null and evidence_lease_generation is not null
      and canonical_evidence_recorded_at is not null)
  );

alter table public.backup_v2_recovery_sets
  add column generation_run_id uuid references public.backup_v2_runs(id),
  add column generation_key text
    check (generation_key is null or generation_key ~ '^backup-v2-generation:[0-9a-f]{64}$'),
  add column recovery_key_evidence_origin text
    check (recovery_key_evidence_origin is null or recovery_key_evidence_origin = 'runtime_verified'),
  add column recovery_key_attested_by_owner_ref text
    check (recovery_key_attested_by_owner_ref is null
      or length(recovery_key_attested_by_owner_ref) between 1 and 160),
  add column recovery_key_attested_lease_generation bigint
    check (recovery_key_attested_lease_generation is null
      or recovery_key_attested_lease_generation > 0),
  add constraint backup_v2_recovery_sets_generation_contract check (
    (policy_version like 'car-zone-phase4b1%'
      and generation_run_id is not null and generation_key is not null)
    or
    (policy_version not like 'car-zone-phase4b1%'
      and generation_run_id is null and generation_key is null)
  ),
  add constraint backup_v2_recovery_sets_phase4b_key_evidence check (
    policy_version not like 'car-zone-phase4b1%'
    or recovery_key_status <> 'availability_attested'
    or (
      recovery_key_evidence_origin = 'runtime_verified'
      and recovery_key_attested_by_owner_ref is not null
      and recovery_key_attested_lease_generation is not null
    )
  ),
  add constraint backup_v2_recovery_sets_id_generation_key_key unique (id, generation_key),
  add constraint backup_v2_recovery_sets_run_generation_fk
    foreign key (generation_run_id, generation_key)
    references public.backup_v2_runs(id, generation_key);

create unique index backup_v2_recovery_sets_generation_key_idx
  on public.backup_v2_recovery_sets(generation_key)
  where generation_key is not null;

alter table public.backup_v2_recovery_set_components
  add constraint backup_v2_recovery_components_run_generation_fk
    foreign key (run_id, generation_key)
    references public.backup_v2_runs(id, generation_key),
  add constraint backup_v2_recovery_components_set_generation_fk
    foreign key (recovery_set_id, generation_key)
    references public.backup_v2_recovery_sets(id, generation_key);

create table public.backup_v2_artifacts (
  id uuid primary key default gen_random_uuid(),
  artifact_id text not null unique check (length(artifact_id) between 1 and 160),
  recovery_set_id uuid not null references public.backup_v2_recovery_sets(id),
  run_id uuid not null references public.backup_v2_runs(id),
  generation_key text not null check (generation_key ~ '^backup-v2-generation:[0-9a-f]{64}$'),
  component text not null check (component in (
    'database', 'auth', 'storage_metadata', 'storage_objects', 'external_assets'
  )),
  format_version text not null check (length(format_version) between 1 and 80),
  artifact_version text not null check (length(artifact_version) between 1 and 80),
  artifact_size_bytes numeric(78,0) not null check (artifact_size_bytes >= 0),
  plaintext_size_bytes numeric(78,0) check (plaintext_size_bytes >= 0),
  ciphertext_size_bytes numeric(78,0) check (ciphertext_size_bytes >= 0),
  hash_algorithm text not null check (hash_algorithm = 'sha256'),
  plaintext_hash text check (plaintext_hash is null or plaintext_hash ~ '^[0-9a-f]{64}$'),
  ciphertext_hash text check (ciphertext_hash is null or ciphertext_hash ~ '^[0-9a-f]{64}$'),
  encryption_algorithm text check (encryption_algorithm is null or encryption_algorithm = 'aes-256-gcm'),
  key_version text check (key_version is null or length(key_version) between 1 and 80),
  key_safe_ref text check (key_safe_ref is null or length(key_safe_ref) between 1 and 160),
  key_public_fingerprint text check (key_public_fingerprint is null or length(key_public_fingerprint) between 16 and 160),
  compatibility_ref text check (compatibility_ref is null or length(compatibility_ref) between 1 and 160),
  verification_status text not null check (verification_status in ('planned', 'unverified', 'verified', 'failed')),
  evidence_origin text not null check (evidence_origin in ('runtime_verified', 'synthetic_fixture')),
  created_by_owner_ref text not null check (length(created_by_owner_ref) between 1 and 160),
  created_lease_generation bigint not null check (created_lease_generation > 0),
  verified_by_owner_ref text check (verified_by_owner_ref is null or length(verified_by_owner_ref) between 1 and 160),
  verified_lease_generation bigint check (verified_lease_generation is null or verified_lease_generation > 0),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  unique (recovery_set_id, component),
  check (verified_at is null or verified_at >= created_at),
  check (
    (verified_by_owner_ref is null and verified_lease_generation is null and verified_at is null)
    or (verified_by_owner_ref is not null and verified_lease_generation is not null and verified_at is not null)
  ),
  check (verification_status <> 'verified' or (
    ciphertext_size_bytes is not null and artifact_size_bytes = ciphertext_size_bytes
    and ciphertext_hash is not null and encryption_algorithm = 'aes-256-gcm'
    and key_version is not null and key_safe_ref is not null and key_public_fingerprint is not null
    and compatibility_ref is not null and verified_at is not null and evidence_origin = 'runtime_verified'
  ))
);

alter table public.backup_v2_artifacts
  add constraint backup_v2_artifacts_run_generation_fk
    foreign key (run_id, generation_key)
    references public.backup_v2_runs(id, generation_key),
  add constraint backup_v2_artifacts_set_generation_fk
    foreign key (recovery_set_id, generation_key)
    references public.backup_v2_recovery_sets(id, generation_key);

create index backup_v2_artifacts_run_component_idx on public.backup_v2_artifacts(run_id, component);
create index backup_v2_artifacts_verification_idx
  on public.backup_v2_artifacts(recovery_set_id, verification_status, component);

create table public.backup_v2_artifact_copies (
  id uuid primary key default gen_random_uuid(),
  copy_id text not null unique check (length(copy_id) between 1 and 160),
  artifact_id uuid not null references public.backup_v2_artifacts(id),
  copy_role text not null check (copy_role in ('primary', 'secondary_independent', 'optional_offline')),
  provider_neutral_ref text not null check (length(provider_neutral_ref) between 1 and 240),
  physical_object_identity text not null unique check (length(physical_object_identity) between 1 and 240),
  independence_domain text check (independence_domain is null or length(independence_domain) between 1 and 160),
  storage_class text check (storage_class is null or length(storage_class) between 1 and 80),
  stored_at timestamptz not null default now(),
  verified_at timestamptz,
  ciphertext_size_bytes numeric(78,0) not null check (ciphertext_size_bytes >= 0),
  ciphertext_hash text not null check (ciphertext_hash ~ '^[0-9a-f]{64}$'),
  provider_checksum_ref text check (provider_checksum_ref is null or length(provider_checksum_ref) between 1 and 240),
  verification_status text not null check (verification_status in ('planned', 'unverified', 'verified', 'failed')),
  evidence_origin text not null check (evidence_origin in ('runtime_verified', 'synthetic_fixture')),
  recorded_by_owner_ref text not null check (length(recorded_by_owner_ref) between 1 and 160),
  recorded_lease_generation bigint not null check (recorded_lease_generation > 0),
  verified_by_owner_ref text check (verified_by_owner_ref is null or length(verified_by_owner_ref) between 1 and 160),
  verified_lease_generation bigint check (verified_lease_generation is null or verified_lease_generation > 0),
  created_at timestamptz not null default now(),
  unique (artifact_id, copy_role),
  unique (artifact_id, provider_neutral_ref),
  check (copy_role <> 'secondary_independent' or independence_domain is not null),
  check (verified_at is null or verified_at >= stored_at),
  check (
    (verified_by_owner_ref is null and verified_lease_generation is null and verified_at is null)
    or (verified_by_owner_ref is not null and verified_lease_generation is not null and verified_at is not null)
  ),
  check (verification_status <> 'verified' or (
    verified_at is not null and evidence_origin = 'runtime_verified'
  ))
);

create index backup_v2_artifact_copies_artifact_verification_idx
  on public.backup_v2_artifact_copies(artifact_id, copy_role, verification_status);

create function public.backup_v2_classify_catalog_relation(
  input_schema text, input_relation text, input_kind text
)
returns table(classification text, classification_reason text)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select
    case
      when input_kind = 'view' then 'reconstructable'
      when input_kind = 'materialized_view' then 'review_required'
      when input_kind not in ('base_table', 'partitioned_table') then 'review_required'
      when input_schema <> 'public' then 'review_required'
      when input_relation = any(array[
        'commercial_snapshot_repair_context', 'rate_limits', 'sale_terms_write_context'
      ]) then 'exclude_with_justification'
      when input_relation = any(array[
        'backup_v2_runs', 'backup_v2_run_events', 'backup_v2_recovery_sets',
        'backup_v2_recovery_set_components', 'backup_v2_measurements', 'backup_v2_catalog_snapshots',
        'backup_v2_artifacts', 'backup_v2_artifact_copies'
      ]) then 'metadata_only'
      when input_relation = any(array[
        'accounting_accounts', 'accounting_automation_settings', 'accounting_entry_date_repair_batches',
        'accounting_entry_date_repair_manifest', 'accounting_entry_date_repairs', 'accounting_event_log',
        'accounting_feature_flags', 'accounting_mapping_authorization_audit', 'accounting_mappings',
        'accounting_opening_balance_batches', 'accounting_outbox', 'accounting_outbox_recovery_audit',
        'accounting_outbox_v2', 'accounting_periods', 'accounting_reversal_requests', 'accounting_settings',
        'accounting_shadow_observations', 'accounting_technical_reversal_date_repairs',
        'accounting_v1_v2_supersessions', 'accounts_payable', 'accounts_receivable',
        'accounts_receivable_payments', 'admin_dashboard_notification_reads', 'audit_logs', 'backup_logs',
        'backup_runs', 'categories', 'checkout_feature_flags', 'checkout_idempotency_requests',
        'checkout_observability_events', 'checkout_order_commercial_repair_requests', 'checkout_requests_v4',
        'company_settings', 'crm_followups', 'crm_notes', 'customer_credit_accounts', 'customer_feature_flags',
        'customer_identity_values', 'customer_merge_operations', 'customer_portal_link_history',
        'customer_portal_link_idempotency_requests', 'customer_portal_notifications', 'customers', 'email_queue',
        'error_logs', 'fcm_device_tokens', 'financial_events', 'fiscal_invoice_requests_v2', 'fiscal_settings',
        'holiday_banners', 'import_audit_events', 'import_batches', 'import_rows', 'internal_notifications',
        'inventory_adjustment_lines', 'inventory_adjustments', 'inventory_movements', 'inventory_reservations',
        'invoice_items', 'invoices', 'journal_entries', 'journal_entry_lines', 'notification_logs',
        'notification_preferences', 'notification_user_preferences', 'operational_backup_checks',
        'operational_cron_runs', 'order_internal_notes', 'order_items', 'order_price_confirmation_context',
        'order_price_feature_flags', 'orders', 'payments', 'portal_customer_link_reviews',
        'portal_customer_profile_sync_requests', 'portal_customer_profile_syncs',
        'pos_credit_overdue_override_context', 'pos_feature_flags', 'pos_idempotency_requests',
        'pos_sale_confirmation_context', 'pos_sale_draft_items', 'pos_sale_drafts', 'product_images', 'products',
        'purchase_feature_flags', 'purchase_items', 'purchase_return_items', 'purchase_returns', 'purchases',
        'roles', 'shipment_tracking', 'supplier_credits', 'supplier_invoices',
        'supplier_payment_accounting_repairs', 'supplier_payment_applications', 'supplier_payments', 'suppliers',
        'technical_alert_settings', 'users', 'wholesale_access_history', 'wholesale_codes',
        'wholesale_idempotency_requests'
      ]) then 'required_backup'
      else 'review_required'
    end,
    case
      when input_kind = 'view' then 'ordinary view definition is reconstructed from migrations'
      when input_kind = 'materialized_view' then 'materialized data requires an explicit recovery policy'
      when input_kind not in ('base_table', 'partitioned_table') then 'unknown relation kind requires explicit policy review'
      when input_schema <> 'public' then 'non-public schema is handled by a separate recovery component'
      when input_relation = 'rate_limits'
        then 'ephemeral request-throttling counters; authoritative state is not business data'
      when input_relation = 'commercial_snapshot_repair_context'
        then 'transaction-local security context with no durable business authority'
      when input_relation = 'sale_terms_write_context'
        then 'transaction-local write context reconstructed by application operations'
      when input_relation like 'backup_v2_%'
        then 'Backup V2 audit/control evidence; not a backup execution dependency'
      when input_relation = any(array[
        'accounting_accounts', 'accounting_automation_settings', 'accounting_entry_date_repair_batches',
        'accounting_entry_date_repair_manifest', 'accounting_entry_date_repairs', 'accounting_event_log',
        'accounting_feature_flags', 'accounting_mapping_authorization_audit', 'accounting_mappings',
        'accounting_opening_balance_batches', 'accounting_outbox', 'accounting_outbox_recovery_audit',
        'accounting_outbox_v2', 'accounting_periods', 'accounting_reversal_requests', 'accounting_settings',
        'accounting_shadow_observations', 'accounting_technical_reversal_date_repairs',
        'accounting_v1_v2_supersessions', 'accounts_payable', 'accounts_receivable',
        'accounts_receivable_payments', 'admin_dashboard_notification_reads', 'audit_logs', 'backup_logs',
        'backup_runs', 'categories', 'checkout_feature_flags', 'checkout_idempotency_requests',
        'checkout_observability_events', 'checkout_order_commercial_repair_requests', 'checkout_requests_v4',
        'company_settings', 'crm_followups', 'crm_notes', 'customer_credit_accounts', 'customer_feature_flags',
        'customer_identity_values', 'customer_merge_operations', 'customer_portal_link_history',
        'customer_portal_link_idempotency_requests', 'customer_portal_notifications', 'customers', 'email_queue',
        'error_logs', 'fcm_device_tokens', 'financial_events', 'fiscal_invoice_requests_v2', 'fiscal_settings',
        'holiday_banners', 'import_audit_events', 'import_batches', 'import_rows', 'internal_notifications',
        'inventory_adjustment_lines', 'inventory_adjustments', 'inventory_movements', 'inventory_reservations',
        'invoice_items', 'invoices', 'journal_entries', 'journal_entry_lines', 'notification_logs',
        'notification_preferences', 'notification_user_preferences', 'operational_backup_checks',
        'operational_cron_runs', 'order_internal_notes', 'order_items', 'order_price_confirmation_context',
        'order_price_feature_flags', 'orders', 'payments', 'portal_customer_link_reviews',
        'portal_customer_profile_sync_requests', 'portal_customer_profile_syncs',
        'pos_credit_overdue_override_context', 'pos_feature_flags', 'pos_idempotency_requests',
        'pos_sale_confirmation_context', 'pos_sale_draft_items', 'pos_sale_drafts', 'product_images', 'products',
        'purchase_feature_flags', 'purchase_items', 'purchase_return_items', 'purchase_returns', 'purchases',
        'roles', 'shipment_tracking', 'supplier_credits', 'supplier_invoices',
        'supplier_payment_accounting_repairs', 'supplier_payment_applications', 'supplier_payments', 'suppliers',
        'technical_alert_settings', 'users', 'wholesale_access_history', 'wholesale_codes',
        'wholesale_idempotency_requests'
      ]) then 'durable Car Zone business or security state'
      else 'unclassified application base table fails closed'
    end;
$$;

create function public.backup_v2_current_catalog()
returns table(
  schema_name text, relation_name text, relation_kind text, classification text,
  classification_reason text, estimated_rows numeric, total_bytes numeric,
  table_bytes numeric, index_bytes numeric
)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select
    namespace.nspname,
    relation.relname,
    case relation.relkind
      when 'r' then 'base_table'
      when 'p' then 'partitioned_table'
      when 'v' then 'view'
      when 'm' then 'materialized_view'
    end,
    policy.classification,
    policy.classification_reason,
    greatest(relation.reltuples, 0)::numeric,
    case when relation.relkind in ('r', 'p', 'm') then pg_total_relation_size(relation.oid)::numeric else 0 end,
    case when relation.relkind in ('r', 'p', 'm') then pg_relation_size(relation.oid)::numeric else 0 end,
    case when relation.relkind in ('r', 'p', 'm') then pg_indexes_size(relation.oid)::numeric else 0 end
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  cross join lateral public.backup_v2_classify_catalog_relation(
    namespace.nspname,
    relation.relname,
    case relation.relkind
      when 'r' then 'base_table'
      when 'p' then 'partitioned_table'
      when 'v' then 'view'
      when 'm' then 'materialized_view'
    end
  ) policy
  where namespace.nspname = 'public' and relation.relkind in ('r', 'p', 'v', 'm');
$$;

create function public.backup_v2_current_catalog_fingerprint()
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select 'sha256:' || encode(extensions.digest(convert_to(
    'backup-v2-catalog-v1' || coalesce(E'\n' || string_agg(
      public.backup_v2_catalog_field(schema_name)
      || public.backup_v2_catalog_field(relation_name)
      || public.backup_v2_catalog_field(relation_kind)
      || public.backup_v2_catalog_field(classification)
      || public.backup_v2_catalog_field(classification_reason),
      E'\n' order by convert_to(schema_name || '.' || relation_name, 'UTF8')
    ), ''),
    'UTF8'
  ), 'sha256'), 'hex')
  from public.backup_v2_current_catalog();
$$;

create or replace function public.backup_v2_enforce_run_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare transition_allowed boolean;
begin
  if tg_op = 'INSERT' then
    if new.lifecycle_state <> 'requested' then
      raise exception using errcode = '23514', message = 'BACKUP_V2_INITIAL_STATE_INVALID';
    end if;
    if new.contract_version = 'phase4b1' and current_user = 'service_role' then
      raise exception using errcode = '42501', message = 'BACKUP_V2_CANONICAL_CREATION_REQUIRED';
    end if;
    return new;
  end if;
  if new.scope is distinct from old.scope then
    raise exception using errcode = '55000', message = 'BACKUP_V2_RUN_SCOPE_IMMUTABLE';
  end if;
  if new.contract_version is distinct from old.contract_version
    or new.semantic_request_key is distinct from old.semantic_request_key
    or new.generation_key is distinct from old.generation_key
    or new.generation_scope_set is distinct from old.generation_scope_set
    or new.source_environment is distinct from old.source_environment
    or new.generation_boundary is distinct from old.generation_boundary then
    raise exception using errcode = '55000', message = 'BACKUP_V2_RUN_IDENTITY_IMMUTABLE';
  end if;
  if old.lifecycle_state in ('completed', 'completed_with_warnings', 'failed', 'cancelled') then
    raise exception using errcode = '55000', message = 'BACKUP_V2_TERMINAL_STATE_IMMUTABLE';
  end if;
  if new.lifecycle_state <> old.lifecycle_state then
    if current_setting('app.backup_v2_transition_run_id', true) is distinct from old.id::text then
      raise exception using errcode = '55000', message = 'BACKUP_V2_DIRECT_STATE_MUTATION_DENIED';
    end if;
    transition_allowed := case old.lifecycle_state
      when 'requested' then new.lifecycle_state in ('preflight', 'failed', 'cancelled')
      when 'preflight' then new.lifecycle_state in ('running', 'failed', 'cancelled')
      when 'running' then new.lifecycle_state in ('validating', 'failed', 'cancelled')
      when 'validating' then new.lifecycle_state in ('completed', 'completed_with_warnings', 'failed', 'cancelled')
      else false
    end;
    if not transition_allowed then
      raise exception using errcode = '23514', message = 'BACKUP_V2_INVALID_STATE_TRANSITION';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create function public.create_or_get_backup_v2_generation(
  input_policy_version text,
  input_source_environment text,
  input_generation_boundary timestamptz,
  input_scopes text[],
  input_trigger_type text,
  input_manual_request_id text default null
)
returns public.backup_v2_runs
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  normalized_scopes text[];
  normalized_policy text;
  normalized_environment text;
  normalized_manual_id text;
  boundary_text text;
  canonical_request text;
  semantic_key text;
  logical_generation_key text;
  result public.backup_v2_runs%rowtype;
begin
  normalized_scopes := public.backup_v2_normalize_scope_set(input_scopes);
  normalized_policy := btrim(input_policy_version);
  normalized_environment := lower(btrim(input_source_environment));
  normalized_manual_id := nullif(btrim(input_manual_request_id), '');
  if normalized_policy !~ '^[A-Za-z0-9._:@/-]{1,160}$'
    or normalized_environment !~ '^[a-z0-9._:@/-]{1,160}$'
    or input_generation_boundary is null
    or input_trigger_type not in ('manual', 'scheduled', 'system')
    or cardinality(normalized_scopes) not between 1 and 5
    or not normalized_scopes <@ array[
      'database', 'auth', 'storage_metadata', 'storage_objects', 'external_assets'
    ]::text[]
    or (input_trigger_type = 'manual' and normalized_manual_id is null)
    or (normalized_manual_id is not null and normalized_manual_id !~ '^[A-Za-z0-9._:@/-]{1,160}$') then
    raise exception using errcode = '22023', message = 'BACKUP_V2_INVALID_REQUEST_KEY_INPUT';
  end if;
  boundary_text := to_char(input_generation_boundary at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  canonical_request := 'backup-v2-semantic-v1'
    || E'\npolicyVersion=' || normalized_policy
    || E'\nsourceEnvironment=' || normalized_environment
    || E'\ngenerationBoundary=' || boundary_text
    || E'\nscopes=' || array_to_string(normalized_scopes, ',')
    || E'\ntriggerType=' || input_trigger_type
    || E'\nmanualRequestId=' || coalesce(normalized_manual_id, '-');
  semantic_key := 'backup-v2:' || encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'), 'hex'
  );
  logical_generation_key := replace(semantic_key, 'backup-v2:', 'backup-v2-generation:');
  perform pg_advisory_xact_lock(hashtextextended(semantic_key, 0));

  insert into public.backup_v2_runs(
    request_id, scope, trigger_type, format_version, engine_version, zero_spend_policy_version,
    contract_version, semantic_request_key, generation_key, generation_scope_set,
    source_environment, generation_boundary
  ) values (
    gen_random_uuid(), normalized_scopes[1], input_trigger_type, 2, 'phase4b1', 'zero-spend-v1',
    'phase4b1', semantic_key, logical_generation_key, normalized_scopes,
    normalized_environment, input_generation_boundary
  )
  on conflict (semantic_request_key) where contract_version = 'phase4b1'
  do update set semantic_request_key = excluded.semantic_request_key
  returning * into result;
  return result;
end;
$$;

create function public.backup_v2_guard_measurement_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare run_contract text;
begin
  if new.run_id is not null then
    select contract_version into run_contract from public.backup_v2_runs where id = new.run_id;
    if run_contract = 'phase4b1' and current_user = 'service_role' then
      raise exception using errcode = '42501', message = 'BACKUP_V2_CANONICAL_MEASUREMENT_REQUIRED';
    end if;
  end if;
  return new;
end;
$$;

create trigger backup_v2_measurements_phase4b_insert_guard
before insert on public.backup_v2_measurements
for each row execute function public.backup_v2_guard_measurement_insert();

create function public.record_backup_v2_measurement(
  target_run_id uuid,
  input_scope text,
  input_measured_at timestamptz,
  input_values jsonb
)
returns public.backup_v2_measurements
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_run public.backup_v2_runs%rowtype;
  result public.backup_v2_measurements%rowtype;
  required_keys text[] := array[
    'encrypted_bytes', 'temporary_peak_bytes', 'object_count', 'operation_count',
    'runtime_seconds', 'github_actions_minutes'
  ];
  allowed_keys text[] := required_keys || array[
    'database_total_bytes', 'table_bytes', 'index_bytes', 'estimated_logical_bytes',
    'observed_artifact_bytes', 'storage_metadata_bytes', 'storage_object_bytes',
    'external_asset_bytes',
    'runner_temp_disk_available_bytes', 'provider_quota_bytes'
  ];
begin
  select * into current_run from public.backup_v2_runs where id = target_run_id for update;
  if current_run.id is null then
    raise exception using errcode = 'P0002', message = 'BACKUP_V2_RUN_NOT_FOUND';
  end if;
  if current_run.contract_version <> 'phase4b1' or current_run.lifecycle_state not in ('requested', 'preflight') then
    raise exception using errcode = '55000', message = 'BACKUP_V2_MEASUREMENT_STATE_INVALID';
  end if;
  if input_scope not in (
      'database', 'auth', 'storage_metadata', 'storage_objects', 'external_assets',
      'full_recovery_set', 'runtime'
    )
    or (input_scope not in ('full_recovery_set', 'runtime') and not input_scope = any(current_run.generation_scope_set))
    or input_measured_at is null or input_measured_at > now()
    or jsonb_typeof(input_values) <> 'object'
    or exists(select 1 from jsonb_object_keys(input_values) key where not key = any(allowed_keys))
    or exists(select 1 from unnest(required_keys) key where not input_values ? key)
    or exists(
      select 1 from jsonb_each_text(input_values) item
      where item.key <> all(array['runtime_seconds', 'github_actions_minutes'])
        and item.value !~ '^(0|[1-9][0-9]*)$'
    )
    or coalesce(input_values->>'runtime_seconds', '') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,3})?$'
    or coalesce(input_values->>'github_actions_minutes', '') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,3})?$' then
    raise exception using errcode = '22023', message = 'BACKUP_V2_INVALID_MEASUREMENT_VALUE';
  end if;

  insert into public.backup_v2_measurements(
    run_id, measurement_scope, source_kind, measured_at, measurement_quality,
    encrypted_bytes, temporary_peak_bytes, object_count, operation_count,
    runtime_seconds, github_actions_minutes, database_total_bytes, table_bytes, index_bytes,
    estimated_logical_bytes, observed_artifact_bytes, storage_metadata_bytes,
    storage_object_bytes, external_asset_bytes,
    runner_temp_disk_available_bytes, provider_quota_bytes
  ) values (
    target_run_id, input_scope, 'runtime_verified', input_measured_at, 'measured',
    (input_values->>'encrypted_bytes')::bigint,
    (input_values->>'temporary_peak_bytes')::bigint,
    (input_values->>'object_count')::bigint,
    (input_values->>'operation_count')::bigint,
    (input_values->>'runtime_seconds')::numeric,
    (input_values->>'github_actions_minutes')::numeric,
    (input_values->>'database_total_bytes')::numeric,
    (input_values->>'table_bytes')::numeric,
    (input_values->>'index_bytes')::numeric,
    (input_values->>'estimated_logical_bytes')::numeric,
    (input_values->>'observed_artifact_bytes')::numeric,
    (input_values->>'storage_metadata_bytes')::numeric,
    (input_values->>'storage_object_bytes')::numeric,
    (input_values->>'external_asset_bytes')::numeric,
    (input_values->>'runner_temp_disk_available_bytes')::numeric,
    (input_values->>'provider_quota_bytes')::numeric
  ) returning * into result;
  return result;
exception when numeric_value_out_of_range or invalid_text_representation then
  raise exception using errcode = '22023', message = 'BACKUP_V2_INVALID_MEASUREMENT_VALUE';
end;
$$;

create function public.prepare_backup_v2_preflight(
  target_run_id uuid,
  measurement_max_age_seconds integer default 3600
)
returns public.backup_v2_catalog_snapshots
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_run public.backup_v2_runs%rowtype;
  snapshot_result public.backup_v2_catalog_snapshots%rowtype;
  catalog_entries jsonb;
  measurement_entries jsonb;
  catalog_findings jsonb;
  measurement_findings jsonb;
  all_findings jsonb;
  current_fingerprint text;
  relation_total integer;
  required_total integer;
  metadata_total integer;
  reconstructable_total integer;
  excluded_total integer;
  review_total integer;
  missing_measurement_total integer;
  outcome text;
  expiry timestamptz;
  next_sequence integer;
  was_requested boolean;
  reason_codes text[];
begin
  if measurement_max_age_seconds not between 60 and 86400 then
    raise exception using errcode = '22023', message = 'BACKUP_V2_PREFLIGHT_INPUT_INVALID';
  end if;
  select * into current_run from public.backup_v2_runs where id = target_run_id for update;
  if current_run.id is null then
    raise exception using errcode = 'P0002', message = 'BACKUP_V2_RUN_NOT_FOUND';
  end if;
  if current_run.contract_version <> 'phase4b1'
    or current_run.lifecycle_state not in ('requested', 'preflight') then
    raise exception using errcode = '55000', message = 'BACKUP_V2_PREFLIGHT_STATE_INVALID';
  end if;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'schemaName', schema_name,
      'relationName', relation_name,
      'relationKind', relation_kind,
      'classification', classification,
      'classificationReason', classification_reason,
      'estimatedRows', estimated_rows::text,
      'totalBytes', total_bytes::text,
      'tableBytes', table_bytes::text,
      'indexBytes', index_bytes::text
    ) order by convert_to(schema_name || '.' || relation_name, 'UTF8')), '[]'::jsonb),
    count(*)::integer,
    count(*) filter (where classification = 'required_backup')::integer,
    count(*) filter (where classification = 'metadata_only')::integer,
    count(*) filter (where classification = 'reconstructable')::integer,
    count(*) filter (where classification = 'exclude_with_justification')::integer,
    count(*) filter (where classification = 'review_required')::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'severity', 'review_required',
      'reason', 'catalog_review_required',
      'detail', schema_name || '.' || relation_name
    ) order by convert_to(schema_name || '.' || relation_name, 'UTF8'))
      filter (where classification = 'review_required'), '[]'::jsonb)
  into catalog_entries, relation_total, required_total, metadata_total, reconstructable_total,
       excluded_total, review_total, catalog_findings
  from public.backup_v2_current_catalog();
  current_fingerprint := public.backup_v2_current_catalog_fingerprint();

  with required_scopes as (
    select distinct scope
    from unnest(current_run.generation_scope_set || array['full_recovery_set', 'runtime']::text[]) scope
  ), ranked as (
    select distinct on (measurement.measurement_scope) measurement.*
    from public.backup_v2_measurements measurement
    join required_scopes required on required.scope = measurement.measurement_scope
    where measurement.run_id = target_run_id
      and measurement.source_kind = 'runtime_verified'
      and measurement.measurement_quality = 'measured'
      and measurement.measured_at <= now()
      and measurement.measured_at >= now() - make_interval(secs => measurement_max_age_seconds)
      and case measurement.measurement_scope
        when 'database' then measurement.database_total_bytes is not null
        when 'storage_metadata' then measurement.storage_metadata_bytes is not null
        when 'storage_objects' then measurement.storage_object_bytes is not null
        when 'external_assets' then measurement.external_asset_bytes is not null
        when 'full_recovery_set' then measurement.observed_artifact_bytes is not null
        when 'runtime' then measurement.runner_temp_disk_available_bytes is not null
          and measurement.provider_quota_bytes is not null
        else true
      end
    order by measurement.measurement_scope, measurement.measured_at desc, measurement.id
  ), missing as (
    select required.scope
    from required_scopes required
    left join ranked measurement on measurement.measurement_scope = required.scope
    where measurement.id is null
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object(
      'measurementId', id,
      'scope', measurement_scope,
      'quality', measurement_quality,
      'source', source_kind,
      'measuredAt', measured_at
    ) order by convert_to(measurement_scope, 'UTF8')) from ranked), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object(
      'severity', 'blocked',
      'reason', 'measurement_exact_required',
      'detail', scope || ' requires current measured runtime evidence'
    ) order by convert_to(scope, 'UTF8')) from missing), '[]'::jsonb),
    (select count(*)::integer from missing),
    coalesce((select min(measured_at + make_interval(secs => measurement_max_age_seconds)) from ranked), now())
  into measurement_entries, measurement_findings, missing_measurement_total, expiry;

  all_findings := catalog_findings || measurement_findings;
  outcome := case
    when missing_measurement_total > 0 then 'blocked'
    when review_total > 0 then 'review_required'
    else 'go'
  end;
  select coalesce(array_agg(reason order by convert_to(reason, 'UTF8')), '{}'::text[])
  into reason_codes
  from (
    select distinct finding->>'reason' as reason
    from jsonb_array_elements(all_findings) finding
  ) reasons;

  insert into public.backup_v2_catalog_snapshots(
    run_id, generation_key, policy_version, catalog_fingerprint,
    relation_count, required_backup_count, metadata_only_count, reconstructable_count,
    excluded_count, review_required_count, classification_entries, measurement_evidence,
    findings, preflight_outcome, discovered_at, preflight_expires_at, evidence_origin
  ) values (
    target_run_id, current_run.generation_key, 'car-zone-phase4b1-catalog-v2', current_fingerprint,
    relation_total, required_total, metadata_total, reconstructable_total,
    excluded_total, review_total, catalog_entries, measurement_entries,
    all_findings, outcome, now(), greatest(expiry, now()), 'runtime_verified'
  )
  on conflict (run_id) do update set
    generation_key = excluded.generation_key,
    policy_version = excluded.policy_version,
    catalog_fingerprint = excluded.catalog_fingerprint,
    relation_count = excluded.relation_count,
    required_backup_count = excluded.required_backup_count,
    metadata_only_count = excluded.metadata_only_count,
    reconstructable_count = excluded.reconstructable_count,
    excluded_count = excluded.excluded_count,
    review_required_count = excluded.review_required_count,
    classification_entries = excluded.classification_entries,
    measurement_evidence = excluded.measurement_evidence,
    findings = excluded.findings,
    preflight_outcome = excluded.preflight_outcome,
    discovered_at = excluded.discovered_at,
    preflight_expires_at = excluded.preflight_expires_at,
    evidence_origin = excluded.evidence_origin,
    created_at = now()
  returning * into snapshot_result;

  was_requested := current_run.lifecycle_state = 'requested';
  if was_requested then
    select coalesce(max(sequence_number), 0) + 1 into next_sequence
    from public.backup_v2_run_events where run_id = target_run_id;
    perform set_config('app.backup_v2_transition_run_id', target_run_id::text, true);
  end if;
  update public.backup_v2_runs set
    preflight_snapshot_id = snapshot_result.id,
    preflight_outcome = outcome,
    preflight_reasons = reason_codes,
    catalog_policy_version = snapshot_result.policy_version,
    relations_discovered = relation_total,
    relations_classified = relation_total,
    relations_unknown = review_total,
    lifecycle_state = case when was_requested then 'preflight' else lifecycle_state end,
    started_at = case when was_requested then coalesce(started_at, now()) else started_at end
  where id = target_run_id;
  if was_requested then
    insert into public.backup_v2_run_events(
      run_id, scope, sequence_number, previous_state, next_state, actor_type, sanitized_code
    ) values (
      target_run_id, current_run.scope, next_sequence, 'requested', 'preflight', 'system',
      'BACKUP_V2_CANONICAL_PREFLIGHT'
    );
  end if;
  return snapshot_result;
end;
$$;

create function public.claim_backup_v2_run_lease(
  target_run_id uuid, expected_owner_ref text, lease_seconds integer
)
returns public.backup_v2_runs
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_run public.backup_v2_runs%rowtype;
  accepted_snapshot public.backup_v2_catalog_snapshots%rowtype;
begin
  if expected_owner_ref is null or length(btrim(expected_owner_ref)) not between 1 and 160
    or lease_seconds not between 15 and 3600 then
    raise exception using errcode = '22023', message = 'BACKUP_V2_LEASE_INPUT_INVALID';
  end if;
  select * into current_run from public.backup_v2_runs where id = target_run_id for update;
  if current_run.id is null then
    raise exception using errcode = 'P0002', message = 'BACKUP_V2_RUN_NOT_FOUND';
  end if;
  if current_run.contract_version <> 'phase4b1'
    or current_run.semantic_request_key is null or current_run.generation_key is null
    or current_run.lifecycle_state not in ('preflight', 'running', 'validating') then
    raise exception using errcode = '55000', message = 'BACKUP_V2_LEASE_STATE_INVALID';
  end if;
  select * into accepted_snapshot
  from public.backup_v2_catalog_snapshots
  where id = current_run.preflight_snapshot_id and run_id = current_run.id
  for share;
  if accepted_snapshot.id is null
    or accepted_snapshot.generation_key is distinct from current_run.generation_key
    or accepted_snapshot.preflight_outcome <> 'go'
    or current_run.preflight_outcome <> 'go'
    or accepted_snapshot.preflight_expires_at <= now()
    or accepted_snapshot.catalog_fingerprint is distinct from public.backup_v2_current_catalog_fingerprint() then
    raise exception using errcode = '55000', message = 'BACKUP_V2_PREFLIGHT_NOT_AUTHORITATIVE';
  end if;
  if current_run.lease_owner_ref is not null and current_run.lease_expires_at > now() then
    raise exception using errcode = '55P03', message = 'BACKUP_V2_LEASE_UNAVAILABLE';
  end if;
  update public.backup_v2_runs set
    lease_owner_ref = btrim(expected_owner_ref),
    lease_acquired_at = now(),
    heartbeat_at = now(),
    lease_expires_at = now() + make_interval(secs => lease_seconds),
    lease_generation = lease_generation + 1
  where id = target_run_id returning * into current_run;
  return current_run;
end;
$$;

create function public.create_or_get_backup_v2_recovery_set(
  target_run_id uuid,
  input_max_evidence_age_seconds bigint default 86400
)
returns public.backup_v2_recovery_sets
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_run public.backup_v2_runs%rowtype;
  accepted_snapshot public.backup_v2_catalog_snapshots%rowtype;
  result public.backup_v2_recovery_sets%rowtype;
  canonical_scopes constant text[] := array[
    'auth','database','external_assets','storage_metadata','storage_objects'
  ]::text[];
begin
  if input_max_evidence_age_seconds not between 60 and 86400 then
    raise exception using errcode = '22023', message = 'BACKUP_V2_RECOVERY_SET_INPUT_INVALID';
  end if;
  select * into current_run from public.backup_v2_runs where id = target_run_id for update;
  if current_run.id is null then
    raise exception using errcode = 'P0002', message = 'BACKUP_V2_RUN_NOT_FOUND';
  end if;
  if current_run.contract_version <> 'phase4b1'
    or current_run.generation_key is null
    or current_run.generation_scope_set is distinct from canonical_scopes
    or current_run.lifecycle_state not in ('preflight', 'running', 'validating') then
    raise exception using errcode = '55000', message = 'BACKUP_V2_RECOVERY_SET_GENERATION_INVALID';
  end if;

  select * into result
  from public.backup_v2_recovery_sets
  where generation_key = current_run.generation_key
  for update;
  if result.id is not null then
    if result.generation_run_id is distinct from current_run.id
      or result.required_scopes is distinct from canonical_scopes
      or result.policy_version not like 'car-zone-phase4b1%' then
      raise exception using errcode = '55000', message = 'BACKUP_V2_RECOVERY_SET_GENERATION_CONFLICT';
    end if;
    return result;
  end if;

  select * into accepted_snapshot
  from public.backup_v2_catalog_snapshots
  where id = current_run.preflight_snapshot_id
    and run_id = current_run.id
    and generation_key = current_run.generation_key;
  if accepted_snapshot.id is null
    or accepted_snapshot.preflight_outcome <> 'go'
    or current_run.preflight_outcome <> 'go'
    or accepted_snapshot.preflight_expires_at <= now()
    or accepted_snapshot.catalog_fingerprint is distinct from public.backup_v2_current_catalog_fingerprint() then
    raise exception using errcode = '55000', message = 'BACKUP_V2_PREFLIGHT_NOT_AUTHORITATIVE';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(current_run.generation_key, 1));
  insert into public.backup_v2_recovery_sets(
    request_id, policy_version, max_evidence_age_seconds, required_scopes,
    recovery_key_requirement, recovery_key_status, generation_run_id, generation_key
  ) values (
    gen_random_uuid(), 'car-zone-phase4b1-v3', input_max_evidence_age_seconds,
    canonical_scopes, 'required', 'unknown', current_run.id, current_run.generation_key
  )
  on conflict (generation_key) where generation_key is not null
  do update set generation_key = excluded.generation_key
  returning * into result;
  if result.generation_run_id is distinct from current_run.id then
    raise exception using errcode = '55000', message = 'BACKUP_V2_RECOVERY_SET_GENERATION_CONFLICT';
  end if;
  return result;
end;
$$;

create function public.heartbeat_backup_v2_run_lease(
  target_run_id uuid, expected_owner_ref text, expected_generation bigint, lease_seconds integer
)
returns public.backup_v2_runs
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare current_run public.backup_v2_runs%rowtype;
begin
  if expected_owner_ref is null or length(btrim(expected_owner_ref)) not between 1 and 160
    or lease_seconds not between 15 and 3600 or expected_generation <= 0 then
    raise exception using errcode = '22023', message = 'BACKUP_V2_LEASE_INPUT_INVALID';
  end if;
  select * into current_run from public.backup_v2_runs where id = target_run_id for update;
  if current_run.id is null then
    raise exception using errcode = 'P0002', message = 'BACKUP_V2_RUN_NOT_FOUND';
  end if;
  if current_run.contract_version <> 'phase4b1'
    or current_run.lifecycle_state not in ('preflight', 'running', 'validating')
    or current_run.lease_owner_ref is distinct from btrim(expected_owner_ref)
    or current_run.lease_generation is distinct from expected_generation
    or current_run.lease_expires_at <= now() then
    raise exception using errcode = '55000', message = 'BACKUP_V2_LEASE_NOT_AUTHORITATIVE';
  end if;
  update public.backup_v2_runs set
    heartbeat_at = now(),
    lease_expires_at = now() + make_interval(secs => lease_seconds)
  where id = target_run_id returning * into current_run;
  return current_run;
end;
$$;

create function public.backup_v2_assert_current_lease(
  current_run public.backup_v2_runs, expected_owner_ref text, expected_generation bigint
)
returns void
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  if expected_owner_ref is null
    or length(btrim(expected_owner_ref)) not between 1 and 160
    or expected_generation is null
    or expected_generation <= 0
    or current_run.contract_version <> 'phase4b1'
    or current_run.lifecycle_state not in ('preflight', 'running', 'validating')
    or current_run.lease_owner_ref is null
    or current_run.lease_owner_ref is distinct from btrim(expected_owner_ref)
    or current_run.lease_generation is distinct from expected_generation
    or current_run.lease_expires_at is null
    or current_run.lease_expires_at <= now() then
    raise exception using errcode = '55000', message = 'BACKUP_V2_LEASE_NOT_AUTHORITATIVE';
  end if;
end;
$$;

create function public.backup_v2_assert_authoritative_preflight(
  current_run public.backup_v2_runs
)
returns void
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare accepted_snapshot public.backup_v2_catalog_snapshots%rowtype;
begin
  select * into accepted_snapshot
  from public.backup_v2_catalog_snapshots
  where id=current_run.preflight_snapshot_id
    and run_id=current_run.id
    and generation_key=current_run.generation_key;
  if accepted_snapshot.id is null
    or accepted_snapshot.preflight_outcome<>'go'
    or current_run.preflight_outcome<>'go'
    or accepted_snapshot.preflight_expires_at<=now()
    or accepted_snapshot.catalog_fingerprint is distinct from public.backup_v2_current_catalog_fingerprint() then
    raise exception using errcode='55000',message='BACKUP_V2_PREFLIGHT_NOT_AUTHORITATIVE';
  end if;
end;
$$;

create function public.attest_backup_v2_recovery_key_availability(
  target_run_id uuid,
  expected_owner_ref text,
  expected_generation bigint,
  target_recovery_set_id uuid,
  input_key_version text,
  input_key_safe_ref text,
  input_key_public_fingerprint text
)
returns public.backup_v2_recovery_sets
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_run public.backup_v2_runs%rowtype;
  result public.backup_v2_recovery_sets%rowtype;
begin
  select * into current_run from public.backup_v2_runs where id = target_run_id for update;
  if current_run.id is null then
    raise exception using errcode = 'P0002', message = 'BACKUP_V2_RUN_NOT_FOUND';
  end if;
  perform public.backup_v2_assert_current_lease(
    current_run, expected_owner_ref, expected_generation
  );
  perform public.backup_v2_assert_authoritative_preflight(current_run);
  select * into result
  from public.backup_v2_recovery_sets
  where id = target_recovery_set_id
    and generation_run_id = current_run.id
    and generation_key = current_run.generation_key
  for update;
  if result.id is null then
    raise exception using errcode = 'P0002', message = 'BACKUP_V2_RECOVERY_SET_NOT_FOUND';
  end if;
  if current_run.lifecycle_state <> 'validating'
    or result.lifecycle_state <> 'assembling'
    or result.policy_version not like 'car-zone-phase4b1%'
    or input_key_version !~ '^[A-Za-z0-9._:@/-]{1,80}$'
    or input_key_safe_ref !~ '^[A-Za-z0-9._:@/-]{1,160}$'
    or input_key_public_fingerprint !~ '^[A-Za-z0-9._:@/+:-]{16,160}$' then
    raise exception using errcode = '22023', message = 'BACKUP_V2_RECOVERY_KEY_EVIDENCE_INVALID';
  end if;
  update public.backup_v2_recovery_sets set
    recovery_key_status = 'availability_attested',
    recovery_key_version = input_key_version,
    recovery_key_safe_ref = input_key_safe_ref,
    recovery_key_public_fingerprint = input_key_public_fingerprint,
    recovery_key_attested_at = now(),
    recovery_key_evidence_origin = 'runtime_verified',
    recovery_key_attested_by_owner_ref = btrim(expected_owner_ref),
    recovery_key_attested_lease_generation = expected_generation
  where id = target_recovery_set_id
  returning * into result;
  return result;
end;
$$;

create or replace function public.transition_backup_v2_run(
  target_run_id uuid, expected_scope text, expected_state text, target_state text,
  event_actor_type text, event_worker_identity_ref text default null, event_attempt integer default 1,
  event_sanitized_code text default null, event_sanitized_metadata jsonb default '{}'::jsonb
)
returns public.backup_v2_runs
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare current_run public.backup_v2_runs%rowtype; next_sequence integer;
begin
  select * into current_run from public.backup_v2_runs where id = target_run_id for update;
  if current_run.id is null then
    raise exception using errcode = 'P0002', message = 'BACKUP_V2_RUN_NOT_FOUND';
  end if;
  if current_run.contract_version = 'phase4b1' then
    raise exception using errcode = '55000', message = 'BACKUP_V2_FENCED_TRANSITION_REQUIRED';
  end if;
  if expected_scope not in (
      'database', 'auth', 'storage_metadata', 'storage_objects', 'external_assets'
    )
    or current_run.scope is distinct from expected_scope then
    raise exception using errcode = '23514', message = 'BACKUP_V2_EVENT_SCOPE_MISMATCH';
  end if;
  if current_run.lifecycle_state is distinct from expected_state then
    raise exception using errcode = '23514', message = 'BACKUP_V2_EVENT_FROM_STATE_MISMATCH';
  end if;
  if event_actor_type not in ('system', 'worker', 'operator') or event_attempt <= 0
    or jsonb_typeof(event_sanitized_metadata) <> 'object'
    or pg_column_size(event_sanitized_metadata) > 4096 then
    raise exception using errcode = '22023', message = 'BACKUP_V2_EVENT_INPUT_INVALID';
  end if;
  if target_state in ('validating', 'completed', 'completed_with_warnings')
    and (current_run.relations_unknown <> 0
      or current_run.relations_classified <> current_run.relations_discovered) then
    raise exception using errcode = '23514', message = 'BACKUP_V2_CATALOG_CLASSIFICATION_INCOMPLETE';
  end if;
  select coalesce(max(sequence_number), 0) + 1 into next_sequence
  from public.backup_v2_run_events where run_id = target_run_id;
  perform set_config('app.backup_v2_transition_run_id', target_run_id::text, true);
  update public.backup_v2_runs set
    lifecycle_state = target_state,
    started_at = case when target_state = 'preflight' then coalesce(started_at, now()) else started_at end,
    finished_at = case when target_state in ('completed','completed_with_warnings','failed','cancelled') then now() else null end,
    terminal_error_code = case when target_state = 'failed' then
      coalesce(nullif(left(btrim(coalesce(event_sanitized_code, '')),80),''),'BACKUP_V2_FAILED') else null end,
    terminal_error_summary = null
  where id = target_run_id returning * into current_run;
  insert into public.backup_v2_run_events(
    run_id, scope, sequence_number, previous_state, next_state, actor_type,
    worker_identity_ref, attempt, sanitized_code, sanitized_metadata
  ) values (
    target_run_id, expected_scope, next_sequence, expected_state, target_state, event_actor_type,
    event_worker_identity_ref, event_attempt, event_sanitized_code, event_sanitized_metadata
  );
  return current_run;
end;
$$;

create function public.transition_backup_v2_run_fenced(
  target_run_id uuid,
  expected_scope text,
  expected_state text,
  target_state text,
  expected_owner_ref text,
  expected_generation bigint,
  event_actor_type text,
  event_worker_identity_ref text default null,
  event_attempt integer default 1,
  event_sanitized_code text default null,
  event_sanitized_metadata jsonb default '{}'::jsonb
)
returns public.backup_v2_runs
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_run public.backup_v2_runs%rowtype;
  next_sequence integer;
begin
  select * into current_run from public.backup_v2_runs where id = target_run_id for update;
  if current_run.id is null then
    raise exception using errcode = 'P0002', message = 'BACKUP_V2_RUN_NOT_FOUND';
  end if;
  perform public.backup_v2_assert_current_lease(current_run, expected_owner_ref, expected_generation);
  if current_run.scope is distinct from expected_scope
    or current_run.lifecycle_state is distinct from expected_state then
    raise exception using errcode = '23514', message = 'BACKUP_V2_EVENT_STATE_OR_SCOPE_MISMATCH';
  end if;
  if event_actor_type not in ('system', 'worker', 'operator') or event_attempt <= 0
    or event_worker_identity_ref is distinct from expected_owner_ref
    or jsonb_typeof(event_sanitized_metadata) <> 'object'
    or pg_column_size(event_sanitized_metadata) > 4096 then
    raise exception using errcode = '22023', message = 'BACKUP_V2_EVENT_INPUT_INVALID';
  end if;
  if target_state not in ('failed', 'cancelled') then
    perform public.backup_v2_assert_authoritative_preflight(current_run);
  end if;
  if target_state in ('completed', 'completed_with_warnings') and not exists (
    select 1
    from public.backup_v2_recovery_sets recovery_set
    where recovery_set.lifecycle_state = 'full_dr_ready'
      and recovery_set.policy_version like 'car-zone-phase4b1%'
      and recovery_set.generation_run_id = current_run.id
      and recovery_set.generation_key = current_run.generation_key
      and recovery_set.required_scopes = current_run.generation_scope_set
  ) then
    raise exception using errcode = '23514', message = 'BACKUP_V2_FULL_DR_INCOMPLETE';
  end if;
  select coalesce(max(sequence_number), 0) + 1 into next_sequence
  from public.backup_v2_run_events where run_id = target_run_id;
  perform set_config('app.backup_v2_transition_run_id', target_run_id::text, true);
  update public.backup_v2_runs set
    lifecycle_state = target_state,
    finished_at = case when target_state in ('completed','completed_with_warnings','failed','cancelled') then now() else null end,
    terminal_error_code = case when target_state = 'failed' then
      coalesce(nullif(left(btrim(coalesce(event_sanitized_code, '')),80),''),'BACKUP_V2_FAILED') else null end,
    terminal_error_summary = null,
    lease_owner_ref = case when target_state in ('completed','completed_with_warnings','failed','cancelled') then null else lease_owner_ref end,
    lease_acquired_at = case when target_state in ('completed','completed_with_warnings','failed','cancelled') then null else lease_acquired_at end,
    heartbeat_at = case when target_state in ('completed','completed_with_warnings','failed','cancelled') then null else heartbeat_at end,
    lease_expires_at = case when target_state in ('completed','completed_with_warnings','failed','cancelled') then null else lease_expires_at end
  where id = target_run_id returning * into current_run;
  insert into public.backup_v2_run_events(
    run_id, scope, sequence_number, previous_state, next_state, actor_type,
    worker_identity_ref, attempt, sanitized_code, sanitized_metadata
  ) values (
    target_run_id, expected_scope, next_sequence, expected_state, target_state, event_actor_type,
    event_worker_identity_ref, event_attempt, event_sanitized_code, event_sanitized_metadata
  );
  return current_run;
end;
$$;

create function public.record_backup_v2_artifact(
  target_run_id uuid,
  expected_owner_ref text,
  expected_generation bigint,
  target_recovery_set_id uuid,
  input_component text,
  input_artifact_id text,
  input_format_version text,
  input_artifact_version text,
  input_ciphertext_size_bytes numeric,
  input_ciphertext_hash text,
  input_compatibility_ref text,
  input_key_version text,
  input_key_safe_ref text,
  input_key_public_fingerprint text
)
returns public.backup_v2_artifacts
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_run public.backup_v2_runs%rowtype;
  recovery_set public.backup_v2_recovery_sets%rowtype;
  result public.backup_v2_artifacts%rowtype;
begin
  select * into current_run from public.backup_v2_runs where id = target_run_id for update;
  if current_run.id is null then raise exception using errcode='P0002',message='BACKUP_V2_RUN_NOT_FOUND'; end if;
  perform public.backup_v2_assert_current_lease(current_run, expected_owner_ref, expected_generation);
  perform public.backup_v2_assert_authoritative_preflight(current_run);
  select * into recovery_set
  from public.backup_v2_recovery_sets
  where id = target_recovery_set_id
  for update;
  if current_run.lifecycle_state not in ('running', 'validating')
    or recovery_set.id is null
    or recovery_set.lifecycle_state <> 'assembling'
    or recovery_set.generation_run_id is distinct from current_run.id
    or recovery_set.generation_key is distinct from current_run.generation_key
    or input_component <> all(current_run.generation_scope_set)
    or input_artifact_id is null or length(btrim(input_artifact_id)) not between 1 and 160
    or input_ciphertext_size_bytes is null or input_ciphertext_size_bytes < 0
    or trunc(input_ciphertext_size_bytes) <> input_ciphertext_size_bytes
    or input_ciphertext_hash !~ '^[0-9a-f]{64}$'
    or length(btrim(input_format_version)) not between 1 and 80
    or length(btrim(input_artifact_version)) not between 1 and 80
    or length(btrim(input_compatibility_ref)) not between 1 and 160
    or length(btrim(input_key_version)) not between 1 and 80
    or length(btrim(input_key_safe_ref)) not between 1 and 160
    or length(btrim(input_key_public_fingerprint)) not between 16 and 160
  then raise exception using errcode='22023',message='BACKUP_V2_INVALID_ARTIFACT_EVIDENCE'; end if;
  insert into public.backup_v2_artifacts(
    artifact_id,recovery_set_id,run_id,generation_key,component,format_version,artifact_version,
    artifact_size_bytes,ciphertext_size_bytes,hash_algorithm,ciphertext_hash,encryption_algorithm,
    key_version,key_safe_ref,key_public_fingerprint,compatibility_ref,verification_status,evidence_origin,
    created_by_owner_ref,created_lease_generation
  ) values (
    btrim(input_artifact_id),target_recovery_set_id,target_run_id,current_run.generation_key,input_component,
    btrim(input_format_version),btrim(input_artifact_version),input_ciphertext_size_bytes,
    input_ciphertext_size_bytes,'sha256',input_ciphertext_hash,'aes-256-gcm',btrim(input_key_version),
    btrim(input_key_safe_ref),btrim(input_key_public_fingerprint),btrim(input_compatibility_ref),
    'unverified','synthetic_fixture',btrim(expected_owner_ref),expected_generation
  ) returning * into result;
  return result;
end;
$$;

create function public.verify_backup_v2_artifact(
  target_run_id uuid,
  expected_owner_ref text,
  expected_generation bigint,
  target_artifact_id uuid,
  observed_ciphertext_size_bytes numeric,
  observed_ciphertext_hash text
)
returns public.backup_v2_artifacts
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare current_run public.backup_v2_runs%rowtype; result public.backup_v2_artifacts%rowtype;
begin
  select * into current_run from public.backup_v2_runs where id=target_run_id for update;
  if current_run.id is null then raise exception using errcode='P0002',message='BACKUP_V2_RUN_NOT_FOUND'; end if;
  perform public.backup_v2_assert_current_lease(current_run, expected_owner_ref, expected_generation);
  perform public.backup_v2_assert_authoritative_preflight(current_run);
  select * into result from public.backup_v2_artifacts
  where id=target_artifact_id and run_id=target_run_id for update;
  if result.id is null then raise exception using errcode='P0002',message='BACKUP_V2_ARTIFACT_NOT_FOUND'; end if;
  if current_run.lifecycle_state not in ('running','validating')
    or observed_ciphertext_size_bytes is distinct from result.ciphertext_size_bytes
    or observed_ciphertext_hash is distinct from result.ciphertext_hash then
    raise exception using errcode='23514',message='BACKUP_V2_ARTIFACT_VERIFICATION_FAILED';
  end if;
  update public.backup_v2_artifacts set verification_status='verified',evidence_origin='runtime_verified',
    verified_at=now(),verified_by_owner_ref=btrim(expected_owner_ref),
    verified_lease_generation=expected_generation
  where id=target_artifact_id returning * into result;
  return result;
end;
$$;

create function public.record_backup_v2_artifact_copy(
  target_run_id uuid,
  expected_owner_ref text,
  expected_generation bigint,
  target_artifact_id uuid,
  input_copy_id text,
  input_copy_role text,
  input_provider_neutral_ref text,
  input_physical_object_identity text,
  input_independence_domain text,
  input_ciphertext_size_bytes numeric,
  input_ciphertext_hash text
)
returns public.backup_v2_artifact_copies
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_run public.backup_v2_runs%rowtype;
  artifact public.backup_v2_artifacts%rowtype;
  result public.backup_v2_artifact_copies%rowtype;
begin
  select * into current_run from public.backup_v2_runs where id=target_run_id for update;
  if current_run.id is null then raise exception using errcode='P0002',message='BACKUP_V2_RUN_NOT_FOUND'; end if;
  perform public.backup_v2_assert_current_lease(current_run, expected_owner_ref, expected_generation);
  perform public.backup_v2_assert_authoritative_preflight(current_run);
  select * into artifact from public.backup_v2_artifacts
  where id=target_artifact_id and run_id=target_run_id for update;
  if artifact.id is null or artifact.verification_status <> 'verified'
    or input_copy_role not in ('primary','secondary_independent','optional_offline')
    or length(btrim(input_copy_id)) not between 1 and 160
    or length(btrim(input_provider_neutral_ref)) not between 1 and 240
    or length(btrim(input_physical_object_identity)) not between 1 and 240
    or (input_copy_role='secondary_independent' and length(btrim(input_independence_domain)) not between 1 and 160)
    or input_ciphertext_size_bytes is distinct from artifact.ciphertext_size_bytes
    or input_ciphertext_hash is distinct from artifact.ciphertext_hash then
    raise exception using errcode='23514',message='BACKUP_V2_COPY_EQUIVALENCE_FAILED';
  end if;
  insert into public.backup_v2_artifact_copies(
    copy_id,artifact_id,copy_role,provider_neutral_ref,physical_object_identity,independence_domain,
    ciphertext_size_bytes,ciphertext_hash,verification_status,evidence_origin,
    recorded_by_owner_ref,recorded_lease_generation
  ) values (
    btrim(input_copy_id),target_artifact_id,input_copy_role,btrim(input_provider_neutral_ref),
    btrim(input_physical_object_identity),nullif(btrim(input_independence_domain),''),
    input_ciphertext_size_bytes,input_ciphertext_hash,'unverified','synthetic_fixture',
    btrim(expected_owner_ref),expected_generation
  ) returning * into result;
  return result;
end;
$$;

create function public.verify_backup_v2_artifact_copy(
  target_run_id uuid,
  expected_owner_ref text,
  expected_generation bigint,
  target_copy_id uuid,
  observed_ciphertext_size_bytes numeric,
  observed_ciphertext_hash text
)
returns public.backup_v2_artifact_copies
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_run public.backup_v2_runs%rowtype;
  artifact public.backup_v2_artifacts%rowtype;
  result public.backup_v2_artifact_copies%rowtype;
begin
  select * into current_run from public.backup_v2_runs where id=target_run_id for update;
  if current_run.id is null then raise exception using errcode='P0002',message='BACKUP_V2_RUN_NOT_FOUND'; end if;
  perform public.backup_v2_assert_current_lease(current_run, expected_owner_ref, expected_generation);
  perform public.backup_v2_assert_authoritative_preflight(current_run);
  select copy.* into result from public.backup_v2_artifact_copies copy
  join public.backup_v2_artifacts artifact_row on artifact_row.id=copy.artifact_id
  where copy.id=target_copy_id and artifact_row.run_id=target_run_id for update of copy;
  if result.id is null then raise exception using errcode='P0002',message='BACKUP_V2_COPY_NOT_FOUND'; end if;
  select * into artifact from public.backup_v2_artifacts where id=result.artifact_id;
  if observed_ciphertext_size_bytes is distinct from result.ciphertext_size_bytes
    or observed_ciphertext_hash is distinct from result.ciphertext_hash
    or result.ciphertext_size_bytes is distinct from artifact.ciphertext_size_bytes
    or result.ciphertext_hash is distinct from artifact.ciphertext_hash then
    raise exception using errcode='23514',message='BACKUP_V2_COPY_VERIFICATION_FAILED';
  end if;
  update public.backup_v2_artifact_copies set verification_status='verified',evidence_origin='runtime_verified',
    verified_at=now(),verified_by_owner_ref=btrim(expected_owner_ref),
    verified_lease_generation=expected_generation
  where id=target_copy_id returning * into result;
  return result;
end;
$$;

create or replace function public.backup_v2_validate_component()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  run_record public.backup_v2_runs%rowtype;
  set_record public.backup_v2_recovery_sets%rowtype;
begin
  select * into set_record from public.backup_v2_recovery_sets where id=new.recovery_set_id for update;
  if set_record.lifecycle_state <> 'assembling' then
    raise exception using errcode='55000',message='BACKUP_V2_RECOVERY_COMPONENTS_IMMUTABLE';
  end if;
  select * into run_record from public.backup_v2_runs where id=new.run_id;
  if set_record.policy_version like 'car-zone-phase4b1%' then
    if run_record.id is null
      or run_record.contract_version <> 'phase4b1'
      or new.generation_key is null
      or new.generation_key is distinct from set_record.generation_key
      or new.generation_key is distinct from run_record.generation_key
      or set_record.generation_run_id is distinct from run_record.id then
      raise exception using errcode='23514',message='BACKUP_V2_COMPONENT_GENERATION_CONTRACT_INVALID';
    end if;
    if current_user='service_role' then
      raise exception using errcode='42501',message='BACKUP_V2_CANONICAL_COMPONENT_EVIDENCE_REQUIRED';
    end if;
    if not new.scope=any(run_record.generation_scope_set)
      or new.completion_status='completed' and (
        run_record.lifecycle_state <> 'validating'
        or new.evidence_lease_owner_ref is distinct from run_record.lease_owner_ref
        or new.evidence_lease_generation is distinct from run_record.lease_generation
        or run_record.lease_expires_at <= now()
      ) then
      raise exception using errcode='23514',message='BACKUP_V2_COMPONENT_FENCING_OR_SCOPE_INVALID';
    end if;
  elsif run_record.contract_version='phase4b1' then
    raise exception using errcode='23514',message='BACKUP_V2_COMPONENT_RECOVERY_CONTRACT_INVALID';
  else
    if run_record.scope is distinct from new.scope then
      raise exception using errcode='23514',message='BACKUP_V2_COMPONENT_SCOPE_MISMATCH';
    end if;
    if new.completion_status='completed'
      and run_record.lifecycle_state not in ('completed','completed_with_warnings') then
      raise exception using errcode='23514',message='BACKUP_V2_COMPONENT_RUN_NOT_COMPLETED';
    end if;
  end if;
  new.updated_at:=now();
  return new;
end;
$$;

create function public.record_backup_v2_component_evidence(
  target_run_id uuid,
  expected_owner_ref text,
  expected_generation bigint,
  target_recovery_set_id uuid,
  input_component text,
  input_backup_format_version text,
  input_schema_compatibility_ref text,
  input_exporter_version text
)
returns public.backup_v2_recovery_set_components
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare current_run public.backup_v2_runs%rowtype; result public.backup_v2_recovery_set_components%rowtype;
begin
  select * into current_run from public.backup_v2_runs where id=target_run_id for update;
  if current_run.id is null then raise exception using errcode='P0002',message='BACKUP_V2_RUN_NOT_FOUND'; end if;
  perform public.backup_v2_assert_current_lease(current_run,expected_owner_ref,expected_generation);
  perform public.backup_v2_assert_authoritative_preflight(current_run);
  if current_run.lifecycle_state <> 'validating' or not input_component=any(current_run.generation_scope_set)
    or not exists(select 1 from public.backup_v2_artifacts where recovery_set_id=target_recovery_set_id
      and run_id=target_run_id and component=input_component and verification_status='verified')
    or length(btrim(input_backup_format_version)) not between 1 and 80
    or length(btrim(input_schema_compatibility_ref)) not between 1 and 160
    or length(btrim(input_exporter_version)) not between 1 and 80 then
    raise exception using errcode='23514',message='BACKUP_V2_COMPONENT_EVIDENCE_INVALID';
  end if;
  insert into public.backup_v2_recovery_set_components(
    recovery_set_id,scope,run_id,generation_key,artifact_status,completion_status,integrity_status,
    compatibility_status,backup_format_version,schema_compatibility_ref,exporter_version,
    compatibility_verified_at,primary_copy_requirement,primary_copy_status,offsite_copy_requirement,
    offsite_copy_status,evidence_origin,fail_closed_reasons,evidence_lease_owner_ref,
    evidence_lease_generation,canonical_evidence_recorded_at
  ) values (
    target_recovery_set_id,input_component,target_run_id,current_run.generation_key,
    'present','completed','verified','verified',
    btrim(input_backup_format_version),btrim(input_schema_compatibility_ref),btrim(input_exporter_version),
    now(),'required','unknown','required','unknown','runtime_verified','{}'::text[],
    btrim(expected_owner_ref),expected_generation,now()
  )
  on conflict(recovery_set_id,scope) do update set
    run_id=excluded.run_id,generation_key=excluded.generation_key,
    artifact_status=excluded.artifact_status,
    completion_status=excluded.completion_status,integrity_status=excluded.integrity_status,
    compatibility_status=excluded.compatibility_status,backup_format_version=excluded.backup_format_version,
    schema_compatibility_ref=excluded.schema_compatibility_ref,exporter_version=excluded.exporter_version,
    compatibility_verified_at=excluded.compatibility_verified_at,evidence_origin=excluded.evidence_origin,
    fail_closed_reasons=excluded.fail_closed_reasons,
    evidence_lease_owner_ref=excluded.evidence_lease_owner_ref,
    evidence_lease_generation=excluded.evidence_lease_generation,
    canonical_evidence_recorded_at=excluded.canonical_evidence_recorded_at
  returning * into result;
  return result;
end;
$$;

create or replace function public.backup_v2_enforce_recovery_set_state()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  verified_component_count integer;
  required_component_count integer;
  bound_run public.backup_v2_runs%rowtype;
begin
  if tg_op='INSERT' then
    if new.lifecycle_state<>'assembling' then
      raise exception using errcode='23514',message='BACKUP_V2_RECOVERY_INITIAL_STATE_INVALID';
    end if;
    if new.policy_version like 'car-zone-phase4b1%' then
      if current_user='service_role' then
        raise exception using errcode='42501',message='BACKUP_V2_CANONICAL_RECOVERY_SET_CREATION_REQUIRED';
      end if;
      select * into bound_run from public.backup_v2_runs
      where id=new.generation_run_id;
      if bound_run.id is null or bound_run.contract_version<>'phase4b1'
        or bound_run.generation_key is distinct from new.generation_key
        or bound_run.generation_scope_set is distinct from new.required_scopes then
        raise exception using errcode='23514',message='BACKUP_V2_RECOVERY_SET_GENERATION_INVALID';
      end if;
    end if;
    return new;
  end if;
  if new.generation_run_id is distinct from old.generation_run_id
    or new.generation_key is distinct from old.generation_key then
    raise exception using errcode='55000',message='BACKUP_V2_RECOVERY_SET_GENERATION_IMMUTABLE';
  end if;
  if old.policy_version like 'car-zone-phase4b1%' and (
      new.policy_version is distinct from old.policy_version
      or new.required_scopes is distinct from old.required_scopes
    ) then
    raise exception using errcode='55000',message='BACKUP_V2_RECOVERY_SET_POLICY_IMMUTABLE';
  end if;
  if (old.policy_version like 'car-zone-phase4b1%'
      or new.policy_version like 'car-zone-phase4b1%')
    and current_user='service_role' then
    raise exception using errcode='42501',message='BACKUP_V2_CANONICAL_READINESS_OPERATION_REQUIRED';
  end if;
  if new.policy_version like 'car-zone-phase4b1%' then
    select * into bound_run from public.backup_v2_runs
    where id=new.generation_run_id and generation_key=new.generation_key;
    if bound_run.id is null then
      raise exception using errcode='23514',message='BACKUP_V2_RECOVERY_SET_GENERATION_INVALID';
    end if;
  end if;
  if old.lifecycle_state in ('full_dr_ready','failed','expired') then
    raise exception using errcode='55000',message='BACKUP_V2_RECOVERY_TERMINAL_STATE_IMMUTABLE';
  end if;
  if new.lifecycle_state=old.lifecycle_state then return new; end if;
  if new.lifecycle_state not in ('full_dr_ready','failed','expired') then
    raise exception using errcode='23514',message='BACKUP_V2_RECOVERY_STATE_TRANSITION_INVALID';
  end if;
  if new.lifecycle_state='full_dr_ready' then
    required_component_count:=cardinality(new.required_scopes);
    if new.policy_version like 'car-zone-phase4b1%' then
      if current_setting('app.backup_v2_readiness_set_id',true) is distinct from new.id::text then
        raise exception using errcode='55000',message='BACKUP_V2_CANONICAL_READINESS_OPERATION_REQUIRED';
      end if;
      select count(distinct artifact.component) into verified_component_count
      from public.backup_v2_artifacts artifact
      join public.backup_v2_runs run
        on run.id=new.generation_run_id and run.generation_key=new.generation_key
      join public.backup_v2_recovery_set_components component
        on component.recovery_set_id=artifact.recovery_set_id
        and component.scope=artifact.component and component.run_id=new.generation_run_id
        and component.generation_key=new.generation_key
      join public.backup_v2_artifact_copies primary_copy
        on primary_copy.artifact_id=artifact.id and primary_copy.copy_role='primary'
      join public.backup_v2_artifact_copies secondary_copy
        on secondary_copy.artifact_id=artifact.id and secondary_copy.copy_role='secondary_independent'
      where artifact.recovery_set_id=new.id
        and artifact.run_id=new.generation_run_id
        and artifact.generation_key=new.generation_key
        and artifact.component=any(new.required_scopes)
        and artifact.verification_status='verified' and artifact.evidence_origin='runtime_verified'
        and artifact.ciphertext_hash is not null and artifact.ciphertext_size_bytes is not null
        and artifact.verified_at<=now()
        and (new.max_evidence_age_seconds is null
          or artifact.verified_at>=now()-make_interval(secs=>new.max_evidence_age_seconds))
        and component.completion_status='completed' and component.integrity_status='verified'
        and component.compatibility_status='verified' and component.evidence_origin='runtime_verified'
        and cardinality(component.fail_closed_reasons)=0
        and component.evidence_lease_owner_ref=run.lease_owner_ref
        and component.evidence_lease_generation=run.lease_generation
        and run.lease_expires_at>now()
        and primary_copy.verification_status='verified' and primary_copy.evidence_origin='runtime_verified'
        and secondary_copy.verification_status='verified' and secondary_copy.evidence_origin='runtime_verified'
        and primary_copy.ciphertext_hash=artifact.ciphertext_hash
        and secondary_copy.ciphertext_hash=artifact.ciphertext_hash
        and primary_copy.ciphertext_size_bytes=artifact.ciphertext_size_bytes
        and secondary_copy.ciphertext_size_bytes=artifact.ciphertext_size_bytes
        and primary_copy.provider_neutral_ref<>secondary_copy.provider_neutral_ref
        and primary_copy.physical_object_identity<>secondary_copy.physical_object_identity
        and primary_copy.independence_domain is not null
        and secondary_copy.independence_domain is not null
        and primary_copy.independence_domain<>secondary_copy.independence_domain
        and primary_copy.verified_by_owner_ref=component.evidence_lease_owner_ref
        and secondary_copy.verified_by_owner_ref=component.evidence_lease_owner_ref
        and primary_copy.verified_lease_generation=component.evidence_lease_generation
        and secondary_copy.verified_lease_generation=component.evidence_lease_generation;
    else
      select count(*) into verified_component_count
      from public.backup_v2_recovery_set_components
      where recovery_set_id=new.id and scope=any(new.required_scopes)
        and artifact_status='present' and completion_status='completed' and integrity_status='verified'
        and compatibility_status='verified' and backup_format_version is not null
        and schema_compatibility_ref is not null and exporter_version is not null
        and compatibility_verified_at is not null and compatibility_verified_at<=now()
        and (new.max_evidence_age_seconds is null
          or compatibility_verified_at>=now()-make_interval(secs=>new.max_evidence_age_seconds))
        and primary_copy_requirement='required' and primary_copy_status='verified'
        and primary_copy_ref is not null and primary_copy_verified_at is not null
        and primary_copy_verified_at<=now()
        and (new.max_evidence_age_seconds is null
          or primary_copy_verified_at>=now()-make_interval(secs=>new.max_evidence_age_seconds))
        and (offsite_copy_requirement='optional' or (
          offsite_copy_status='verified' and offsite_copy_ref is not null
          and offsite_copy_ref is distinct from primary_copy_ref and offsite_copy_verified_at is not null
          and offsite_copy_verified_at<=now() and (new.max_evidence_age_seconds is null
            or offsite_copy_verified_at>=now()-make_interval(secs=>new.max_evidence_age_seconds))
        ))
        and cardinality(fail_closed_reasons)=0 and evidence_origin='runtime_verified';
    end if;
    if verified_component_count<>required_component_count
      or (new.recovery_key_requirement='required' and (
        new.recovery_key_status<>'availability_attested'
        or new.recovery_key_version is null or new.recovery_key_safe_ref is null
        or new.recovery_key_public_fingerprint is null or new.recovery_key_attested_at is null
        or new.recovery_key_evidence_origin<>'runtime_verified'
        or new.recovery_key_attested_by_owner_ref is distinct from bound_run.lease_owner_ref
        or new.recovery_key_attested_lease_generation is distinct from bound_run.lease_generation
        or new.recovery_key_attested_at>now()
        or (new.max_evidence_age_seconds is not null
          and new.recovery_key_attested_at<now()-make_interval(secs=>new.max_evidence_age_seconds))
      )) then
      raise exception using errcode='23514',message='BACKUP_V2_FULL_DR_INCOMPLETE';
    end if;
  end if;
  return new;
end;
$$;

create function public.finalize_backup_v2_recovery_set(
  target_recovery_set_id uuid,
  target_run_id uuid,
  expected_owner_ref text,
  expected_generation bigint
)
returns public.backup_v2_recovery_sets
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare current_run public.backup_v2_runs%rowtype; result public.backup_v2_recovery_sets%rowtype;
begin
  select * into current_run from public.backup_v2_runs where id=target_run_id for update;
  if current_run.id is null then raise exception using errcode='P0002',message='BACKUP_V2_RUN_NOT_FOUND'; end if;
  perform public.backup_v2_assert_current_lease(current_run,expected_owner_ref,expected_generation);
  perform public.backup_v2_assert_authoritative_preflight(current_run);
  if current_run.lifecycle_state<>'validating' then
    raise exception using errcode='55000',message='BACKUP_V2_READINESS_STATE_INVALID';
  end if;
  perform set_config('app.backup_v2_readiness_set_id',target_recovery_set_id::text,true);
  update public.backup_v2_recovery_sets set lifecycle_state='full_dr_ready',ready_at=now()
  where id=target_recovery_set_id and lifecycle_state='assembling'
    and policy_version like 'car-zone-phase4b1%'
    and generation_run_id=current_run.id
    and generation_key=current_run.generation_key
    and required_scopes=current_run.generation_scope_set
  returning * into result;
  if result.id is null then
    raise exception using errcode='P0002',message='BACKUP_V2_RECOVERY_SET_NOT_FOUND_OR_INVALID';
  end if;
  return result;
end;
$$;

alter table public.backup_v2_catalog_snapshots enable row level security;
alter table public.backup_v2_artifacts enable row level security;
alter table public.backup_v2_artifact_copies enable row level security;

revoke all on table public.backup_v2_catalog_snapshots from public, anon, authenticated, service_role;
revoke all on table public.backup_v2_artifacts from public, anon, authenticated, service_role;
revoke all on table public.backup_v2_artifact_copies from public, anon, authenticated, service_role;
grant select on table public.backup_v2_catalog_snapshots to service_role;
grant select on table public.backup_v2_artifacts to service_role;
grant select on table public.backup_v2_artifact_copies to service_role;

revoke all on function public.backup_v2_normalize_scope_set(text[]) from public, anon, authenticated;
grant execute on function public.backup_v2_normalize_scope_set(text[]) to service_role;
revoke all on function public.backup_v2_catalog_field(text) from public, anon, authenticated, service_role;
revoke all on function public.backup_v2_classify_catalog_relation(text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.backup_v2_current_catalog() from public, anon, authenticated, service_role;
revoke all on function public.backup_v2_current_catalog_fingerprint() from public, anon, authenticated, service_role;
revoke all on function public.backup_v2_assert_current_lease(public.backup_v2_runs,text,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.backup_v2_assert_authoritative_preflight(public.backup_v2_runs)
  from public, anon, authenticated, service_role;

revoke all on function public.create_or_get_backup_v2_generation(text,text,timestamptz,text[],text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.create_or_get_backup_v2_recovery_set(uuid,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.record_backup_v2_measurement(uuid,text,timestamptz,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.prepare_backup_v2_preflight(uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_backup_v2_run_lease(uuid,text,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.heartbeat_backup_v2_run_lease(uuid,text,bigint,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.attest_backup_v2_recovery_key_availability(uuid,text,bigint,uuid,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.transition_backup_v2_run_fenced(uuid,text,text,text,text,bigint,text,text,integer,text,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.record_backup_v2_artifact(uuid,text,bigint,uuid,text,text,text,text,numeric,text,text,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.verify_backup_v2_artifact(uuid,text,bigint,uuid,numeric,text)
  from public, anon, authenticated, service_role;
revoke all on function public.record_backup_v2_artifact_copy(uuid,text,bigint,uuid,text,text,text,text,text,numeric,text)
  from public, anon, authenticated, service_role;
revoke all on function public.verify_backup_v2_artifact_copy(uuid,text,bigint,uuid,numeric,text)
  from public, anon, authenticated, service_role;
revoke all on function public.record_backup_v2_component_evidence(uuid,text,bigint,uuid,text,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_backup_v2_recovery_set(uuid,uuid,text,bigint)
  from public, anon, authenticated, service_role;

grant execute on function public.create_or_get_backup_v2_generation(text,text,timestamptz,text[],text,text)
  to service_role;
grant execute on function public.create_or_get_backup_v2_recovery_set(uuid,bigint) to service_role;
grant execute on function public.record_backup_v2_measurement(uuid,text,timestamptz,jsonb) to service_role;
grant execute on function public.prepare_backup_v2_preflight(uuid,integer) to service_role;
grant execute on function public.claim_backup_v2_run_lease(uuid,text,integer) to service_role;
grant execute on function public.heartbeat_backup_v2_run_lease(uuid,text,bigint,integer) to service_role;
grant execute on function public.attest_backup_v2_recovery_key_availability(uuid,text,bigint,uuid,text,text,text)
  to service_role;
grant execute on function public.transition_backup_v2_run_fenced(uuid,text,text,text,text,bigint,text,text,integer,text,jsonb)
  to service_role;
grant execute on function public.record_backup_v2_artifact(uuid,text,bigint,uuid,text,text,text,text,numeric,text,text,text,text,text)
  to service_role;
grant execute on function public.verify_backup_v2_artifact(uuid,text,bigint,uuid,numeric,text) to service_role;
grant execute on function public.record_backup_v2_artifact_copy(uuid,text,bigint,uuid,text,text,text,text,text,numeric,text)
  to service_role;
grant execute on function public.verify_backup_v2_artifact_copy(uuid,text,bigint,uuid,numeric,text) to service_role;
grant execute on function public.record_backup_v2_component_evidence(uuid,text,bigint,uuid,text,text,text,text)
  to service_role;
grant execute on function public.finalize_backup_v2_recovery_set(uuid,uuid,text,bigint) to service_role;

comment on table public.backup_v2_catalog_snapshots is
  'Authoritative catalog, measurement, finding, and preflight evidence bound to one Phase 4B generation.';
comment on table public.backup_v2_artifacts is
  'Provider-neutral canonical artifact evidence metadata only; never artifact bytes or private keys.';
comment on table public.backup_v2_artifact_copies is
  'Provider-neutral canonical copy evidence with physical identity and independence domains; no credentials.';
comment on function public.create_or_get_backup_v2_generation(text,text,timestamptz,text[],text,text) is
  'Canonical one-run/multi-component Phase 4B generation creation and concurrent idempotency boundary.';
comment on function public.create_or_get_backup_v2_recovery_set(uuid,bigint) is
  'Creates or returns the one immutable provider-neutral recovery set bound to a Phase 4B generation.';
comment on function public.attest_backup_v2_recovery_key_availability(uuid,text,bigint,uuid,text,text,text) is
  'Records fenced public recovery-key availability metadata only; never creates or stores private key material.';
comment on function public.prepare_backup_v2_preflight(uuid,integer) is
  'Discovers and classifies the live catalog, binds measured evidence, persists findings, and fails closed.';
