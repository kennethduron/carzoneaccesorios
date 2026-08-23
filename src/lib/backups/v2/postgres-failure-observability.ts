import "server-only";

import { BackupV2FailClosedError } from "./types.ts";

export const POSTGRES_OPERATION_NAMES = Object.freeze([
  "POSTGRES_TOOL_CAPABILITY_PG_DUMP",
  "POSTGRES_TOOL_CAPABILITY_PG_RESTORE",
  "POSTGRES_TOOL_CAPABILITY_PSQL",
  "PRODUCTION_DB_SERVER_VERSION_PROBE",
  "PRODUCTION_DB_SOURCE_MEASUREMENT",
  "PRODUCTION_DB_SNAPSHOT_BEGIN",
  "PRODUCTION_DB_SNAPSHOT_EXPORT",
  "PRODUCTION_DB_SNAPSHOT_VALIDATION",
  "PRODUCTION_DB_SNAPSHOT_RELEASE",
  "PRODUCTION_DB_READ_QUERY",
  "DATABASE_EXPORT_PG_DUMP",
  "RESTORE_DB_IDENTITY_PROBE",
  "RESTORE_DB_PSQL_VERIFY",
  "RESTORE_DB_SCHEMA_INITIALIZE",
  "RESTORE_DB_MARKER_WRITE",
  "RESTORE_DB_DOCKER_DIRECTORY",
  "RESTORE_DB_DOCKER_COPY",
  "RESTORE_DB_DOCKER_SIZE_VERIFY",
  "RESTORE_DB_DOCKER_SHA256_VERIFY",
  "RESTORE_DB_PSQL_FILE",
  "RESTORE_DB_FILE_CLEANUP",
  "RESTORE_DB_ARCHIVE_VALIDATE",
  "RESTORE_DB_PG_RESTORE",
  "RESTORE_DB_CONTENT_VERIFY",
  "SYNTHETIC_AUTHENTICATION_PROBE",
  "SYNTHETIC_CONNECTION_REFUSED",
  "SYNTHETIC_PG_DUMP_FAILURE",
] as const);

export type PostgresOperationName = (typeof POSTGRES_OPERATION_NAMES)[number];
export type PostgresDiagnosticTool = "pg_dump" | "pg_restore" | "psql" | "docker";
export type PostgresSignalClass = "NONE" | "TERMINATED" | "TIMEOUT" | "CANCELLED";
export type PostgresStderrClass =
  | "AUTHENTICATION_FAILED"
  | "DNS_RESOLUTION_FAILED"
  | "CONNECTION_REFUSED"
  | "CONNECTION_TIMEOUT"
  | "NETWORK_UNREACHABLE"
  | "SSL_ERROR"
  | "SERVER_VERSION_INCOMPATIBLE"
  | "DATABASE_NOT_FOUND"
  | "ROLE_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "PG_DUMP_ERROR"
  | "PG_RESTORE_ERROR"
  | "PSQL_ERROR"
  | "DOCKER_ERROR"
  | "UNKNOWN_SANITIZED";
export type PostgresRetryability =
  | "NON_RETRYABLE_CONFIGURATION"
  | "TRANSIENT_POSSIBLE"
  | "ENVIRONMENT_OR_NETWORK"
  | "HUMAN_REVIEW_REQUIRED";
export type PostgresSystemCode =
  | "EOF"
  | "EPIPE"
  | "ECONNRESET"
  | "ECONNABORTED"
  | "ERR_STREAM_DESTROYED"
  | "ENOENT"
  | "EACCES"
  | "EINVAL"
  | "UNKNOWN"
  | null;

export interface SanitizedPostgresFailureEvidence {
  readonly failureOperation: PostgresOperationName;
  readonly failureTool: PostgresDiagnosticTool;
  readonly exitCode: number | null;
  readonly signalClass: PostgresSignalClass;
  readonly stderrClass: PostgresStderrClass;
  readonly retryability: PostgresRetryability;
  readonly systemCode: PostgresSystemCode;
  readonly stdinClosed: boolean;
  readonly childExitedBeforeWrite: boolean;
}

type PostgresFailureEvidenceInput = Omit<SanitizedPostgresFailureEvidence,
  "systemCode" | "stdinClosed" | "childExitedBeforeWrite"> & Partial<Pick<SanitizedPostgresFailureEvidence,
  "systemCode" | "stdinClosed" | "childExitedBeforeWrite">>;

