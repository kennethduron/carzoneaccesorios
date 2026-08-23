import "server-only";

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  createPostgresToolExecutionError,
  PostgresToolExecutionError,
  postgresSignalClass,
  sanitizedPostgresFailureEvidence,
  type PostgresOperationName,
} from "./postgres-failure-observability.ts";
import { BackupV2FailClosedError } from "./types.ts";

export const BACKUP_V2_POSTGRES_IMAGE = "supabase/postgres:17.6.1.121";
export const BACKUP_V2_POSTGRES_TOOL_MAJOR = 17;
const MAX_STDERR = 8_192;
const SAFE_CONTAINER = /^carzone-backup-v2-(?:restore|tool)-[a-z0-9-]{8,80}$/;
// Semantic verification queries are passed as one argv value (never through a
// shell). Keep a hard bound while allowing a complete structural evidence
// query for a restored database.
const SAFE_ARGUMENT = /^[^\u0000-\u001f\u007f]{1,8192}$/;

export type PostgresTool = "pg_dump" | "pg_restore" | "psql";
export type PostgresToolMode = "HOST" | "CONTAINER";

export interface PostgresConnection {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

export interface PostgresToolSession {
  readonly stdout: Readable;
  readonly stdin: Writable;
  readonly completed: Promise<void>;
  readonly cancel: () => void;
  readonly setOperation: (operation: PostgresOperationName) => void;
  readonly writeInput: (chunk: string | Buffer) => Promise<void>;
}

export interface PostgresToolVersions {
  readonly pg_dump: string;
  readonly pg_restore: string;
  readonly psql: string;
  readonly major: number;
}

export interface PostgresToolRunner {
  readonly mode: PostgresToolMode;
  readonly image: string | null;
  inspectCapabilities(): Promise<PostgresToolVersions>;
  open(input: {
    tool: PostgresTool;
    operation: PostgresOperationName;
    args: readonly string[];
    connection?: PostgresConnection;
    containerName?: string;
    signal?: AbortSignal;
  }): PostgresToolSession;
  capture(input: {
    tool: PostgresTool;
    operation: PostgresOperationName;
    args: readonly string[];
    connection?: PostgresConnection;
    containerName?: string;
    stdin?: string | Buffer;
  }): Promise<string>;
  assertServerCompatibility(connection: PostgresConnection, containerName?: string): Promise<number>;
}

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

function safeArg(value: string): string {
  if (!SAFE_ARGUMENT.test(value) || /postgres(?:ql)?:\/\//i.test(value) || /(?:password|secret|token)=/i.test(value)) {
    fail("BACKUP_V2_UNSAFE_POSTGRES_ARGUMENT", "PostgreSQL tool argument was denied");
  }
  return value;
}

function validateConnection(value: PostgresConnection): PostgresConnection {
  for (const [name, field] of Object.entries({ host: value.host, database: value.database, username: value.username })) {
    if (typeof field !== "string" || field.length < 1 || field.length > 512 || /[\u0000-\u001f\u007f]/.test(field)) {
      fail("BACKUP_V2_INVALID_POSTGRES_CONNECTION", `${name} is invalid`);
    }
  }
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535 ||
      typeof value.password !== "string" || value.password.length < 1 || value.password.length > 8_192 ||
      /[\u0000\r\n]/.test(value.password)) {
    fail("BACKUP_V2_INVALID_POSTGRES_CONNECTION", "PostgreSQL connection is invalid");
  }
  return value;
}

function minimalEnvironment(connection?: PostgresConnection): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "LANG", "LC_ALL", "TMP", "TEMP", "DOCKER_HOST", "DOCKER_CONTEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (connection) {
    const checked = validateConnection(connection);
    env.PGHOST = checked.host;
    env.PGPORT = String(checked.port);
    env.PGDATABASE = checked.database;
    env.PGUSER = checked.username;
    env.PGPASSWORD = checked.password;
    env.PGCONNECT_TIMEOUT = "15";
  }
  return env;
}

export function redactPostgresToolError(value: string, connection?: PostgresConnection): string {
  let safe = value;
  for (const secret of connection
    ? [connection.password, connection.host, connection.database, connection.username]
    : []) {
    if (secret) safe = safe.replaceAll(secret, "[redacted]");
  }
  return safe
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-database-url]")
    .replace(/(password|token|secret)\s*[=:]\s*[^\s;]+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, MAX_STDERR);
}

function parseVersion(tool: PostgresTool, operation: PostgresOperationName, stdout: string): { text: string; major: number } {
  const pattern = tool === "psql"
    ? /^psql \(PostgreSQL\) ([A-Za-z0-9._+-]+)$/
    : new RegExp(`^${tool} \\(PostgreSQL\\) ([A-Za-z0-9._+-]+)$`);
  const match = stdout.trim().match(pattern);
  const major = match ? Number.parseInt(match[1], 10) : Number.NaN;
  if (!match || !Number.isSafeInteger(major)) throw new PostgresToolExecutionError({
    failureOperation: operation,
    failureTool: tool,
    exitCode: 0,
    signalClass: "NONE",
    stderrClass: "SERVER_VERSION_INCOMPATIBLE",
    retryability: "NON_RETRYABLE_CONFIGURATION",
  }, "BACKUP_V2_POSTGRES_TOOL_VERSION_UNKNOWN");
  return { text: `${tool} (PostgreSQL) ${match[1]}`, major };
}

