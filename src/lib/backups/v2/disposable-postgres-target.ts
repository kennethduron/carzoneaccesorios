import "server-only";

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

import {
  BACKUP_V2_POSTGRES_IMAGE,
  createPostgresToolRunner,
  type PostgresConnection,
  type PostgresToolRunner,
} from "./postgres-tool-runner.ts";
import { BackupV2FailClosedError } from "./types.ts";

const PURPOSE_LABEL = "com.carzone.backup-v2.purpose";
const MARKER_LABEL = "com.carzone.backup-v2.identity";
const OWNER_LABEL = "com.carzone.backup-v2.owner";
const PURPOSE = "disposable-restore-target";
const OWNER = "simplified-sql-operator-executor";
const USER = "carzone_backup_v2_restore";

export interface VerifiedDisposablePostgresTarget extends PostgresConnection {
  readonly user: string;
  readonly containerName: string;
  readonly marker: string;
  readonly verifiedLocalDisposable: true;
  readonly postgresMajor: 17;
}

export interface DisposablePostgresProvision {
  readonly target: VerifiedDisposablePostgresTarget;
  readonly runner: PostgresToolRunner;
  verify(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface DisposablePostgresIdentity {
  readonly containerName: string;
  readonly database: string;
  readonly user: "carzone_backup_v2_restore";
}

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

export function createDisposablePostgresIdentity(suffix: string): DisposablePostgresIdentity {
  if (!/^[a-z0-9]{8,32}$/.test(suffix)) fail("BACKUP_V2_RESTORE_SUFFIX_INVALID", "Disposable target suffix is invalid");
  return Object.freeze({
    containerName: `carzone-backup-v2-restore-${suffix}`,
    database: `carzone_backup_v2_restore_${suffix}`,
    user: USER,
  });
}

function docker(args: readonly string[], environment?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...args], {
      env: environment ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(0, 1_048_576); });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(0, 8_192); });
    child.once("error", () => reject(new BackupV2FailClosedError("BACKUP_V2_DOCKER_UNAVAILABLE", "Docker could not start")));
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new BackupV2FailClosedError(
      "BACKUP_V2_DOCKER_OPERATION_FAILED",
      `Docker operation failed${stderr.trim() ? `: ${stderr.replace(/[\r\n\t]+/g, " ").trim().slice(0, 512)}` : ""}`,
    )));
  });
}

function inspectDocument(value: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail("BACKUP_V2_DOCKER_INSPECT_INVALID", "Docker inspection was not valid JSON"); }
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== "object" || parsed[0] === null) {
    fail("BACKUP_V2_DOCKER_INSPECT_INVALID", "Docker inspection was ambiguous");
  }
  return parsed[0] as Record<string, unknown>;
}

function readInspection(document: Record<string, unknown>): {
  running: boolean; labels: Record<string, string>; hostIp: string; hostPort: number;
} {
  const state = document.State as Record<string, unknown> | undefined;
  const config = document.Config as Record<string, unknown> | undefined;
  const network = document.NetworkSettings as Record<string, unknown> | undefined;
  const labels = config?.Labels as Record<string, string> | undefined;
  const ports = network?.Ports as Record<string, Array<Record<string, string>>> | undefined;
  const binding = ports?.["5432/tcp"];
  if (state?.Running !== true || !labels || !Array.isArray(binding) || binding.length !== 1 ||
      binding[0]?.HostIp !== "127.0.0.1" || !/^[1-9][0-9]{0,4}$/.test(binding[0]?.HostPort ?? "")) {
    fail("BACKUP_V2_RESTORE_TARGET_BINDING_DENIED", "Restore target must have one unambiguous 127.0.0.1-only binding");
  }
  const hostPort = Number(binding[0].HostPort);
  if (hostPort > 65_535) fail("BACKUP_V2_RESTORE_TARGET_BINDING_DENIED", "Restore target port is invalid");
  return { running: true, labels, hostIp: binding[0].HostIp, hostPort };
}

function inspectionLabels(document: Record<string, unknown>): Record<string, string> {
  const config = document.Config as Record<string, unknown> | undefined;
  const labels = config?.Labels;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) {
    fail("BACKUP_V2_DOCKER_INSPECT_INVALID", "Docker labels are missing");
  }
  return labels as Record<string, string>;
}

async function waitForServer(runner: PostgresToolRunner, connection: PostgresConnection, containerName: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const result = await runner.capture({ tool: "psql", operation: "RESTORE_DB_PSQL_VERIFY", args: ["--no-psqlrc", "--tuples-only", "--no-align", "--command=SELECT 1"], connection, containerName });
      if (result.trim() === "1") return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new BackupV2FailClosedError("BACKUP_V2_RESTORE_TARGET_NOT_READY", "Disposable PostgreSQL did not become ready");
}

