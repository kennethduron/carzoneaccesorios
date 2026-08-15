import "server-only";

import { createHash } from "node:crypto";

import { BackupV2FailClosedError } from "./types.ts";

export const BACKUP_V2_B2_PROVIDER_TYPE = "backblaze_b2" as const;
export const CAR_ZONE_B2_ENDPOINT = "https://s3.us-east-005.backblazeb2.com" as const;
export const CAR_ZONE_B2_REGION = "us-east-005" as const;
export const CAR_ZONE_B2_BUCKET = "carzone-backup-v2-kencode" as const;
export const CAR_ZONE_B2_DESTINATION_ID = "carzone-b2-primary-us-east-005" as const;
export const CAR_ZONE_B2_FAILURE_DOMAIN_ID = "backblaze-b2-current-account-us-east-005" as const;
export const BACKUP_V2_B2_MANAGED_PREFIX = "backup-v2/" as const;
export const BACKUP_V2_B2_ENV_NAMES = Object.freeze({
  endpoint: "BACKUP_V2_B2_ENDPOINT",
  region: "BACKUP_V2_B2_REGION",
  bucket: "BACKUP_V2_B2_BUCKET",
  keyId: "BACKUP_V2_B2_KEY_ID",
  applicationKey: "BACKUP_V2_B2_APPLICATION_KEY",
  keyScope: "BACKUP_V2_B2_KEY_SCOPE",
  destinationId: "BACKUP_V2_B2_DESTINATION_ID",
  failureDomainId: "BACKUP_V2_B2_FAILURE_DOMAIN_ID",
  softBudgetBytes: "BACKUP_V2_B2_SOFT_BUDGET_BYTES",
  realExecutionEnabled: "BACKUP_V2_REAL_EXECUTION_ENABLED",
} as const);

const SAFE_SECRET = /^[^\u0000-\u001f\u007f\s]{8,512}$/;

export interface BackblazeB2RuntimeConfigInput {
  endpoint: unknown;
  region: unknown;
  bucket: unknown;
  accessKeyId: unknown;
  applicationKey: unknown;
  keyScope: unknown;
  destinationId: unknown;
  failureDomainId: unknown;
  softBudgetBytes: unknown;
}

export interface BackblazeB2RuntimeConfig {
  readonly endpoint: typeof CAR_ZONE_B2_ENDPOINT;
  readonly region: typeof CAR_ZONE_B2_REGION;
  readonly bucket: typeof CAR_ZONE_B2_BUCKET;
  readonly accessKeyId: string;
  readonly applicationKey: string;
  readonly keyScope: "bucket-restricted";
  readonly destinationId: typeof CAR_ZONE_B2_DESTINATION_ID;
  readonly failureDomainId: typeof CAR_ZONE_B2_FAILURE_DOMAIN_ID;
  readonly softBudgetBytes: bigint;
  readonly configFingerprint: string;
}

export interface BackblazeB2EnvironmentInspection {
  readonly provider: "backblaze-b2";
  readonly nonSecretConfigurationMatches: boolean;
  readonly credentialsPresent: boolean;
  readonly bucketRestrictedKeyAttested: boolean;
  readonly positiveSoftBudgetPresent: boolean;
  readonly realExecutionFlagEnabled: boolean;
  readonly missingVariables: readonly string[];
}

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

function exact(value: unknown, expected: string, field: string): string {
  if (value !== expected) fail("BACKUP_V2_B2_CONFIGURATION_REJECTED", `${field} does not match the approved B2 destination`);
  return expected;
}

function requireSecret(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_SECRET.test(value)) {
    fail("BACKUP_V2_B2_CREDENTIAL_REJECTED", `${field} is missing or malformed`);
  }
  return value;
}

export function parsePositiveByteBudget(value: unknown, field = "softBudgetBytes"): bigint {
  if (typeof value === "bigint") {
    if (value <= BigInt(0)) fail("BACKUP_V2_B2_BUDGET_INVALID", `${field} must be a positive integer`);
    return value;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    fail("BACKUP_V2_B2_BUDGET_INVALID", `${field} must be a positive decimal integer`);
  }
  return BigInt(value);
}

export function backblazeB2ConfigFingerprint(input: {
  endpoint: string;
  region: string;
  bucket: string;
  destinationId: string;
  failureDomainId: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    provider: "backblaze-b2",
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    destination_id: input.destinationId,
    failure_domain_id: input.failureDomainId,
  })).digest("hex");
}

