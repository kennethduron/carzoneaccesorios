# Modern Backup V2 — Phase 4A foundation

## Authorization and boundary

Phase 4A provides runtime-neutral domain contracts, typed recovery evidence, fail-closed ZERO-SPEND measurement rules, an additive database control plane, and a manual CI preflight. It does not export, encrypt, upload, schedule, download, delete, or restore a backup. It makes no production connection and selects no storage provider.

Decision 11 allows only the manual preflight to run on a standard GitHub-hosted runner within included quota. Vercel is not a backup worker and GitHub Actions artifacts are not canonical backup storage. B2, R2, Google Drive, paid storage, paid workers, paid KMS, and PITR remain unconfigured.

The unreleased foundation migration is `20260813151140_backup_v2_control_plane_foundation.sql`. Its timestamp intentionally follows the deployed Purchase Accounting migration `20260813093000`; normal chronological migration application is required. No migration-history repair or exceptional include-all deployment is part of this design.

## Typed recovery evidence

A recovery-set policy explicitly classifies every supported component (`database`, `auth`, and `storage_objects`) and copy kind (`primary` and provider-neutral `independent_offsite`) as required or optional. Unknown scopes, requirements, copy kinds, duplicate declarations, and undeclared evidence fail closed. Database is a mandatory policy component.

Each required component must provide all of the following before it can contribute to `full_dr_ready`:

- artifact presence and completed scope evidence tied to a canonically completed run;
- verified integrity with no fail-closed reasons;
- verified backup-format, schema/migration compatibility, exporter-version, and verification-time evidence;
- a verified primary copy with a provider-neutral reference and verification time;
- every independent/offsite copy that its policy marks required;
- runtime-verified evidence rather than synthetic fixture evidence.

Recovery evidence origin uses the closed Phase 4A vocabulary `runtime_verified` and `synthetic_fixture`. Runtime validation uses this same allowlist as the TypeScript type and positively authorizes the capability of each known origin. Unknown, malformed, case-varied, whitespace-modified, or wrong-type origins fail closed. `runtime_verified` may establish real readiness; `synthetic_fixture` is structurally valid only in the synthetic test environment and can never establish real `full_dr_ready`. Trust is never inferred from “anything except synthetic.” The database persists the same closed vocabulary and requires `runtime_verified` for database-level readiness.

Evidence timestamps cannot be invalid or future-dated. When a recovery policy defines a maximum evidence age, stale component, copy, compatibility, or key-attestation evidence blocks readiness.

Database completion is not whole-system disaster-recovery readiness. A completed database run remains only a completed component until every component required by the policy and every required copy has valid evidence.

The default Phase 4A policy requires offline recovery-key availability attestation. Only safe metadata may be recorded: a key version, custody/reference identifier, public fingerprint, verification status, and attestation time. The private recovery key is never stored in PostgreSQL, Supabase, GitHub, Vercel, the repository, or workflow configuration. Phase 4A does not implement AES-256-GCM encryption; it only defines evidence needed by a future authorized implementation.

## Canonical lifecycle evidence

TypeScript and PostgreSQL use the same run states and transitions:

- `requested` → `preflight`, `failed`, or `cancelled`;
- `preflight` → `running`, `failed`, or `cancelled`;
- `running` → `validating`, `failed`, or `cancelled`;
- `validating` → `completed`, `completed_with_warnings`, `failed`, or `cancelled`;
- terminal states cannot transition.

`transition_backup_v2_run` is the canonical backend transition boundary. It locks the run, verifies its immutable scope and actual current state, validates the transition, updates the authoritative run, and appends the next immutable event in the same transaction. Wrong scope, wrong `from_state`, illegal or out-of-order transition, duplicate sequence, contradictory event/run state, and post-terminal transition all fail closed. The backend role cannot directly update run state or insert events.

V1 backup tables, statuses, and behavior remain unchanged. V2 is additive and does not backfill or reinterpret V1 evidence.

## Measurement and ZERO-SPEND gate

Phase 4A accepts only synthetic/local measurements. Byte and quota quantities are exact non-negative integers; quota must be greater than zero. A JavaScript `number` is accepted only when it is a safe integer. Larger exact quantities may use a `bigint` or a canonical base-10 integer string containing only `0` or non-zero-leading decimal digits. Unsafe numbers are rejected before conversion and are never converted to `bigint` after precision may have been lost. Fractional, signed, whitespace-padded, hexadecimal, and scientific-notation quantities fail closed. Maximum measurement age must be a finite positive safe integer. Invalid, unknown, stale, or strictly future-dated evidence blocks the operation.

The exact capacity contract is:

- `normal`: current usage below 70%;
- `warning`: current usage at least 70% and below 80%;
- `critical_capacity`: current usage at least 80% and below 90%;
- `blocked_budget`: current usage at least 90%, projected post-operation usage at least 90%, unavailable quota/provider data, or invalid/future/stale evidence.

The policy classification uses exact `bigint` addition and cross-multiplication for the 70%, 80%, and 90% boundaries; floating-point division is not authoritative. Any returned numeric ratio is approximate diagnostic/display data only and is never fed back into the safety decision. Consequently both current and projected usage at or above exactly 90% are blocked even for quantities larger than `Number.MAX_SAFE_INTEGER`.

A blocked result requires an owner decision. Capacity pressure never authorizes automatic deletion. Protected evidence includes the latest verified database copy, latest `full_dr_ready` set, latest restore-verified generation, required previous generation, legal or incident holds, incremental dependencies, and artifacts needing historical key versions.

Catalog discovery remains dynamic. No global migration or relation count is a contract; an unknown relation or scope must be classified before the measurement gate can pass.

## Database security

All five V2 control-plane tables have RLS enabled and no end-user policies. Privileges are explicitly revoked from `PUBLIC`, `anon`, `authenticated`, and `service_role` before narrowly required backend grants are applied. `service_role` has no `TRUNCATE`, `REFERENCES`, or `TRIGGER` privilege, cannot insert/update/delete events, and cannot update run state directly. Generic roles have no mutation privilege.

The canonical transition function is `SECURITY DEFINER`, uses a fixed `pg_catalog, pg_temp` search path and qualified objects, contains no dynamic SQL, is not executable by `PUBLIC`, `anon`, or `authenticated`, and is executable only by the backend role. Trigger helpers are not exposed as application mutation APIs.

## Workflow and future boundary

The manual preflight workflow has no schedule, environment secrets, provider configuration, database connection, backup/restore command, upload/download step, or destructive operation. It uses minimal read-only repository permission, pinned action revisions, disabled checkout credential persistence, bounded runtime, and one-at-a-time concurrency.

Phase 4B remains outside this work. It requires separate review and authorization for real catalog measurement, export/encryption, offline key custody, provider selection, retention/RPO, Auth and storage-object recovery, restore drills, production scheduling, and any paid capability. Phase 4A does not claim production backup or restore readiness.
