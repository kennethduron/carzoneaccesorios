# Modern Backup V2 Plain SQL recovery contract

The primary PostgreSQL representation is `postgres_plain_sql_v1`. Its
recovery strategy is `psql_file_restore_v1`. The older custom-archive path is
legacy-only and is not a fallback for new Plain SQL generations.

## Future controlled export

The operator entry point is:

```powershell
npm.cmd run backup:v2:simplified:first-real-sql
```

That command is deliberately gated and must only be used by the separate
Controlled First Real procedure. It runs PostgreSQL 17 `pg_dump` with the
connection supplied through process-scoped `PG*` environment variables. The
exact database-export argv is:

```text
pg_dump --format=plain --no-owner --no-privileges --encoding=UTF8 --quote-all-identifiers
```

When a verified exported snapshot is in use, this final argument is appended:

```text
--snapshot=<verified-snapshot-id>
```

`pg_dump` stdout is streamed directly into a newly created, permission-limited
`database.sql` file. No production SQL is issued by the export path beyond the
normal read-only behavior of `pg_dump`; business tables and Backup V2 control
state are not mutated. Ownership and ACL statements are intentionally excluded
by `--no-owner --no-privileges`.

The local artifact pipeline is deterministic in this order:

```text
database.sql -> gzip level 9 -> AES-256-GCM envelope -> .czb2 artifact
```

The authenticated sidecar records the Plain SQL representation, filename,
restore strategy, PostgreSQL major, plaintext/compressed/encrypted byte counts,
and SHA-256 values. Plaintext staging is removed after encryption and again by
fail-closed cleanup.

## Isolated recovery

Recovery verifies the remote encrypted bytes and SHA-256, authenticates and
decrypts the AES-GCM envelope, decompresses it to a real `database.sql`, and
verifies the plaintext bytes and SHA-256. It then uses `docker cp` to place the
file in a positively identified disposable PostgreSQL 17 container. Container
size and SHA-256 are checked before execution.

The restore argv inside the isolated container is:

```text
psql -X --set ON_ERROR_STOP=on -f /tmp/<isolated-run>/database.sql
```

The SQL payload is never sent through Node or Docker stdin. A nonzero `psql`
result is terminal; there is no automatic `pg_restore` fallback. Semantic and
structural validation must pass before recoverability is reported.

The same generation also requires verified Auth, Storage Metadata, Storage
Objects, and External Assets components. This preserves the existing five-part
Backup V2 boundary. It does not claim independent-secondary or full disaster
recovery readiness.

## Remote storage and compatibility

The Backblaze B2 S3-compatible client retains
`requestChecksumCalculation = WHEN_REQUIRED` and
`responseChecksumValidation = WHEN_REQUIRED`. It does not send
`If-None-Match: *`; immutability conflicts are detected through application
identity plus exact size/SHA-256 readback verification.

Backup V1 remains active and unchanged. No Supabase migration or production
deployment is part of this implementation.
