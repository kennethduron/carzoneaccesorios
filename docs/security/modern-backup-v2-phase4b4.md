# Modern Backup V2 — Phase 4B.4

## Scope

Phase 4B.4 adds the server-only transport boundary between a locally verified Backup V2 encrypted artifact and a stored recovery copy. It does not select or configure a production provider, connect to a provider, create a production backup, create a recovery key, schedule work, or implement restore. The only adapter in this phase is a disposable filesystem adapter used with isolated local roots.

The Phase 4B.1 copy roles and recovery-set policy remain authoritative. Phase 4B.2 and 4B.3 remain authoritative for compression, AES-256-GCM encryption, manifests, artifact identity, and runtime verification. Storage never decrypts, recompresses, re-encrypts, wraps, or rewrites an artifact or manifest.

## Contract and object identity

The small `backup-v2-storage-v1` contract has three required operations: streaming conditional write, stat, and streaming read. Normal backup creation has no delete operation. A provider must explicitly implement streaming read/write, stat, conditional create, and read-after-write; an unknown or unregistered adapter and an adapter missing any required capability fail closed.

The deterministic logical key is:

```text
backup-v2/<generation-sha256>/<component>/<canonical-artifact-id>.czb2
```

Only the five canonical components and their existing artifact-ID formats are accepted. Separators are provider-style `/` on every platform. Absolute paths, drive letters, UNC paths, backslashes, traversal, control characters, and oversized or noncanonical identities are rejected.

The canonical provider locator contains the contract version, explicitly allowlisted adapter type, stable logical provider instance, logical namespace, and a base64url encoding of the canonical object key. It never contains credentials, headers, URLs, signed URLs, account secrets, or recovery-key material. Provider version IDs, ETags, and checksums are opaque metadata; an ETag is never interpreted as SHA-256.

## Source authority and manifest binding

`prepareBackupV2ArtifactForStorage` accepts only a canonical artifact directory directly beneath its controlled workspace. The directory, encrypted `.czb2`, and manifest must be regular, nonsymlink files at the exact paths determined by the runtime-verified artifact ID. The manifest is parsed using the existing Phase 4B.2 or 4B.3 parser. Generation, run, component, artifact, creation time, encrypted size/hash, compatibility reference, catalog, and preflight binding must match the existing `runtime_verified` artifact evidence.

The encrypted file is streamed and SHA-256 checked during preparation and checked again while each upload reads it. A prepared source is an in-process capability registered by the server-only module; an arbitrary structurally similar object cannot enter canonical storage publication.

The copy pipeline reads the canonical execution authority and lease before upload. It binds the source run, generation, owner, lease generation, catalog, and preflight snapshot to that authority. After upload, stat, and full readback, it reads the authority and lease again. Cancellation, failed/cancelled run state, preflight drift, generation drift, or lease loss prevents copy evidence even if raw bytes reached the disposable destination.

## Immutability, idempotency, and verification

The disposable filesystem adapter streams into a unique staging file with backpressure, flushes it, and uses an atomic hard-link create to publish the canonical path only if absent. A partial staging file is never a canonical copy. An existing key is not overwritten. The pipeline may reuse it only after exact stat and full streamed SHA-256 readback match the artifact. Different bytes, truncation, appended bytes, a false success, a false stat, a wrong object, or a missing object fail closed and produce no verified evidence.

Canonical copy evidence is constructed only by the runtime pipeline after verification. Its deterministic copy ID binds generation, artifact, component, role, destination identity, object key, and manifest identity. Repeated and concurrent identical requests therefore converge on one logical evidence identity. The existing copy validator and recovery-set policy enforce byte equivalence and the roles `primary`, `secondary_independent`, and `optional_offline`.

## Independence

The adapter reports a stable failure-domain identity; it does not declare policy success. A `secondary_independent` copy requires known failure-domain evidence. The Phase 4B.1 policy rejects equal provider references, physical identities, or failure domains. Tests use Provider A and Provider B as separate disposable roots with distinct instance, namespace, physical, and failure-domain evidence. A different key or provider instance in the same failure domain does not satisfy the independent-copy requirement.

## Streaming, retries, timeouts, and errors

Uploads and downloads use Node streams and backpressure; artifacts are never loaded into one `Buffer`. Stat and readback use exact `bigint` byte counts. Batch storage uses a bounded worker pool (default callers choose the limit; accepted range is 1–8), not unbounded fan-out.

Provider operations have finite attempts, bounded backoff, per-operation timeout, and cancellation propagation. Only errors explicitly classified as transient are retried. Integrity, identity, configuration, path, stale-authority, and cancellation failures are terminal. A retry reopens and revalidates the source and relies on immutable conditional creation, so a lost acknowledgement cannot create a second or overwrite an existing object. Errors crossing the adapter boundary are converted to generic typed messages; raw provider messages can never disclose tokens, URLs, credentials, headers, or account data.

## Filesystem security boundary

The disposable adapter resolves a dedicated root once, checks every key segment, creates and rechecks each parent, rejects symlinked directories and objects, and opens reads with `O_NOFOLLOW` where the platform exposes it. Staging is a direct controlled directory and publication is conditional. Tests cover traversal, Windows drive/UNC syntax, Unicode separator variants, symlink escape, arbitrary read/write denial, and collision preservation. A complete active symlink race cannot be proven identically on every filesystem; the design minimizes the race with per-segment checks, no-follow opens, and atomic conditional publication. No guarantee beyond those OS primitives is claimed.

## Future phases

Phase 4B.5 may add one explicitly allowlisted real adapter and inject its runtime-only configuration after provider and cost selection. It must preserve this contract, immutable semantics, canonical locator, error sanitization, and strong verification; it must not add an arbitrary HTTP destination.

Phase 4B.6 restore may resolve the stable locator through the configured adapter and consume `openRead` as a stream. It must independently verify ciphertext bytes/hash before decrypting and must treat copy integrity separately from recovery-key validity. Provider-to-provider portability is proven locally by streaming the unchanged ciphertext from Provider A to Provider B and re-verifying the same canonical SHA-256 without decrypting or re-encrypting.

## Test evidence

`npm run test:backup-v2:phase4b4` creates all five same-generation artifacts with the real Phase 4B.2/4B.3 local pipelines and exercises two independent disposable destinations, same-domain rejection, full synthetic `full_dr_ready`, missing/corrupt/cross-generation secondary behavior, partial and false-success writes, corrupt/truncated/appended/wrong reads, stat lies, missing objects, same-byte reuse, different-byte collision, concurrency, bounded retries, throttling, timeout, cancellation, stale lease at upload/readback finalization, provider portability, a multi-megabyte stream, path and symlink denial, unknown providers, signed URLs, and secret-bearing provider errors. All fixtures and credentials are synthetic and all roots are explicit temporary directories.
