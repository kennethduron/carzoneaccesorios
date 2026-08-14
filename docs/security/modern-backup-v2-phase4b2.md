# Modern Backup V2 Phase 4B.2

Phase 4B.2 adds the server-only, provider-neutral database artifact pipeline. It does not schedule a backup, connect to production by itself, upload an artifact, create a recovery key, or implement restore orchestration.

## Supported contract

The database exporter is PostgreSQL `pg_dump` custom format with ownership and ACL restoration disabled. The database-wide archive otherwise preserves the PostgreSQL schema and data selected by the authoritative Phase 4B.1 catalog/preflight contract, including types, tables, keys, indexes, views, functions, RLS enablement, and policies. Unknown or review-required catalog entries must be stopped by Phase 4B.1 preflight before this pipeline is called. Tool compatibility is recorded as the exact `pg_dump (PostgreSQL) <version>` string; future restore work must enforce a compatible `pg_restore` version rather than assuming universal version compatibility.

The streaming path is:

```text
pg_dump stdout -> SHA-256/byte meter -> gzip (RFC 1952)
-> SHA-256/byte meter -> AES-256-GCM -> versioned envelope
-> final SHA-256/byte meter -> partial file
```

The envelope contains an eight-byte format magic, a fresh 96-bit nonce, ciphertext, and a 128-bit GCM authentication tag. The key is supplied by the caller as 32 ephemeral/runtime bytes, is copied only for the operation, and the copy is zeroed before return. Only a public SHA-256 key fingerprint, key version, and safe key reference enter the manifest. Phase 4B.2 creates no production recovery key.

## Identity and authority

The canonical database artifact ID is deterministically derived from the Phase 4B.1 generation key. Therefore one logical generation can have only one canonical database final directory. Run ID, generation key, artifact ID, database component, catalog fingerprint/policy, preflight snapshot, algorithms, versions, creation time, and key metadata are authenticated as AES-GCM AAD.

The pipeline reads Phase 4B.1 authority before starting and immediately before publication. Both checks require:

- preflight outcome `go`;
- run state `running` or `validating`;
- the expected current lease owner and lease generation;
- an unexpired lease;
- identical run, generation, catalog, and preflight binding at finalization.

A lost/reclaimed lease, cancellation, terminal run, changed preflight, or cross-generation identity prevents publication even if local export bytes finished successfully. The result is validated `runtime_verified` artifact evidence suitable for the existing `record_backup_v2_artifact` and `verify_backup_v2_artifact` control-plane operations; the pipeline does not call remote RPCs in this phase.

## Manifest and verification

The UTF-8 canonical JSON manifest has version `car-zone-backup-v2-manifest-v1`. Object keys are recursively sorted and only finite safe integer JSON numbers are accepted. The manifest records exact decimal byte counts and SHA-256 digests for the PostgreSQL export, gzip stream, and final encrypted envelope. Its `integrity.manifest_sha256` covers the canonical manifest with the integrity object omitted, avoiding self-reference.

Verification fails closed on unknown versions/algorithms/fields, identity mismatch, manifest mutation, wrong key, wrong nonce/tag, altered/truncated/appended artifact bytes, gzip corruption, inner byte/hash mismatch, a non-`PGDMP` export, excessive decompressed bytes, or excessive compression ratio. Verification streams the artifact and never reads a potentially large dump wholly into memory.

## Filesystem safety

Callers provide one controlled workspace root, which is resolved before use. Generation and artifact names are canonical and never accepted as paths. Partial directories are unique direct children of the workspace, receive restrictive permissions where supported, and are explicitly removed after failure. Artifact and manifest are verified together inside that partial directory. A single directory rename publishes the pair atomically; an existing canonical directory is verified and reused or rejected, never overwritten. This design prevents a partial file from being represented as a final artifact.

Filesystem deletion is limited to the known `.partial-<artifact>-<uuid>` directory or disposable test roots. Physical secure erase is not claimed because general filesystems and SSDs do not guarantee it.

## Phase boundary

Database-only evidence cannot satisfy the Phase 4B.1 full-DR policy: Auth, Storage Metadata, Storage Objects, External Assets, independent provider copies, and recovery-key evidence remain absent. Phase 4B.2 does not implement Auth/Storage/Cloudinary export, provider upload, scheduler, production execution, or product restore.

The disposable integration test uses runtime-generated credentials and key material, a local `postgres:17-alpine` container, synthetic schema/data only, real `pg_dump`, the real compression/encryption/verification pipeline, and a test-only streaming `pg_restore` round-trip into a second disposable database. It verifies representative rows, foreign keys, indexes, a view, function, and RLS policy, then removes the named container and temporary workspace.