export function validateBackblazeB2RuntimeConfig(input: BackblazeB2RuntimeConfigInput): BackblazeB2RuntimeConfig {
  let endpoint: URL;
  try { endpoint = new URL(typeof input.endpoint === "string" ? input.endpoint : ""); }
  catch { fail("BACKUP_V2_B2_ENDPOINT_REJECTED", "B2 endpoint is invalid"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port ||
      endpoint.search || endpoint.hash || (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
      endpoint.hostname !== "s3.us-east-005.backblazeb2.com" || endpoint.toString() !== `${CAR_ZONE_B2_ENDPOINT}/`) {
    fail("BACKUP_V2_B2_ENDPOINT_REJECTED", "B2 endpoint is outside the approved HTTPS origin");
  }
  const region = exact(input.region, CAR_ZONE_B2_REGION, "region") as typeof CAR_ZONE_B2_REGION;
  const bucket = exact(input.bucket, CAR_ZONE_B2_BUCKET, "bucket") as typeof CAR_ZONE_B2_BUCKET;
  const destinationId = exact(
    input.destinationId, CAR_ZONE_B2_DESTINATION_ID, "destinationId",
  ) as typeof CAR_ZONE_B2_DESTINATION_ID;
  const failureDomainId = exact(
    input.failureDomainId, CAR_ZONE_B2_FAILURE_DOMAIN_ID, "failureDomainId",
  ) as typeof CAR_ZONE_B2_FAILURE_DOMAIN_ID;
  if (input.keyScope !== "bucket-restricted") {
    fail("BACKUP_V2_B2_MASTER_KEY_DENIED", "Only a bucket-restricted Backblaze Application Key is permitted");
  }
  const accessKeyId = requireSecret(input.accessKeyId, "accessKeyId");
  const applicationKey = requireSecret(input.applicationKey, "applicationKey");
  const softBudgetBytes = parsePositiveByteBudget(input.softBudgetBytes);
  const configFingerprint = backblazeB2ConfigFingerprint({
    endpoint: CAR_ZONE_B2_ENDPOINT, region, bucket, destinationId, failureDomainId,
  });
  return Object.freeze({
    endpoint: CAR_ZONE_B2_ENDPOINT,
    region,
    bucket,
    accessKeyId,
    applicationKey,
    keyScope: "bucket-restricted",
    destinationId,
    failureDomainId,
    softBudgetBytes,
    configFingerprint,
  });
}

export function readBackblazeB2RuntimeConfig(environment: NodeJS.ProcessEnv = process.env): BackblazeB2RuntimeConfig {
  return validateBackblazeB2RuntimeConfig({
    endpoint: environment[BACKUP_V2_B2_ENV_NAMES.endpoint],
    region: environment[BACKUP_V2_B2_ENV_NAMES.region],
    bucket: environment[BACKUP_V2_B2_ENV_NAMES.bucket],
    accessKeyId: environment[BACKUP_V2_B2_ENV_NAMES.keyId],
    applicationKey: environment[BACKUP_V2_B2_ENV_NAMES.applicationKey],
    keyScope: environment[BACKUP_V2_B2_ENV_NAMES.keyScope],
    destinationId: environment[BACKUP_V2_B2_ENV_NAMES.destinationId],
    failureDomainId: environment[BACKUP_V2_B2_ENV_NAMES.failureDomainId],
    softBudgetBytes: environment[BACKUP_V2_B2_ENV_NAMES.softBudgetBytes],
  });
}

export function inspectBackblazeB2Environment(
  environment: NodeJS.ProcessEnv = process.env,
): BackblazeB2EnvironmentInspection {
  const required = Object.entries(BACKUP_V2_B2_ENV_NAMES)
    .filter(([name]) => name !== "realExecutionEnabled")
    .map(([, name]) => name);
  const missingVariables = required.filter((name) => !environment[name]);
  let positiveSoftBudgetPresent = false;
  try {
    parsePositiveByteBudget(environment[BACKUP_V2_B2_ENV_NAMES.softBudgetBytes]);
    positiveSoftBudgetPresent = true;
  } catch { /* Presence inspection is intentionally non-throwing and secret-safe. */ }
  return Object.freeze({
    provider: "backblaze-b2",
    nonSecretConfigurationMatches:
      environment[BACKUP_V2_B2_ENV_NAMES.endpoint] === CAR_ZONE_B2_ENDPOINT &&
      environment[BACKUP_V2_B2_ENV_NAMES.region] === CAR_ZONE_B2_REGION &&
      environment[BACKUP_V2_B2_ENV_NAMES.bucket] === CAR_ZONE_B2_BUCKET &&
      environment[BACKUP_V2_B2_ENV_NAMES.destinationId] === CAR_ZONE_B2_DESTINATION_ID &&
      environment[BACKUP_V2_B2_ENV_NAMES.failureDomainId] === CAR_ZONE_B2_FAILURE_DOMAIN_ID,
    credentialsPresent: Boolean(
      environment[BACKUP_V2_B2_ENV_NAMES.keyId] && environment[BACKUP_V2_B2_ENV_NAMES.applicationKey],
    ),
    bucketRestrictedKeyAttested: environment[BACKUP_V2_B2_ENV_NAMES.keyScope] === "bucket-restricted",
    positiveSoftBudgetPresent,
    realExecutionFlagEnabled: environment[BACKUP_V2_B2_ENV_NAMES.realExecutionEnabled] === "true",
    missingVariables: Object.freeze(missingVariables),
  });
}

export function redactBackblazeB2Text(value: unknown, secrets: readonly string[]): string {
  let output = typeof value === "string" ? value : "Backblaze B2 operation failed";
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join("[REDACTED]");
  }
  output = output
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/(?:authorization|application[_-]?key|secret[_-]?access[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/[^\s]+[?&](?:X-Amz-[^=]+|authorization|token|signature)=[^\s&]+/gi, "[REDACTED_URL]");
  return output;
}