export async function provisionDisposablePostgresTarget(input: {
  password: string;
  suffix?: string;
}): Promise<DisposablePostgresProvision> {
  if (typeof input.password !== "string" || input.password.length < 12 || input.password.length > 256 || /[\u0000\r\n]/.test(input.password)) {
    fail("BACKUP_V2_RESTORE_PASSWORD_INVALID", "Disposable restore password is invalid");
  }
  const suffix = input.suffix ?? randomBytes(6).toString("hex");
  const identity = createDisposablePostgresIdentity(suffix);
  const { containerName, database } = identity;
  const marker = randomBytes(16).toString("hex");
  const dockerEnvironment = { ...process.env, POSTGRES_PASSWORD: input.password };
  let created = false;
  try {
    await docker([
      "run", "--detach", "--name", containerName,
      "--label", `${PURPOSE_LABEL}=${PURPOSE}`,
      "--label", `${MARKER_LABEL}=${marker}`,
      "--label", `${OWNER_LABEL}=${OWNER}`,
      "--publish", "127.0.0.1::5432",
      "--env", "POSTGRES_PASSWORD",
      "--env", `POSTGRES_USER=${USER}`,
      "--env", `POSTGRES_DB=${database}`,
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      BACKUP_V2_POSTGRES_IMAGE,
    ], dockerEnvironment);
    created = true;
    const inspection = readInspection(inspectDocument(await docker(["inspect", containerName])));
    if (inspection.labels[PURPOSE_LABEL] !== PURPOSE || inspection.labels[MARKER_LABEL] !== marker || inspection.labels[OWNER_LABEL] !== OWNER) {
      fail("BACKUP_V2_RESTORE_TARGET_IDENTITY_DENIED", "Disposable container labels do not match the provisioned identity");
    }
    const runner = createPostgresToolRunner({ mode: "CONTAINER" });
    const internalConnection = Object.freeze({ host: "127.0.0.1", port: 5432, database, username: USER, password: input.password });
    await waitForServer(runner, internalConnection, containerName);
    await runner.capture({
      tool: "psql",
      operation: "RESTORE_DB_SCHEMA_INITIALIZE",
      args: ["--no-psqlrc", "--set=ON_ERROR_STOP=1", "--command=CREATE SCHEMA carzone_backup_v2_local; CREATE TABLE carzone_backup_v2_local.restore_target_identity (marker text PRIMARY KEY, purpose text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());"],
      connection: internalConnection,
      containerName,
    });
    await runner.capture({
      tool: "psql",
      operation: "RESTORE_DB_MARKER_WRITE",
      args: ["--no-psqlrc", "--set=ON_ERROR_STOP=1", `--command=INSERT INTO carzone_backup_v2_local.restore_target_identity(marker, purpose) VALUES ('${marker}', 'disposable-restore-target');`],
      connection: internalConnection,
      containerName,
    });
    const target = Object.freeze({
      ...internalConnection,
      user: USER,
      host: "127.0.0.1",
      port: inspection.hostPort,
      containerName,
      marker,
      verifiedLocalDisposable: true as const,
      postgresMajor: 17 as const,
    });
    const verify = async () => {
      const current = readInspection(inspectDocument(await docker(["inspect", containerName])));
      if (current.hostIp !== "127.0.0.1" || current.hostPort !== target.port || current.labels[PURPOSE_LABEL] !== PURPOSE ||
          current.labels[MARKER_LABEL] !== marker || current.labels[OWNER_LABEL] !== OWNER) {
        fail("BACKUP_V2_RESTORE_TARGET_IDENTITY_DENIED", "Disposable container identity changed");
      }
      const evidence = (await runner.capture({
        tool: "psql",
        operation: "RESTORE_DB_IDENTITY_PROBE",
        args: ["--no-psqlrc", "--tuples-only", "--no-align",
          `--command=SELECT current_database() || '|' || current_user || '|' || purpose FROM carzone_backup_v2_local.restore_target_identity WHERE marker = '${marker}'`],
        connection: internalConnection,
        containerName,
      })).trim();
      if (evidence !== `${database}|${USER}|${PURPOSE}`) fail("BACKUP_V2_RESTORE_TARGET_MARKER_MISSING", "Disposable database marker is missing or incorrect");
    };
    await verify();
    let cleaned = false;
    return Object.freeze({
      target,
      runner,
      verify,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        const labels = inspectionLabels(inspectDocument(await docker(["inspect", containerName])));
        if (labels[OWNER_LABEL] !== OWNER || labels[MARKER_LABEL] !== marker || labels[PURPOSE_LABEL] !== PURPOSE) {
          fail("BACKUP_V2_DOCKER_CLEANUP_DENIED", "Refusing to clean a Docker resource not created by this provision");
        }
        await docker(["rm", "--force", "--volumes", containerName]);
      },
    });
  } catch (error) {
    if (created) await docker(["rm", "--force", "--volumes", containerName]).catch(() => undefined);
    throw error;
  }
}

export function assertVerifiedDisposableTarget(target: VerifiedDisposablePostgresTarget): void {
  if (target?.verifiedLocalDisposable !== true || target.host !== "127.0.0.1" ||
      !/^carzone_backup_v2_restore_[a-z0-9]{8,32}$/.test(target.database) || target.username !== USER ||
      !/^carzone-backup-v2-restore-[a-z0-9-]{8,80}$/.test(target.containerName) || !/^[a-f0-9]{32}$/.test(target.marker)) {
    fail("BACKUP_V2_PRODUCTION_RESTORE_TARGET_DENIED", "Restore target lacks positive local disposable identity");
  }
}
