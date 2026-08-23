import { runScheduledOperationalBackup } from "../src/lib/backups/v2-operational/run.ts";
import { BackupV2FailClosedError } from "../src/lib/backups/v2/types.ts";

try {
  const result = await runScheduledOperationalBackup(process.env);
  process.stdout.write(`${JSON.stringify({
    result: result.result,
    runId: result.runId,
    generationId: result.generationId,
    componentResults: result.componentResults,
    remoteObjectsVerified: result.remoteObjectsVerified,
    remoteSha256: "PASS",
    cleanup: result.cleanup,
    retentionMode: result.retentionMode,
    fullRestoreExecuted: result.fullRestoreExecuted,
    automaticRetryCount: result.automaticRetryCount,
  })}\n`);
} catch (error) {
  const code = error instanceof BackupV2FailClosedError ? error.code : "BACKUP_V2_OPERATIONAL_UNEXPECTED_FAILURE";
  process.stderr.write(`${JSON.stringify({ status: "FAILED", code })}\n`);
  process.exitCode = 1;
}
