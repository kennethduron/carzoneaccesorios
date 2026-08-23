import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { BACKUP_V2_B2_ENV_NAMES } from "./b2-config.ts";
import { BackupV2FailClosedError } from "./types.ts";

export const PHASE4B6_SECRET_ENV_NAMES = Object.freeze({
  databaseUrl: "SUPABASE_DB_URL",
  supabaseServiceRoleKey: "SUPABASE_SERVICE_ROLE_KEY",
  cloudinaryApiSecret: "CLOUDINARY_API_SECRET",
  b2KeyId: BACKUP_V2_B2_ENV_NAMES.keyId,
  b2ApplicationKey: BACKUP_V2_B2_ENV_NAMES.applicationKey,
  recoveryKeyBase64: "BACKUP_V2_RECOVERY_KEY_BASE64",
  restorePostgresPassword: "BACKUP_V2_RESTORE_PG_PASSWORD",
} as const);

export const PHASE4B6_NON_SECRET_ENV_NAMES = Object.freeze({
  supabaseUrl: "NEXT_PUBLIC_SUPABASE_URL",
  cloudinaryCloudName: "CLOUDINARY_CLOUD_NAME",
  cloudinaryApiKey: "CLOUDINARY_API_KEY",
  b2Endpoint: BACKUP_V2_B2_ENV_NAMES.endpoint,
  b2Region: BACKUP_V2_B2_ENV_NAMES.region,
  b2Bucket: BACKUP_V2_B2_ENV_NAMES.bucket,
  b2KeyScope: BACKUP_V2_B2_ENV_NAMES.keyScope,
  b2DestinationId: BACKUP_V2_B2_ENV_NAMES.destinationId,
  b2FailureDomainId: BACKUP_V2_B2_ENV_NAMES.failureDomainId,
  b2SoftBudgetBytes: BACKUP_V2_B2_ENV_NAMES.softBudgetBytes,
  realExecutionEnabled: BACKUP_V2_B2_ENV_NAMES.realExecutionEnabled,
  durableRecoveryKeyCopyConfirmed: "BACKUP_V2_RECOVERY_KEY_DURABLE_COPY_CONFIRMED",
  restorePostgresHost: "BACKUP_V2_RESTORE_PG_HOST",
  restorePostgresPort: "BACKUP_V2_RESTORE_PG_PORT",
  restorePostgresDatabase: "BACKUP_V2_RESTORE_PG_DATABASE",
  restorePostgresUser: "BACKUP_V2_RESTORE_PG_USER",
} as const);

export const PHASE4B6_REQUIRED_SECRET_VARIABLE_NAMES = Object.freeze(
  Object.values(PHASE4B6_SECRET_ENV_NAMES),
);
export const PHASE4B6_REQUIRED_NON_SECRET_VARIABLE_NAMES = Object.freeze(
  Object.values(PHASE4B6_NON_SECRET_ENV_NAMES),
);

const SAFE_SECRET = /^[^\u0000-\u001f\u007f\s]{8,8192}$/;
const OPERATOR_GATE = "PHASE_4B6_OPERATOR_GATE_SATISFIED";
const DURABLE_COPY_CONFIRMATION = "CONFIRMED_INDEPENDENT_DURABLE_COPY";

export interface Phase4B6OperatorAuthorization {
  readonly checkpointStage: "OPERATOR_GATE";
  readonly authorization: typeof OPERATOR_GATE;
}

export interface Phase4B6SessionSecrets {
  readonly databaseUrl: string;
  readonly supabaseServiceRoleKey: string;
  readonly cloudinaryApiSecret: string;
  readonly b2KeyId: string;
  readonly b2ApplicationKey: string;
  readonly restorePostgresPassword: string;
  readonly recoveryKey: Buffer;
  readonly recoveryKeyFingerprint: string;
  destroy(): void;
  toJSON(): { status: "loaded_redacted"; recoveryKeyFingerprint: string };
}

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

function secret(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || !SAFE_SECRET.test(value)) {
    fail("BACKUP_V2_PHASE4B6_SECRET_MISSING", `${name} is missing or malformed`);
  }
  return value;
}

function exact(environment: NodeJS.ProcessEnv, name: string, expected: string): void {
  const value = environment[name];
  if (typeof value !== "string" || value.length !== expected.length ||
      !timingSafeEqual(Buffer.from(value), Buffer.from(expected))) {
    fail("BACKUP_V2_PHASE4B6_OPERATOR_ATTESTATION_MISSING", `${name} is not confirmed`);
  }
}

function recoveryKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    fail("BACKUP_V2_INVALID_RECOVERY_KEY", "Recovery key must be canonical base64 for exactly 32 bytes");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    decoded.fill(0);
    fail("BACKUP_V2_INVALID_RECOVERY_KEY", "Recovery key must decode to exactly 32 bytes");
  }
  return decoded;
}

export function loadPhase4B6SessionSecrets(
  environment: NodeJS.ProcessEnv,
  authorization: Phase4B6OperatorAuthorization,
): Phase4B6SessionSecrets {
  if (authorization?.checkpointStage !== "OPERATOR_GATE" || authorization.authorization !== OPERATOR_GATE) {
    fail("BACKUP_V2_PHASE4B6_OPERATOR_GATE_REQUIRED", "Stage B secrets cannot be loaded before the operator gate");
  }
  exact(environment, PHASE4B6_NON_SECRET_ENV_NAMES.realExecutionEnabled, "true");
  exact(
    environment,
    PHASE4B6_NON_SECRET_ENV_NAMES.durableRecoveryKeyCopyConfirmed,
    DURABLE_COPY_CONFIRMATION,
  );
  const key = recoveryKey(secret(environment, PHASE4B6_SECRET_ENV_NAMES.recoveryKeyBase64));
  const values = {
    databaseUrl: secret(environment, PHASE4B6_SECRET_ENV_NAMES.databaseUrl),
    supabaseServiceRoleKey: secret(environment, PHASE4B6_SECRET_ENV_NAMES.supabaseServiceRoleKey),
    cloudinaryApiSecret: secret(environment, PHASE4B6_SECRET_ENV_NAMES.cloudinaryApiSecret),
    b2KeyId: secret(environment, PHASE4B6_SECRET_ENV_NAMES.b2KeyId),
    b2ApplicationKey: secret(environment, PHASE4B6_SECRET_ENV_NAMES.b2ApplicationKey),
    restorePostgresPassword: secret(environment, PHASE4B6_SECRET_ENV_NAMES.restorePostgresPassword),
  };
  if (!/^postgres(?:ql)?:\/\//.test(values.databaseUrl)) {
    key.fill(0);
    fail("BACKUP_V2_PHASE4B6_DATABASE_URL_INVALID", "SUPABASE_DB_URL must be a PostgreSQL connection URL");
  }
  let destroyed = false;
  const recoveryKeyFingerprint = createHash("sha256").update(key).digest("hex");
  const result = {
    recoveryKeyFingerprint,
    destroy() {
      if (!destroyed) {
        key.fill(0);
        destroyed = true;
      }
    },
    toJSON() { return { status: "loaded_redacted" as const, recoveryKeyFingerprint }; },
  } as Phase4B6SessionSecrets;
  Object.defineProperties(result, {
    databaseUrl: { value: values.databaseUrl, enumerable: false },
    supabaseServiceRoleKey: { value: values.supabaseServiceRoleKey, enumerable: false },
    cloudinaryApiSecret: { value: values.cloudinaryApiSecret, enumerable: false },
    b2KeyId: { value: values.b2KeyId, enumerable: false },
    b2ApplicationKey: { value: values.b2ApplicationKey, enumerable: false },
    restorePostgresPassword: { value: values.restorePostgresPassword, enumerable: false },
    recoveryKey: { value: key, enumerable: false },
  });
  return Object.freeze(result);
}

export function phase4B6OperatorAuthorization(): Phase4B6OperatorAuthorization {
  return Object.freeze({ checkpointStage: "OPERATOR_GATE", authorization: OPERATOR_GATE });
}

export const PHASE4B6_RECOVERY_KEY_REQUIREMENTS = Object.freeze([
  "Generate exactly 32 cryptographically random bytes outside the repository.",
  "Encode the bytes as canonical base64 in BACKUP_V2_RECOVERY_KEY_BASE64 for the session only.",
  "Store an independent durable operator copy before any real artifact is generated.",
  `Set ${PHASE4B6_NON_SECRET_ENV_NAMES.durableRecoveryKeyCopyConfirmed}=${DURABLE_COPY_CONFIRMATION} only after verifying that copy.`,
  "Never reuse B2, Supabase, Cloudinary, JWT, or database credentials as recovery material.",
]);
