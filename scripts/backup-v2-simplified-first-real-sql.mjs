import { runFirstRealSimplifiedSqlBackup } from "../src/lib/backups/v2-simplified/production.ts";
import { BackupV2FailClosedError } from "../src/lib/backups/v2/types.ts";

const REQUIRED_CONFIRMATION = "FIRST_REAL_SQL_BACKUP_AND_ISOLATED_RESTORE";

function refuse(code, message) {
  throw new BackupV2FailClosedError(code, message);
}

if (process.env.BACKUP_V2_SIMPLIFIED_SQL_CONFIRMATION !== REQUIRED_CONFIRMATION) {
  refuse(
    "BACKUP_V2_SIMPLIFIED_SQL_CONFIRMATION_REQUIRED",
    "The controlled first-real SQL confirmation is absent",
  );
}

if (process.env.BACKUP_V2_REAL_EXECUTION_ENABLED !== "true") {
  refuse(
    "BACKUP_V2_SIMPLIFIED_REAL_EXECUTION_DISABLED",
    "Real Backup V2 execution remains disabled",
  );
}

if (process.env.BACKUP_V2_PRIMARY_REPRESENTATION !== "postgres_plain_sql_v1" ||
    process.env.BACKUP_V2_PRIMARY_RESTORE_STRATEGY !== "psql_file_restore_v1") {
  refuse(
    "BACKUP_V2_SIMPLIFIED_SQL_STRATEGY_REQUIRED",
    "The first-real command requires the approved Plain SQL and file-based psql strategy",
  );
}

try {
  const result = await runFirstRealSimplifiedSqlBackup(process.env);
  process.stdout.write(`${JSON.stringify({
    backupV2Simplified: result.report.backupV2Simplified,
    cleanup: result.report.cleanup,
    fullDrReady: false,
    recoverabilityProven: result.report.recoverabilityProven,
    runId: result.report.runId,
    status: result.report.status,
  })}\n`);
} catch (error) {
  const code = error instanceof BackupV2FailClosedError ? error.code : "BACKUP_V2_SIMPLIFIED_UNEXPECTED_FAILURE";
  process.stderr.write(`${JSON.stringify({ code, status: "FAILED" })}\n`);
  process.exitCode = 1;
}
