# Modern Backup V2 operational scheduling

Backup V2 runs from a pinned, dedicated Windows checkout outside OneDrive. It is not a Vercel cron, public API route, browser task, or Supabase Edge Function.

## Qualified execution contract

- Command: `npm.cmd run backup:v2:simplified:scheduled`
- Executor: Windows Task Scheduler task `CarZone-BackupV2-Daily`
- Schedule: daily at 03:00 `Central America Standard Time` (UTC-06:00, no DST)
- Missed starts: run as soon as practical
- Concurrent task policy: do not start another instance
- PostgreSQL representation: `postgres_plain_sql_v1`
- Recovery strategy retained in every manifest: `psql_file_restore_v1`
- Daily full restore: disabled; controlled recovery drills remain separate

Backup V1 remains active on its existing Monday 08:00 UTC schedule (02:00 Tegucigalpa). Backup V2 is separated by one hour and Backup V1 must not be disabled automatically.

## Protected runtime

`scripts/backup-v2-provision-dpapi.ps1` provisions only the required environment from the trusted operator process. Secrets are serialized as Windows DPAPI-protected `SecureString` values, bound to the current Windows user, under `%LOCALAPPDATA%\CarZone\BackupV2\config\secrets.clixml`. The directory and files receive protected current-user-only ACLs. Non-secret configuration is stored separately.

The scheduled-task action contains no credentials. `scripts/backup-v2-scheduled.ps1` loads the protected store in memory, verifies the checkout commit against the provisioned qualified SHA, and invokes the operational npm command. It does not fetch, pull, or otherwise update code.

Safe JSONL logs and an atomically replaced machine-readable status file live beneath `%LOCALAPPDATA%\CarZone\BackupV2`. Logs contain run/generation identifiers, component results, counts, byte totals, integrity results, cleanup, retention status, and safe error codes only.

## Budget and retention

The hard operational soft ceiling is 8,000,000,000 bytes. The runner inventories the whole configured B2 bucket before export and reserves an additional 64 MiB beyond measured source bytes. A blocked budget stops before export/upload.

Retention is generation-level: 7 daily, 4 weekly, and 3 monthly selections reuse the same verified generations. The first recovery-proven generation is pinned, and the latest two valid generations are always retained. Initial mode is `DRY_RUN`; destructive retention is not authorized until at least three successful scheduled generations and separate future approval.

## Failure handling and transition

The local status tracks consecutive failures. One failure is a warning, two are elevated, and three are critical. Because no reusable remote mail provider is present in the trusted operator runtime, failures also use the Windows Application event log. Backup correctness does not depend on alert delivery.

Observe Backup V2 in parallel with Backup V1 for at least three successful scheduled generations and seven calendar days, whichever is later. Disabling Backup V1 always requires explicit future approval.

A monthly controlled recovery drill is recommended using a retained verified generation and the pinned official `supabase/postgres:17.6.1.121` target. No recurring recovery-drill schedule is enabled by this implementation. `FULL_DR_READY` remains `NO` until an independently operated secondary failure domain is implemented and proven.