const operations = new Set<string>(POSTGRES_OPERATION_NAMES);
const tools = new Set<string>(["pg_dump", "pg_restore", "psql", "docker"]);
const signalClasses = new Set<string>(["NONE", "TERMINATED", "TIMEOUT", "CANCELLED"]);
const stderrClasses = new Set<string>([
  "AUTHENTICATION_FAILED", "DNS_RESOLUTION_FAILED", "CONNECTION_REFUSED", "CONNECTION_TIMEOUT",
  "NETWORK_UNREACHABLE", "SSL_ERROR", "SERVER_VERSION_INCOMPATIBLE", "DATABASE_NOT_FOUND",
  "ROLE_NOT_FOUND", "PERMISSION_DENIED", "PG_DUMP_ERROR", "PG_RESTORE_ERROR", "PSQL_ERROR",
  "DOCKER_ERROR", "UNKNOWN_SANITIZED",
]);
const retryabilityClasses = new Set<string>([
  "NON_RETRYABLE_CONFIGURATION", "TRANSIENT_POSSIBLE", "ENVIRONMENT_OR_NETWORK", "HUMAN_REVIEW_REQUIRED",
]);
const systemCodes = new Set<string>([
  "EOF", "EPIPE", "ECONNRESET", "ECONNABORTED", "ERR_STREAM_DESTROYED", "ENOENT", "EACCES", "EINVAL", "UNKNOWN",
]);

export function safePostgresSystemCode(error: unknown): PostgresSystemCode {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && systemCodes.has(code) ? code as Exclude<PostgresSystemCode, null> : "UNKNOWN";
}

export function classifyPostgresStderr(raw: string, tool: PostgresDiagnosticTool): PostgresStderrClass {
  const value = typeof raw === "string" ? raw.slice(0, 65_536).toLowerCase() : "";
  if (/password authentication failed|authentication failed|sqlstate\s*28p01/.test(value)) return "AUTHENTICATION_FAILED";
  if (/could not translate host name|getaddrinfo|name or service not known|nodename nor servname|enotfound/.test(value)) return "DNS_RESOLUTION_FAILED";
  if (/connection refused|econnrefused|actively refused/.test(value)) return "CONNECTION_REFUSED";
  if (/connection timed out|timeout expired|etimedout|operation timed out/.test(value)) return "CONNECTION_TIMEOUT";
  if (/network is unreachable|enetunreach|no route to host/.test(value)) return "NETWORK_UNREACHABLE";
  if (/ssl error|certificate verify failed|certificate validation|tls handshake|no pg_hba\.conf entry.*ssl/.test(value)) return "SSL_ERROR";
  if (/server version.*not supported|server version.*newer|version mismatch/.test(value)) return "SERVER_VERSION_INCOMPATIBLE";
  if (/database [^\r\n]{0,256} does not exist|sqlstate\s*3d000/.test(value)) return "DATABASE_NOT_FOUND";
  if (/role [^\r\n]{0,256} does not exist|sqlstate\s*28000/.test(value)) return "ROLE_NOT_FOUND";
  if (/permission denied|must be owner|insufficient privilege|sqlstate\s*42501/.test(value)) return "PERMISSION_DENIED";
  if (/cannot connect to the docker daemon|error response from daemon|docker:|no such image|pull access denied/.test(value)) return "DOCKER_ERROR";
  if (/no such container|container .* is not running|copying between containers is not supported/.test(value)) return "DOCKER_ERROR";
  if (tool === "pg_dump") return "PG_DUMP_ERROR";
  if (tool === "pg_restore") return "PG_RESTORE_ERROR";
  if (tool === "psql" && value.trim().length > 0) return "PSQL_ERROR";
  if (tool === "docker") return "DOCKER_ERROR";
  return "UNKNOWN_SANITIZED";
}

export function retryabilityForPostgresClass(stderrClass: PostgresStderrClass): PostgresRetryability {
  if (["AUTHENTICATION_FAILED", "DATABASE_NOT_FOUND", "ROLE_NOT_FOUND", "PERMISSION_DENIED", "SERVER_VERSION_INCOMPATIBLE"].includes(stderrClass)) {
    return "NON_RETRYABLE_CONFIGURATION";
  }
  if (["CONNECTION_TIMEOUT", "CONNECTION_REFUSED"].includes(stderrClass)) return "TRANSIENT_POSSIBLE";
  if (["DNS_RESOLUTION_FAILED", "NETWORK_UNREACHABLE", "SSL_ERROR", "DOCKER_ERROR"].includes(stderrClass)) return "ENVIRONMENT_OR_NETWORK";
  return "HUMAN_REVIEW_REQUIRED";
}

