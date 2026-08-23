import "server-only";

import os from "node:os";
import path from "node:path";

import {
  BACKUP_V2_B2_ENV_NAMES,
  readBackblazeB2RuntimeConfig,
  type BackblazeB2RuntimeConfig,
} from "../v2/b2-config.ts";
import {
  loadPhase4B6SessionSecrets,
  PHASE4B6_NON_SECRET_ENV_NAMES,
  phase4B6OperatorAuthorization,
} from "../v2/phase4b6-secret-contract.ts";
import { BackupV2FailClosedError } from "../v2/types.ts";

export interface SimplifiedRealConfig {
  readonly stateParent: string;
  readonly supabaseUrl: string;
  readonly cloudinaryCloudName: string;
  readonly cloudinaryApiKey: string;
  readonly b2: BackblazeB2RuntimeConfig;
  readonly databaseUrl: string;
  readonly supabaseServiceRoleKey: string;
  readonly cloudinaryApiSecret: string;
  readonly restorePostgresPassword: string;
  readonly recoveryKey: Buffer;
  destroy(): void;
  toJSON(): { readonly status: "validated_redacted"; readonly recoveryKeyValid: true };
}
function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

export function parseSimplifiedRecoveryKey(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    fail("BACKUP_V2_SIMPLIFIED_INVALID_RECOVERY_KEY", "Recovery key must be canonical base64 for exactly 32 bytes");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    decoded.fill(0);
    fail("BACKUP_V2_SIMPLIFIED_INVALID_RECOVERY_KEY", "Recovery key must decode to exactly 32 bytes");
  }
  return decoded;
}

function httpsOrigin(value: unknown, field: string): string {
  let url: URL;
  try { url = new URL(typeof value === "string" ? value : ""); }
  catch { fail("BACKUP_V2_SIMPLIFIED_CONFIG_INVALID", `${field} is invalid`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    fail("BACKUP_V2_SIMPLIFIED_CONFIG_INVALID", `${field} must be an HTTPS origin`);
  }
  return url.toString();
}

function safeName(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(value)) {
    fail("BACKUP_V2_SIMPLIFIED_CONFIG_INVALID", `${field} is invalid`);
  }
  return value;
}

export function loadSimplifiedRealConfig(environment: NodeJS.ProcessEnv): SimplifiedRealConfig {
  if (environment[BACKUP_V2_B2_ENV_NAMES.realExecutionEnabled] !== "true") {
    fail("BACKUP_V2_SIMPLIFIED_REAL_EXECUTION_DISABLED", "Real execution flag is not enabled");
  }
  const secrets = loadPhase4B6SessionSecrets(environment, phase4B6OperatorAuthorization());
  const recoveryKey = secrets.recoveryKey;
  try {
    const values = {
      databaseUrl: secrets.databaseUrl,
      supabaseServiceRoleKey: secrets.supabaseServiceRoleKey,
      cloudinaryApiSecret: secrets.cloudinaryApiSecret,
      restorePostgresPassword: secrets.restorePostgresPassword,
    };
    if (!/^postgres(?:ql)?:\/\//.test(values.databaseUrl)) {
      fail("BACKUP_V2_SIMPLIFIED_CONFIG_INVALID", "SUPABASE_DB_URL must be a PostgreSQL URL");
    }
    const supabaseUrl = httpsOrigin(environment[PHASE4B6_NON_SECRET_ENV_NAMES.supabaseUrl], "NEXT_PUBLIC_SUPABASE_URL");
    const cloudinaryCloudName = safeName(environment[PHASE4B6_NON_SECRET_ENV_NAMES.cloudinaryCloudName], "CLOUDINARY_CLOUD_NAME");
    const cloudinaryApiKey = safeName(environment[PHASE4B6_NON_SECRET_ENV_NAMES.cloudinaryApiKey], "CLOUDINARY_API_KEY");
    const b2 = readBackblazeB2RuntimeConfig(environment);
    const stateParent = environment.BACKUP_V2_SIMPLIFIED_STATE_ROOT?.trim() ||
      path.join(os.tmpdir(), "carzone-backup-v2-simplified-state");
    if (stateParent.includes("\0")) fail("BACKUP_V2_SIMPLIFIED_CONFIG_INVALID", "State path is invalid");
    let destroyed = false;
    const result = {
      stateParent, supabaseUrl, cloudinaryCloudName, cloudinaryApiKey, b2,
      destroy() {
        if (!destroyed) {
          secrets.destroy();
          destroyed = true;
        }
      },
      toJSON() { return { status: "validated_redacted" as const, recoveryKeyValid: true as const }; },
    } as SimplifiedRealConfig;
    Object.defineProperties(result, {
      databaseUrl: { value: values.databaseUrl, enumerable: false },
      supabaseServiceRoleKey: { value: values.supabaseServiceRoleKey, enumerable: false },
      cloudinaryApiSecret: { value: values.cloudinaryApiSecret, enumerable: false },
      restorePostgresPassword: { value: values.restorePostgresPassword, enumerable: false },
      recoveryKey: { value: recoveryKey, enumerable: false },
    });
    return Object.freeze(result);
  } catch (error) {
    secrets.destroy();
    throw error;
  }
}