export function observePostgresToolChild(
  child: ChildProcessWithoutNullStreams,
  tool: PostgresTool,
  initialOperation: PostgresOperationName,
  signal?: AbortSignal,
): PostgresToolSession {
  let stderr = "";
  let operation = initialOperation;
  let childError: unknown;
  let stdinError: unknown;
  let exitSeen = false;
  let childExitedBeforeStdinError = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(0, MAX_STDERR); });
  child.stdin.on("error", (error) => {
    if (stdinError === undefined) {
      stdinError = error;
      childExitedBeforeStdinError = exitSeen || child.exitCode !== null || child.signalCode !== null;
    }
  });
  const cancel = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => { childError = error; });
    child.once("exit", () => { exitSeen = true; });
    child.once("close", (code, exitSignal) => {
      signal?.removeEventListener("abort", cancel);
      if (code === 0 && exitSignal === null && childError === undefined && stdinError === undefined) return resolve();
      const systemError = stdinError ?? childError;
      reject(createPostgresToolExecutionError({
        operation,
        tool: childError === undefined ? tool : "docker",
        exitCode: code,
        signalClass: postgresSignalClass(exitSignal, signal?.aborted === true, signal?.reason),
        rawStderr: stderr || (childError instanceof Error ? childError.message : ""),
        systemError,
        stdinClosed: stdinError !== undefined || child.stdin.destroyed || child.stdin.writableEnded,
        childExitedBeforeWrite: childExitedBeforeStdinError,
        code: code === 0 && stdinError !== undefined ? "BACKUP_V2_POSTGRES_STDIN_FAILED" : undefined,
      }));
    });
  });
  const writeInput = async (chunk: string | Buffer): Promise<void> => {
    if (exitSeen || child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed || child.stdin.writableEnded) {
      try { await completed; } catch (error) {
        const evidence = sanitizedPostgresFailureEvidence(error);
        if (evidence) throw new PostgresToolExecutionError({
          ...evidence,
          systemCode: evidence.systemCode ?? "ERR_STREAM_DESTROYED",
          stdinClosed: true,
          childExitedBeforeWrite: true,
        }, error instanceof BackupV2FailClosedError ? error.code : "BACKUP_V2_POSTGRES_STDIN_FAILED");
        throw error;
      }
      throw createPostgresToolExecutionError({
        operation, tool, exitCode: child.exitCode,
        signalClass: postgresSignalClass(child.signalCode, signal?.aborted === true, signal?.reason),
        rawStderr: stderr, systemError: { code: "ERR_STREAM_DESTROYED" }, stdinClosed: true,
        childExitedBeforeWrite: exitSeen || child.exitCode !== null || child.signalCode !== null,
        code: "BACKUP_V2_POSTGRES_STDIN_FAILED",
      });
    }
    try {
      await new Promise<void>((resolve, reject) => {
        try { child.stdin.write(chunk, (error) => error ? reject(error) : resolve()); }
        catch (error) { reject(error); }
      });
    } catch (error) {
      cancel();
      try { await completed; } catch (completionError) { throw completionError; }
      throw createPostgresToolExecutionError({
        operation, tool, exitCode: child.exitCode,
        signalClass: postgresSignalClass(child.signalCode, signal?.aborted === true, signal?.reason),
        rawStderr: stderr, systemError: error, stdinClosed: true,
        childExitedBeforeWrite: exitSeen || child.exitCode !== null || child.signalCode !== null,
        code: "BACKUP_V2_POSTGRES_STDIN_FAILED",
      });
    }
  };
  return { stdout: child.stdout, stdin: child.stdin, completed, cancel, writeInput, setOperation(next) { operation = next; } };
}

export async function pipePostgresToolInput(source: Readable, session: PostgresToolSession): Promise<void> {
  const input = pipeline(source, session.stdin).catch((error) => {
    session.cancel();
    throw error;
  });
  const [inputResult, childResult] = await Promise.allSettled([input, session.completed]);
  if (childResult.status === "rejected") throw childResult.reason;
  if (inputResult.status === "rejected") {
    throw new BackupV2FailClosedError("BACKUP_V2_POSTGRES_INPUT_PIPELINE_FAILED", "PostgreSQL input pipeline failed safely");
  }
}

