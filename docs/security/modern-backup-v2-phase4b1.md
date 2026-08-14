# Modern Backup V2 — Phase 4B.1 execution foundation

## Boundary and migration status

Phase 4B.1 is a provider-neutral control-plane foundation. It does not export PostgreSQL, Auth, Storage, or external assets; create, compress, encrypt, upload, restore, schedule, or delete backup data; select a provider; store a private recovery key; or create paid infrastructure. New monthly cost remains `$0`.

`20260814080000_backup_v2_phase4b1_execution_foundation.sql` is untracked/uncommitted on the isolated Phase 4B.1 worktree, is absent from `origin/main`, and is documented as unreleased. Repository evidence shows only disposable/local use. No production or shared remote connection was used during this correction.

## One generation, one run, multiple components

A Phase 4B.1 row in `backup_v2_runs` represents one logical generation containing a canonical set of one or more components from `database`, `auth`, `storage_metadata`, `storage_objects`, and `external_assets`. `storage_metadata` is the bucket/object metadata needed to reconstruct Storage; `storage_objects` is the separate byte payload. Neither can substitute for the other. The legacy `scope` column remains for Phase 4A compatibility and equals the first byte-sorted Phase 4B component.

`create_or_get_backup_v2_generation` is the only backend creation boundary. It removes duplicate scopes, validates allowed identities, sorts deterministically, and hashes a length-stable UTF-8 semantic request. Execution UUIDs, retry attempts, and observation timestamps are not semantic. A different generation boundary or other meaningful request field produces a different identity. Partial unique indexes plus `INSERT ... ON CONFLICT` make concurrent identical requests return one logical generation.

New Phase 4B rows require `contract_version`, semantic request key, generation key, canonical scope set, source environment, and generation boundary. Historical Phase 4A rows remain valid without those columns. Direct `service_role` creation of Phase 4B rows is rejected by the run guard.

## Canonical catalog, measurements, and preflight

`prepare_backup_v2_preflight` accepts only a run identifier and measurement-age policy. It does not accept caller-provided relations or classifications. In one locked operation it discovers the live `public` catalog, maps relation kinds, applies policy `car-zone-phase4b1-catalog-v2`, derives a byte-stable SHA-256 fingerprint, selects current measured/runtime evidence, creates findings, applies `blocked > review_required > go`, persists the complete snapshot, binds it to the generation, and enters the preflight lifecycle state.

The policy explicitly includes every public base table produced by the current migration sequence, including business, customer/Auth-linkage, order, fiscal, inventory, wholesale, credit, accounting, CRM, configuration, Backup V1, and Backup V2 domains. Ordinary views are reconstructable; three demonstrated transaction/ephemeral tables are excluded with durable reasons; Backup V2 control tables are metadata-only. A future table or unsupported relation kind is `review_required`, never silently accepted.

The fingerprint is SHA-256 over canonical schema, relation, kind, classification, and reason fields. Fields are length-prefixed by UTF-8 byte count and identities are ordered by UTF-8 bytes. TypeScript rejects duplicate identities, invalid classifications, and missing/insufficient exclusion reasons and uses the identical representation.

Measurements retain distinct `measured`, `observed`, `estimated`, and `unknown` qualities. Phase 4B safety gates accept only current `runtime_verified + measured` rows with the component-specific exact quantity. Missing, stale, estimated, observed, or unknown evidence blocks preflight; zero is accepted only when it is explicitly measured.

## Claim gate and fencing

`claim_backup_v2_run_lease` locks the run and requires a Phase 4B identity, nonterminal eligible state, bound snapshot with outcome `go`, matching generation, unexpired measurement evidence, and a fingerprint equal to a fresh live-catalog fingerprint. Missing, blocked, review-required, expired, or catalog-stale preflight is denied.

Every post-claim mutation requires `run_id + lease_owner_ref + lease_generation` and an unexpired lease:

- heartbeat;
- lifecycle transition;
- artifact record/verification;
- copy record/verification;
- component/recovery evidence;
- readiness finalization and failure/completion transitions.

The legacy transition RPC explicitly rejects Phase 4B rows. `transition_backup_v2_run_fenced` is the Phase 4B boundary. After A generation 1 expires and B obtains generation 2, A cannot heartbeat, transition, record artifact/copy/component evidence, finalize, fail, or complete the run even with `service_role`.

A current fenced owner may record the safe terminal states `failed` or `cancelled` after an already accepted preflight later expires or its catalog fingerprint becomes stale. This closes the run without creating success evidence. Fresh authoritative preflight remains mandatory for execution progress, validation, successful completion, artifact evidence, and readiness; wrong owners, stale fencing generations, and expired leases remain denied for every terminal transition.

## Canonical artifact, copy, and readiness evidence

Artifact recording creates an unverified row tied to the run, logical generation, recovery set, component, exact byte count, SHA-256 digest, compatibility metadata, creation owner, and fencing generation. Verification is a separate RPC: it compares independently observed hash and byte count with the recorded values and stamps `runtime_verified` using database time and the current lease. Passing `verified=true` is not an operation.

Copies are recorded and verified separately. Each has a globally unique physical-object identity in addition to a provider-neutral reference and independence domain. A verified copy must match the canonical artifact's SHA-256 and exact byte count. Primary and secondary rows must belong to the same artifact while having different physical identities, references, and independence domains.

`create_or_get_backup_v2_recovery_set` is the idempotent service-backend creation boundary. One recovery set has one immutable `generation_key` and one generation run. Composite foreign keys bind catalog snapshots, recovery-set components, and artifacts to that same run/generation. Copy generation is inherited exclusively through its artifact. Evidence from any other generation is rejected before persistence and cannot contribute to readiness.

For a Phase 4B recovery set, `full_dr_ready` is derived from all five required Car Zone components having current fenced component evidence, one verified canonical artifact, one verified primary copy, one verified independent secondary copy, cryptographic/byte equivalence, independence, compatibility, integrity, and required recovery-key availability metadata. `attest_backup_v2_recovery_key_availability` records only fenced public availability metadata with database time; it creates and stores no key or secret. Zero canonical artifacts, legacy fields alone, primary-only evidence, aliases of one object, mismatched hashes/bytes, unverified copies, cross-generation evidence, or a missing database/Auth/storage-metadata/storage-object/external-assets component cannot certify readiness. Phase 4A's legacy readiness branch and historical columns remain intact.

## SQL security

All Backup V2 tables have RLS and no end-user policy. `PUBLIC`, `anon`, and `authenticated` have no table privileges or canonical mutation RPC execution. `service_role` can read canonical evidence and execute narrow `SECURITY DEFINER` operations with `search_path = pg_catalog, pg_temp`; it cannot directly insert/update/delete artifacts or copies, and its credential never bypasses run identity, generation binding, preflight, lease owner, lease generation, expiry, equivalence, or readiness checks. The immutable, SQL-only scope normalizer has no mutation or dynamic SQL and is executable only by `service_role` because PostgreSQL evaluates it inside Phase 4A-compatible table constraints. No private key, secret, credential, password, or provider token column exists.

Provider selection remains `NONE`, scheduler remains inactive, real Backup V2 executions/restores remain zero, and Phase 4B.2 is not started.