export function postgresSignalClass(signal: NodeJS.Signals | null, aborted: boolean, abortReason?: unknown): PostgresSignalClass {
  if (aborted) {
    const name = typeof abortReason === "object" && abortReason !== null && "name" in abortReason
      ? String((abortReason as { name: unknown }).name)
      : "";
    return name === "TimeoutError" ? "TIMEOUT" : "CANCELLED";
  }
  return signal === null ? "NONE" : "TERMINATED";
}

export class PostgresToolExecutionError extends BackupV2FailClosedError {
  readonly operation: PostgresOperationName;
  readonly tool: PostgresDiagnosticTool;
  readonly exitCode: number | null;
  readonly signalClass: PostgresSignalClass;
  readonly stderrClass: PostgresStderrClass;
  readonly retryability: PostgresRetryability;
  readonly systemCode: PostgresSystemCode;
  readonly stdinClosed: boolean;
  readonly childExitedBeforeWrite: boolean;

  constructor(evidence: PostgresFailureEvidenceInput, code = "BACKUP_V2_POSTGRES_TOOL_FAILED") {
    super(code, "PostgreSQL subprocess failed; structured sanitized evidence is available");
    this.name = "PostgresToolExecutionError";
    this.operation = evidence.failureOperation;
    this.tool = evidence.failureTool;
    this.exitCode = evidence.exitCode;
    this.signalClass = evidence.signalClass;
    this.stderrClass = evidence.stderrClass;
    this.retryability = evidence.retryability;
    this.systemCode = evidence.systemCode ?? null;
    this.stdinClosed = evidence.stdinClosed ?? false;
    this.childExitedBeforeWrite = evidence.childExitedBeforeWrite ?? false;
  }

  toJSON() {
    return {
      code: this.code,
      operation: this.operation,
      tool: this.tool,
      exitCode: this.exitCode,
      signalClass: this.signalClass,
      stderrClass: this.stderrClass,
      retryability: this.retryability,
      systemCode: this.systemCode,
      stdinClosed: this.stdinClosed,
      childExitedBeforeWrite: this.childExitedBeforeWrite,
    };
  }
}

export function createPostgresToolExecutionError(input: {
  readonly operation: PostgresOperationName;
  readonly tool: PostgresDiagnosticTool;
  readonly exitCode: number | null;
  readonly signalClass: PostgresSignalClass;
  readonly rawStderr: string;
  readonly systemError?: unknown;
  readonly stdinClosed?: boolean;
  readonly childExitedBeforeWrite?: boolean;
  readonly code?: string;
}): PostgresToolExecutionError {
  const stderrClass = input.signalClass === "TIMEOUT"
    ? "CONNECTION_TIMEOUT"
    : classifyPostgresStderr(input.rawStderr, input.tool);
  return new PostgresToolExecutionError({
    failureOperation: input.operation,
    failureTool: input.tool,
    exitCode: input.exitCode,
    signalClass: input.signalClass,
    stderrClass,
    retryability: retryabilityForPostgresClass(stderrClass),
    systemCode: input.systemError === undefined ? null : safePostgresSystemCode(input.systemError),
    stdinClosed: input.stdinClosed ?? false,
    childExitedBeforeWrite: input.childExitedBeforeWrite ?? false,
  }, input.code);
}

export function sanitizedPostgresFailureEvidence(error: unknown): SanitizedPostgresFailureEvidence | null {
  if (typeof error !== "object" || error === null) return null;
  const value = error as Record<string, unknown>;
  if (!operations.has(String(value.operation)) || !tools.has(String(value.tool)) ||
      !(value.exitCode === null || (typeof value.exitCode === "number" && Number.isInteger(value.exitCode))) ||
      !signalClasses.has(String(value.signalClass)) || !stderrClasses.has(String(value.stderrClass)) ||
      !retryabilityClasses.has(String(value.retryability)) ||
      !(value.systemCode === null || (typeof value.systemCode === "string" && systemCodes.has(value.systemCode))) ||
      typeof value.stdinClosed !== "boolean" || typeof value.childExitedBeforeWrite !== "boolean") return null;
  return Object.freeze({
    failureOperation: value.operation as PostgresOperationName,
    failureTool: value.tool as PostgresDiagnosticTool,
    exitCode: value.exitCode as number | null,
    signalClass: value.signalClass as PostgresSignalClass,
    stderrClass: value.stderrClass as PostgresStderrClass,
    retryability: value.retryability as PostgresRetryability,
    systemCode: value.systemCode as PostgresSystemCode,
    stdinClosed: value.stdinClosed,
    childExitedBeforeWrite: value.childExitedBeforeWrite,
  });
}
