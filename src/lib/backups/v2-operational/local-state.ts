import "server-only";

import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../v2/database-artifact-format.ts";
import { BackupV2FailClosedError } from "../v2/types.ts";
import { sanitizeOperationalText } from "./policy.ts";

export interface OperationalStatus {
  readonly schema: "car-zone-backup-v2-operational-status-v1";
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastRunId: string | null;
  readonly lastGenerationId: string | null;
  readonly lastResult: "NEVER_RUN" | "RUNNING" | "PASS" | "FAIL";
  readonly lastErrorCode: string | null;
  readonly consecutiveFailures: number;
  readonly successfulScheduledGenerations: number;
  readonly b2UsageBytes: string | null;
  readonly nextScheduledRun: string;
  readonly retentionMode: "DRY_RUN" | "ACTIVE";
}

const LOCK_STALE_MS = 12 * 60 * 60 * 1000;

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

export function defaultOperationalStatus(): OperationalStatus {
  return Object.freeze({
    schema: "car-zone-backup-v2-operational-status-v1",
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastRunId: null,
    lastGenerationId: null,
    lastResult: "NEVER_RUN",
    lastErrorCode: null,
    consecutiveFailures: 0,
    successfulScheduledGenerations: 0,
    b2UsageBytes: null,
    nextScheduledRun: nextScheduledRun(),
    retentionMode: "DRY_RUN",
  });
}

export function nextScheduledRun(now = new Date()): string {
  const next = new Date(now);
  next.setUTCHours(9, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

export async function readOperationalStatus(statusPath: string): Promise<OperationalStatus> {
  try {
    const parsed = JSON.parse(await readFile(statusPath, "utf8")) as OperationalStatus;
    if (parsed.schema !== "car-zone-backup-v2-operational-status-v1" ||
        !Number.isSafeInteger(parsed.consecutiveFailures) || parsed.consecutiveFailures < 0 ||
        !Number.isSafeInteger(parsed.successfulScheduledGenerations) || parsed.successfulScheduledGenerations < 0) {
      fail("BACKUP_V2_OPERATIONAL_STATUS_INVALID", "Operational status is invalid");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultOperationalStatus();
    throw error;
  }
}

export async function writeOperationalStatus(statusPath: string, status: OperationalStatus): Promise<void> {
  await mkdir(path.dirname(statusPath), { recursive: true, mode: 0o700 });
  const temporary = `${statusPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${canonicalJson(status)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, statusPath);
}

export async function appendOperationalLog(logPath: string, record: Readonly<Record<string, unknown>>): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const safe = Object.fromEntries(Object.entries(record).map(([key, value]) => {
    if (typeof value === "string") return [key, sanitizeOperationalText(value, 500)];
    if (typeof value === "number" || typeof value === "boolean" || value === null) return [key, value];
    return [key, sanitizeOperationalText(String(value), 500)];
  }));
  await appendFile(logPath, `${canonicalJson(safe)}\n`, { encoding: "utf8", mode: 0o600 });
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function acquireOperationalLock(lockPath: string): Promise<{ readonly staleRecovered: boolean; release(): Promise<void> }> {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let staleRecovered = false;
  try {
    const details = await stat(lockPath);
    let ownerPid = 0;
    try { ownerPid = Number((JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown }).pid); }
    catch { /* Invalid old lock is stale only after the conservative age gate. */ }
    if (Date.now() - details.mtimeMs <= LOCK_STALE_MS || processAlive(ownerPid)) {
      fail("BACKUP_V2_OPERATIONAL_ALREADY_RUNNING", "Another operational Backup V2 instance is active");
    }
    await rm(lockPath, { force: true });
    staleRecovered = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof BackupV2FailClosedError)) throw error;
    if (error instanceof BackupV2FailClosedError) throw error;
  }
  const token = randomUUID();
  const handle = await open(lockPath, "wx", 0o600).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("BACKUP_V2_OPERATIONAL_ALREADY_RUNNING", "Another operational Backup V2 instance acquired the lock");
    }
    throw error;
  });
  await handle.writeFile(`${canonicalJson({ schema: "car-zone-backup-v2-lock-v1", pid: process.pid, token })}\n`, "utf8");
  await handle.close();
  let released = false;
  return Object.freeze({
    staleRecovered,
    async release() {
      if (released) return;
      released = true;
      try {
        const value = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
        if (value.token !== token) fail("BACKUP_V2_OPERATIONAL_LOCK_IDENTITY_CHANGED", "Operational lock identity changed");
        const details = await lstat(lockPath);
        if (!details.isFile() || details.isSymbolicLink()) fail("BACKUP_V2_OPERATIONAL_LOCK_INVALID", "Operational lock is unsafe");
        await rm(lockPath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  });
}