export function createPostgresToolRunner(input: {
  mode: PostgresToolMode;
  image?: typeof BACKUP_V2_POSTGRES_IMAGE;
}): PostgresToolRunner {
  const mode = input.mode;
  const image = mode === "CONTAINER" ? input.image ?? BACKUP_V2_POSTGRES_IMAGE : null;
  if (image !== null && image !== BACKUP_V2_POSTGRES_IMAGE) {
    fail("BACKUP_V2_POSTGRES_IMAGE_DENIED", "Only the approved pinned PostgreSQL image reference may execute tools");
  }

  const open: PostgresToolRunner["open"] = ({ tool, operation, args, connection, containerName, signal }) => {
    if (!new Set<PostgresTool>(["pg_dump", "pg_restore", "psql"]).has(tool)) fail("BACKUP_V2_POSTGRES_TOOL_DENIED", "PostgreSQL tool is not approved");
    const checkedArgs = args.map(safeArg);
    const env = minimalEnvironment(connection);
    let executable: string = tool;
    let childArgs = checkedArgs;
    if (mode === "HOST") {
      if (containerName) fail("BACKUP_V2_POSTGRES_CONTAINER_DENIED", "Host tool mode cannot execute inside a container");
      executable = process.platform === "win32" ? `${tool}.exe` : tool;
      const base = path.basename(executable).toLowerCase();
      if (base !== tool && base !== `${tool}.exe`) fail("BACKUP_V2_POSTGRES_TOOL_DENIED", "Executable was denied");
    } else if (containerName) {
      if (!SAFE_CONTAINER.test(containerName)) fail("BACKUP_V2_POSTGRES_CONTAINER_DENIED", "Container identity was denied");
      childArgs = ["exec", "--interactive", ...Object.keys(connection ? {
        PGHOST: 1, PGPORT: 1, PGDATABASE: 1, PGUSER: 1, PGPASSWORD: 1, PGCONNECT_TIMEOUT: 1,
      } : {}).flatMap((name) => ["--env", name]), containerName, tool, ...checkedArgs];
      executable = "docker";
    } else {
      childArgs = ["run", "--rm", "--interactive", "--network", "bridge",
        ...Object.keys(connection ? {
          PGHOST: 1, PGPORT: 1, PGDATABASE: 1, PGUSER: 1, PGPASSWORD: 1, PGCONNECT_TIMEOUT: 1,
        } : {}).flatMap((name) => ["--env", name]), image!, tool, ...checkedArgs];
      executable = "docker";
    }
    return observePostgresToolChild(spawn(executable, childArgs, {
      env, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    }), tool, operation, signal);
  };

  const capture: PostgresToolRunner["capture"] = async (request) => {
    const session = open(request);
    let stdout = "";
    session.stdout.setEncoding("utf8");
    session.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`;
      if (stdout.length > 1_048_576) session.cancel();
    });
    if (request.stdin !== undefined) {
      await session.writeInput(request.stdin);
    }
    session.stdin.end();
    await session.completed;
    if (stdout.length > 1_048_576) fail("BACKUP_V2_POSTGRES_OUTPUT_LIMIT", "PostgreSQL tool output exceeded limit");
    return stdout;
  };

  return Object.freeze({
    mode,
    image,
    open,
    capture,
    async inspectCapabilities() {
      const operationByTool = {
        pg_dump: "POSTGRES_TOOL_CAPABILITY_PG_DUMP",
        pg_restore: "POSTGRES_TOOL_CAPABILITY_PG_RESTORE",
        psql: "POSTGRES_TOOL_CAPABILITY_PSQL",
      } as const;
      const results = await Promise.all((["pg_dump", "pg_restore", "psql"] as const).map(async (tool) =>
        parseVersion(tool, operationByTool[tool], await capture({ tool, operation: operationByTool[tool], args: ["--version"] }))));
      if (results.some((result) => result.major !== BACKUP_V2_POSTGRES_TOOL_MAJOR)) {
        fail("BACKUP_V2_POSTGRES_TOOL_MAJOR_MISMATCH", "PostgreSQL tool suite is not approved major 17");
      }
      return Object.freeze({ pg_dump: results[0].text, pg_restore: results[1].text, psql: results[2].text, major: results[0].major });
    },
    async assertServerCompatibility(connection: PostgresConnection, containerName?: string) {
      const version = (await capture({ tool: "psql", operation: "PRODUCTION_DB_SERVER_VERSION_PROBE", args: ["--no-psqlrc", "--tuples-only", "--no-align", "--command=SHOW server_version_num"], connection, containerName })).trim();
      if (!/^[0-9]{6}$/.test(version)) throw new PostgresToolExecutionError({
        failureOperation: "PRODUCTION_DB_SERVER_VERSION_PROBE", failureTool: "psql", exitCode: 0,
        signalClass: "NONE", stderrClass: "SERVER_VERSION_INCOMPATIBLE", retryability: "NON_RETRYABLE_CONFIGURATION",
      }, "BACKUP_V2_POSTGRES_SERVER_VERSION_UNKNOWN");
      const major = Math.floor(Number.parseInt(version, 10) / 10_000);
      if (major > BACKUP_V2_POSTGRES_TOOL_MAJOR) throw new PostgresToolExecutionError({
        failureOperation: "PRODUCTION_DB_SERVER_VERSION_PROBE", failureTool: "psql", exitCode: 0,
        signalClass: "NONE", stderrClass: "SERVER_VERSION_INCOMPATIBLE", retryability: "NON_RETRYABLE_CONFIGURATION",
      }, "BACKUP_V2_POSTGRES_SERVER_NEWER_THAN_TOOL");
      return major;
    },
  });
}
