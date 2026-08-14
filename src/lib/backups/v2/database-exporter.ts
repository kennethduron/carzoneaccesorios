import "server-only";

import { spawn } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";

import { BackupV2FailClosedError } from "./types.ts";

const MAX_SAFE_STDERR_CHARS = 8_192;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export interface DatabaseExportSession {
  stream: Readable;
  completed: Promise<void>;
  cancel: () => void;
}

export interface DatabaseExporter {
  readonly tool: "pg_dump";
  readonly toolVersion: string;
  readonly format: "postgresql_custom";
  open: (signal?: AbortSignal) => DatabaseExportSession;
}

export interface PgDumpConnection {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export interface PgDumpExporterOptions {
  connection: PgDumpConnection;
  executable?: string;
}

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

function requireCredentialField(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || CONTROL_CHARACTER_PATTERN.test(value)) {
    fail("BACKUP_V2_INVALID_EXPORT_CONFIGURATION", `${field} is invalid`);
  }
  return value;
}

function requirePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    fail("BACKUP_V2_INVALID_EXPORT_CONFIGURATION", "PostgreSQL port is invalid");
  }
  return value;
}

function requirePgDumpExecutable(value: string): string {
  const base = path.basename(value).toLowerCase();
  if (base !== "pg_dump" && base !== "pg_dump.exe") {
    fail("BACKUP_V2_UNSAFE_EXPORT_EXECUTABLE", "Exporter executable must be pg_dump");
  }
  return value;
}

function minimalProcessEnvironment(connection?: PgDumpConnection): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "LANG", "LC_ALL", "TMP", "TEMP"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  if (connection) {
    environment.PGHOST = connection.host;
    environment.PGPORT = String(connection.port);
    environment.PGDATABASE = connection.database;
    environment.PGUSER = connection.username;
    environment.PGPASSWORD = connection.password;
    environment.PGCONNECT_TIMEOUT = "15";
  }
  return environment;
}

function sanitizeSubprocessError(value: string, secrets: readonly string[]): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret.length > 0) sanitized = sanitized.replaceAll(secret, "[redacted]");
  }
  sanitized = sanitized
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-database-url]")
    .replace(/(password|token|secret)\s*[=:]\s*[^\s;]+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return sanitized.slice(0, MAX_SAFE_STDERR_CHARS);
}

async function inspectPgDumpVersion(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], {
      env: minimalProcessEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(0, 512); });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(0, 512); });
    child.once("error", () => reject(new BackupV2FailClosedError(
      "BACKUP_V2_EXPORT_TOOL_UNAVAILABLE", "pg_dump could not be started",
    )));
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(new BackupV2FailClosedError(
          "BACKUP_V2_EXPORT_TOOL_UNAVAILABLE",
          `pg_dump version check failed${stderr.trim() ? `: ${sanitizeSubprocessError(stderr, [])}` : ""}`,
        ));
        return;
      }
      const match = stdout.trim().match(/^pg_dump \(PostgreSQL\) ([A-Za-z0-9._+-]+)$/);
      if (!match) {
        reject(new BackupV2FailClosedError(
          "BACKUP_V2_EXPORT_TOOL_VERSION_UNKNOWN", "pg_dump returned an unsupported version string",
        ));
        return;
      }
      resolve(`pg_dump (PostgreSQL) ${match[1]}`);
    });
  });
}

export async function createPgDumpExporter(options: PgDumpExporterOptions): Promise<DatabaseExporter> {
  const executable = requirePgDumpExecutable(options.executable ?? "pg_dump");
  const connection: PgDumpConnection = {
    host: requireCredentialField(options.connection.host, "host"),
    port: requirePort(options.connection.port),
    database: requireCredentialField(options.connection.database, "database"),
    username: requireCredentialField(options.connection.username, "username"),
    password: requireCredentialField(options.connection.password, "password"),
  };
  const toolVersion = await inspectPgDumpVersion(executable);
  return {
    tool: "pg_dump",
    toolVersion,
    format: "postgresql_custom",
    open(signal?: AbortSignal): DatabaseExportSession {
      const child = spawn(executable, [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
      ], {
        env: minimalProcessEnvironment(connection),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < MAX_SAFE_STDERR_CHARS) stderr += chunk;
      });
      const cancel = () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      };
      if (signal?.aborted) cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      const completed = new Promise<void>((resolve, reject) => {
        child.once("error", () => reject(new BackupV2FailClosedError(
          "BACKUP_V2_EXPORT_FAILED", "pg_dump could not be started",
        )));
        child.once("close", (code, exitSignal) => {
          signal?.removeEventListener("abort", cancel);
          if (code === 0 && exitSignal === null) {
            resolve();
            return;
          }
          const safeDetail = sanitizeSubprocessError(stderr, [
            connection.password, connection.host, connection.database, connection.username,
          ]);
          reject(new BackupV2FailClosedError(
            signal?.aborted ? "BACKUP_V2_EXPORT_CANCELLED" : "BACKUP_V2_EXPORT_FAILED",
            `pg_dump did not complete successfully (code ${code ?? "none"}, signal ${exitSignal ?? "none"})${
              safeDetail ? `: ${safeDetail}` : ""
            }`,
          ));
        });
      });
      return { stream: child.stdout, completed, cancel };
    },
  };
}
