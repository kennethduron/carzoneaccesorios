# Modern Backup V2 — Phase 4B.5

## Selected primary provider

Phase 4B.5 selects Backblaze B2 Cloud Storage as the single production primary destination through its S3-compatible API. The approved non-secret destination is region `us-east-005`, private bucket `carzone-backup-v2-kencode`, endpoint `https://s3.us-east-005.backblazeb2.com`, destination ID `carzone-b2-primary-us-east-005`, and failure domain `backblaze-b2-current-account-us-east-005`.

The adapter uses AWS SDK for JavaScript v3 with explicit credentials, standard SigV4, one SDK attempt per call, path-style bucket addressing, and checksum behavior limited to required protocol checks. Path style is deterministic for the approved B2 service endpoint and does not affect the provider-neutral canonical object key. Client creation is lazy and requires an explicit trusted-operator action; imports, builds, lint, tests, application startup, and public routes do not create a client or contact B2.

The bucket is operator-evidenced as private with default SSE-B2 enabled. Backup V2 AES-256-GCM remains the authoritative client-side encryption layer; no request sends a customer encryption key. Object Lock is disabled, so the bucket is not claimed to be ransomware-immutable. Lifecycle currently keeps all versions. Phase 4B.5 does not inspect or mutate privacy, encryption, lifecycle, Object Lock, ACLs, or bucket configuration.

## Credential and permission boundary

Use only a bucket-restricted Backblaze Application Key with read/write access to the approved bucket. Never use or request the Backblaze Master Application Key. Real credentials must not be entered in chat, source, documentation, test fixtures, `.env.local`, Vercel, GitHub, or the Windows environment during Phase 4B.5 Master Execution.

Future operator-only configuration names are:

- `BACKUP_V2_B2_ENDPOINT`
- `BACKUP_V2_B2_REGION`
- `BACKUP_V2_B2_BUCKET`
- `BACKUP_V2_B2_KEY_ID`
- `BACKUP_V2_B2_APPLICATION_KEY`
- `BACKUP_V2_B2_KEY_SCOPE` (`bucket-restricted` only)
- `BACKUP_V2_B2_DESTINATION_ID`
- `BACKUP_V2_B2_FAILURE_DOMAIN_ID`
- `BACKUP_V2_B2_SOFT_BUDGET_BYTES`
- `BACKUP_V2_REAL_EXECUTION_ENABLED`

Configuration validates the exact HTTPS endpoint, hostname, region, bucket, destination and failure-domain IDs, a positive decimal byte budget, credential presence, and the bucket-restricted scope attestation. Arbitrary S3 endpoints, embedded credentials, URL queries, generic AWS credential names, master/root scope, and unsafe identities fail closed. The non-secret configuration fingerprint excludes both credential values and changes whenever the destination identity changes.

Normal operation uses only object-scoped `HeadObject`, conditional `PutObject`, `GetObject`, and bounded multipart operations. Read-only capacity preflight uses paginated `ListObjectsV2` against `backup-v2/`. It never requires `ListBuckets` or `HeadBucket`, and it never creates a bucket, changes ACL/encryption/lifecycle/Object Lock, tags an object, generates a presigned URL, or deletes a completed object. `AbortMultipartUpload` is used only to clean up an unfinished multipart transaction.

## Storage and verification behavior

The Phase 4B.4 provider-neutral contract, canonical object key, encrypted bytes, manifests, copy evidence, and lease authority remain authoritative. The B2 adapter does not decrypt, recompress, re-encrypt, or reformat artifacts. It allows only the `primary` copy role for the approved production destination.

Small artifacts stream through conditional `PutObject` with exact `ContentLength` and `application/octet-stream`. Larger artifacts use explicitly bounded multipart batches (default three parts, 8 MiB per part), conditional completion, cancellation, and best-effort abort on failure. No production path reads or concatenates an entire backup in memory. A pre-existing canonical key is never overwritten: it is accepted only after Phase 4B.4 stat plus full streamed SHA-256 readback proves exact bytes. ETag and provider version identifiers are opaque supplemental metadata, never canonical SHA-256 evidence.

Transient rate limiting, selected network failures, timeouts, and selected 5xx responses receive finite exponential retries. A reasonable `Retry-After` is honored with a ten-second ceiling. Authentication, signature, bucket, configuration, collision, integrity, stale-lease, cancellation, and budget failures are terminal. Raw provider errors are classified into fixed secret-safe messages.

## Capacity and zero-cost guard

Pricing and provider free-tier claims are not hardcoded. A future real upload requires an explicit positive `BACKUP_V2_B2_SOFT_BUDGET_BYTES`; `8000000000` bytes is only an initial operator recommendation, not a permanent provider fact. The `bigint` capacity planner requires exact encrypted bytes for all five components plus current managed-prefix bytes. It reports projected bytes, remaining budget, and similarly sized generations that fit. Equality with the ceiling is allowed; any overage, missing budget, unknown component size, or unknown current usage denies upload.

Read-only managed-prefix accounting paginates with hard limits, rejects unsafe/repeated tokens and duplicate keys, and reports unknown objects through non-secret SHA-256 references without deleting them. Unknown objects inside `backup-v2/` count conservatively toward the budget. `ListObjectsV2` shows current visible objects and may understate billed historic versions while lifecycle keeps all versions; the Backblaze account dashboard remains the external cost source of truth. Automatic retention deletion is not implemented.

## Manual workflow and phase boundary

The initial recommended executor is `LOCAL_TRUSTED_OPERATOR`: a controlled, isolated Node process can provide `pg_dump`, temporary filesystem capacity, long-lived streams, Supabase Auth/Storage reads, and Cloudinary pagination without exposing a public request handler or Vercel function limits. No scheduler is created.

`npm run backup:v2:manual -- --plan` is the safe default and makes zero production connections. It reports configuration presence without values, all five component identities, unknown size/capacity gates, and missing readiness evidence. `--synthetic-execute` uses ephemeral encryption and an in-memory fake B2 transport. `--provider-preflight` is hard-blocked until an explicitly authorized controlled release. `--execute-production` is source-level hard-blocked with `REAL_BACKUP_V2_EXECUTION_BLOCKED_UNTIL_PHASE_4B6` before database, Auth, Storage, Cloudinary, filesystem artifact, or B2 initialization. The environment flag cannot bypass that source gate.

Backblaze B2 is one failure domain. Five valid B2 primary copies plus synthetic recovery-key evidence do not produce `full_dr_ready`; a second object, prefix, version, or key in the same B2 destination is not independent. Existing Phase 4B.4 synthetic providers continue to prove that a genuinely separate secondary can satisfy the canonical policy. Production still has no independent secondary, real recovery key, proven restore, scheduler, real Backup V2 execution, or remote Backup V2 copy.

## Synthetic evidence

`npm run test:backup-v2:phase4b5` uses no real network or credentials. It covers exact endpoint/config validation, master-key denial, secret-safe authentication errors, all five components, streaming Put/Get/Head, conditional reuse and collision denial, bounded multipart completion/abort/cancellation, 503 and retry limits, timeout, false success, corruption/truncation/appended bytes, lease loss, configuration drift, capacity thresholds, managed-prefix pagination, unmanaged objects, primary-only failure-domain behavior, B2-only readiness denial, and true independent-secondary regression.
