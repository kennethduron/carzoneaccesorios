import "server-only";

import { createAwsSdkBackblazeB2Transport } from "../v2/b2-s3-transport.ts";
import {
  createBackblazeB2ArtifactStorageProvider,
  simplifiedBackupV2RealStorageAuthorization,
} from "../v2/backblaze-b2-storage-provider.ts";
import { provisionDisposablePostgresTarget } from "../v2/disposable-postgres-target.ts";
import { createPostgresToolRunner } from "../v2/postgres-tool-runner.ts";
import { createProductionBackupSources } from "../v2/production-sources.ts";
import { BackupV2FailClosedError } from "../v2/types.ts";
import { loadSimplifiedRealConfig } from "./config.ts";
import { runSimplifiedBackup } from "./orchestrator.ts";
import { createFileBasedPsqlRestoreExecutor } from "./plain-sql.ts";
import type { SimplifiedRunResult } from "./types.ts";

function numericEvidence(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BackupV2FailClosedError("BACKUP_V2_SIMPLIFIED_DATABASE_VERIFY_FAILED", `${field} verification is invalid`);
  }
  return value;
}

export async function runFirstRealSimplifiedSqlBackup(
  environment: NodeJS.ProcessEnv,
): Promise<SimplifiedRunResult> {
  const config = loadSimplifiedRealConfig(environment);
  try {
    const transport = createAwsSdkBackblazeB2Transport(config.b2);
    const storageProvider = createBackblazeB2ArtifactStorageProvider({
      config: config.b2,
      transport,
      expectedConfigFingerprint: config.b2.configFingerprint,
      realExecutionAuthorization: simplifiedBackupV2RealStorageAuthorization(),
    });
    const postgresRunner = createPostgresToolRunner({ mode: "CONTAINER" });
    const sources = await createProductionBackupSources({
      databaseUrl: config.databaseUrl,
      supabaseUrl: config.supabaseUrl,
      supabaseServiceRoleKey: config.supabaseServiceRoleKey,
      cloudinaryCloudName: config.cloudinaryCloudName,
      cloudinaryApiKey: config.cloudinaryApiKey,
      cloudinaryApiSecret: config.cloudinaryApiSecret,
      postgresRunner,
    });
    try {
      return await runSimplifiedBackup({
        stateParent: config.stateParent,
        sources,
        recoveryKey: config.recoveryKey,
        storageProvider,
        sourceDatabaseUrl: config.databaseUrl,
        remoteSoftBudgetBytes: config.b2.softBudgetBytes,
        async restore() {
        const provision = await provisionDisposablePostgresTarget({ password: config.restorePostgresPassword });
        const executor = createFileBasedPsqlRestoreExecutor({
          target: provision.target,
          verifyTarget: provision.verify,
        });
        return Object.freeze({
          target: provision.target,
          executor,
          async verifyDatabase() {
            await provision.verify();
            const output = (await provision.runner.capture({
              tool: "psql",
              operation: "RESTORE_DB_CONTENT_VERIFY",
              args: ["--no-psqlrc", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", "--command=SELECT json_build_object('schemas',(SELECT count(*) FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema','carzone_backup_v2_local')),'tables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema','carzone_backup_v2_local')),'indexes',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='i' AND n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema','carzone_backup_v2_local')),'constraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema','carzone_backup_v2_local')),'query_ok',1)::text"],
              connection: { ...provision.target, host: "127.0.0.1", port: 5432 },
              containerName: provision.target.containerName,
            })).trim();
            let evidence: Record<string, unknown>;
            try { evidence = JSON.parse(output) as Record<string, unknown>; }
            catch { throw new BackupV2FailClosedError("BACKUP_V2_SIMPLIFIED_DATABASE_VERIFY_FAILED", "Restored database verification was not JSON"); }
            const schemas = numericEvidence(evidence.schemas, "schema");
            const tables = numericEvidence(evidence.tables, "table");
            const indexes = numericEvidence(evidence.indexes, "index");
            const constraints = numericEvidence(evidence.constraints, "constraint");
            if (schemas < 1 || tables < 1 || indexes < 1 || constraints < 1 || evidence.query_ok !== 1) {
              throw new BackupV2FailClosedError("BACKUP_V2_SIMPLIFIED_DATABASE_VERIFY_FAILED", "Restored database structure is incomplete");
            }
            return Object.freeze({ schemas, tables, indexes, constraints, querySucceeded: true });
          },
          cleanup: provision.cleanup,
        });
        },
      });
    } catch (error) {
      await sources.cleanup().catch(() => undefined);
      throw error;
    }
  } finally {
    config.destroy();
  }
}
