import "server-only";

import { createHash } from "node:crypto";

import {
  BACKUP_V2_B2_MANAGED_PREFIX,
  type BackblazeB2RuntimeConfig,
} from "./b2-config.ts";
import { classifyBackblazeB2Error } from "./backblaze-b2-storage-provider.ts";
import type { BackblazeB2S3Transport } from "./b2-s3-transport.ts";
import {
  BackupV2StorageError,
  assertCanonicalBackupV2ObjectKey,
} from "./storage-contract.ts";
import { BACKUP_V2_SCOPES, BackupV2FailClosedError, type BackupV2Scope } from "./types.ts";

export interface BackupV2PlannedComponentBytes {
  readonly component: BackupV2Scope;
  readonly encryptedBytes: bigint | null;
}

export interface BackupV2CapacityPlan {
  readonly componentBytes: Readonly<Record<BackupV2Scope, string | null>>;
  readonly plannedGenerationBytes: string | null;
  readonly currentManagedBytes: string | null;
  readonly projectedPostUploadBytes: string | null;
  readonly softBudgetBytes: string | null;
  readonly remainingSoftBudgetBytes: string | null;
  readonly estimatedSimilarlySizedGenerationsFit: string | null;
  readonly uploadAuthorization: "allowed" | "denied";
  readonly blockingReasons: readonly string[];
}

export interface B2ManagedCapacityReport {
  readonly configFingerprint: string;
  readonly managedPrefix: typeof BACKUP_V2_B2_MANAGED_PREFIX;
  readonly managedBytes: bigint;
  readonly objectCount: number;
  readonly pagesRead: number;
  readonly unmanagedObjectRefs: readonly string[];
  readonly visibleCurrentVersionsOnly: true;
}

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

function validByteCount(value: bigint | null, field: string): bigint | null {
  if (value === null) return null;
  if (typeof value !== "bigint" || value < BigInt(0)) fail("BACKUP_V2_CAPACITY_INPUT_INVALID", `${field} is invalid`);
  return value;
}

export function planBackupV2Capacity(input: {
  readonly components: readonly BackupV2PlannedComponentBytes[];
  readonly currentManagedBytes: bigint | null;
  readonly softBudgetBytes: bigint | null;
}): BackupV2CapacityPlan {
  const byScope = new Map<BackupV2Scope, bigint | null>();
  for (const item of input.components) {
    if (!BACKUP_V2_SCOPES.includes(item.component) || byScope.has(item.component)) {
      fail("BACKUP_V2_CAPACITY_COMPONENT_INVALID", "Capacity plan components are invalid or duplicated");
    }
    byScope.set(item.component, validByteCount(item.encryptedBytes, `${item.component}.encryptedBytes`));
  }
  const componentBytes = Object.fromEntries(BACKUP_V2_SCOPES.map((scope) => [
    scope,
    byScope.get(scope)?.toString() ?? null,
  ])) as Record<BackupV2Scope, string | null>;
  const blockingReasons: string[] = [];
  const missingComponents = BACKUP_V2_SCOPES.filter((scope) => !byScope.has(scope));
  if (missingComponents.length > 0) blockingReasons.push("all_five_component_estimates_required");
  if ([...byScope.values()].some((value) => value === null)) blockingReasons.push("exact_encrypted_component_bytes_unknown");
  const currentManagedBytes = validByteCount(input.currentManagedBytes, "currentManagedBytes");
  const softBudgetBytes = validByteCount(input.softBudgetBytes, "softBudgetBytes");
  if (currentManagedBytes === null) blockingReasons.push("current_provider_managed_bytes_unknown");
  if (softBudgetBytes === null || softBudgetBytes <= BigInt(0)) blockingReasons.push("positive_soft_budget_required");
  const exactComponents = missingComponents.length === 0 && [...byScope.values()].every((value) => value !== null);
  const plannedGenerationBytes = exactComponents
    ? [...byScope.values()].reduce<bigint>((sum, value) => sum + (value ?? BigInt(0)), BigInt(0))
    : null;
  if (plannedGenerationBytes !== null && plannedGenerationBytes <= BigInt(0)) {
    blockingReasons.push("planned_generation_must_be_nonempty");
  }
  const projectedPostUploadBytes = plannedGenerationBytes !== null && currentManagedBytes !== null
    ? plannedGenerationBytes + currentManagedBytes
    : null;
  if (projectedPostUploadBytes !== null && softBudgetBytes !== null && projectedPostUploadBytes > softBudgetBytes) {
    blockingReasons.push("soft_budget_exceeded");
  }
  const remainingSoftBudgetBytes = currentManagedBytes !== null && softBudgetBytes !== null
    ? softBudgetBytes > currentManagedBytes ? softBudgetBytes - currentManagedBytes : BigInt(0)
    : null;
  const estimatedSimilarlySizedGenerationsFit = remainingSoftBudgetBytes !== null &&
      plannedGenerationBytes !== null && plannedGenerationBytes > BigInt(0)
    ? remainingSoftBudgetBytes / plannedGenerationBytes
    : null;
  return Object.freeze({
    componentBytes: Object.freeze(componentBytes),
    plannedGenerationBytes: plannedGenerationBytes?.toString() ?? null,
    currentManagedBytes: currentManagedBytes?.toString() ?? null,
    projectedPostUploadBytes: projectedPostUploadBytes?.toString() ?? null,
    softBudgetBytes: softBudgetBytes?.toString() ?? null,
    remainingSoftBudgetBytes: remainingSoftBudgetBytes?.toString() ?? null,
    estimatedSimilarlySizedGenerationsFit: estimatedSimilarlySizedGenerationsFit?.toString() ?? null,
    uploadAuthorization: blockingReasons.length === 0 ? "allowed" : "denied",
    blockingReasons: Object.freeze(blockingReasons),
  });
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new BackupV2StorageError(
    "BACKUP_V2_STORAGE_CANCELLED", "Storage operation was cancelled", "cancelled",
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void { signal?.removeEventListener("abort", abort); resolve(); }
    function abort(): void {
      clearTimeout(timer);
      reject(new BackupV2StorageError(
        "BACKUP_V2_STORAGE_CANCELLED", "Storage operation was cancelled", "cancelled",
      ));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function listPageWithRetry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
): Promise<T> {
  let last: BackupV2StorageError | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (outerSignal?.aborted) throw classifyBackblazeB2Error(new DOMException("Aborted", "AbortError"), outerSignal);
    const controller = new AbortController();
    const relay = () => controller.abort();
    outerSignal?.addEventListener("abort", relay, { once: true });
    let timedOut = false;
    let rejectTimeout: ((reason: BackupV2StorageError) => void) | null = null;
    const timeout = new Promise<T>((_resolve, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout?.(new BackupV2StorageError(
        "BACKUP_V2_B2_PREFLIGHT_TIMEOUT", "B2 preflight timed out", "timeout", true,
      ));
    }, 30_000);
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } catch (error) {
      last = timedOut
        ? new BackupV2StorageError("BACKUP_V2_B2_PREFLIGHT_TIMEOUT", "B2 preflight timed out", "timeout", true)
        : classifyBackblazeB2Error(error, outerSignal?.aborted ? outerSignal : undefined);
      if (!last.retryable || attempt === 3) throw last;
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", relay);
    }
    await wait(Math.min(Math.max(50 * (2 ** (attempt - 1)), last.retryAfterMs ?? 0), 10_000), outerSignal);
  }
  throw last ?? new BackupV2StorageError("BACKUP_V2_B2_PREFLIGHT_FAILED", "B2 preflight failed", "unavailable");
}

export async function inspectBackblazeB2ManagedCapacity(input: {
  readonly config: BackblazeB2RuntimeConfig;
  readonly transport: BackblazeB2S3Transport;
  readonly signal?: AbortSignal;
  readonly maxPages?: number;
}): Promise<B2ManagedCapacityReport> {
  const maxPages = input.maxPages ?? 100;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1_000) {
    fail("BACKUP_V2_B2_PAGINATION_POLICY_INVALID", "B2 pagination bound is invalid");
  }
  const seenTokens = new Set<string>();
  const seenKeys = new Set<string>();
  const unmanagedObjectRefs: string[] = [];
  let continuationToken: string | null = null;
  let managedBytes = BigInt(0);
  let pagesRead = 0;
  do {
    if (pagesRead >= maxPages) fail("BACKUP_V2_B2_PAGINATION_LIMIT", "B2 managed-prefix pagination exceeded its bound");
    const page = await listPageWithRetry((signal) => input.transport.listObjectsV2({
      bucket: input.config.bucket,
      prefix: BACKUP_V2_B2_MANAGED_PREFIX,
      continuationToken,
      maxKeys: 1_000,
      signal,
    }), input.signal);
    pagesRead += 1;
    for (const object of page.objects) {
      if (!object.key.startsWith(BACKUP_V2_B2_MANAGED_PREFIX) || seenKeys.has(object.key) || object.sizeBytes < BigInt(0)) {
        fail("BACKUP_V2_B2_LIST_RESPONSE_INVALID", "B2 returned an unsafe or duplicate managed object");
      }
      seenKeys.add(object.key);
      managedBytes += object.sizeBytes;
      try { assertCanonicalBackupV2ObjectKey(object.key); }
      catch {
        unmanagedObjectRefs.push(`sha256:${createHash("sha256").update(object.key).digest("hex")}`);
      }
    }
    const next = page.nextContinuationToken;
    if (next !== null) {
      if (!next || next.length > 2_048 || /[\u0000-\u001f\u007f]/.test(next) || seenTokens.has(next)) {
        fail("BACKUP_V2_B2_PAGINATION_LOOP", "B2 returned an unsafe or repeated continuation token");
      }
      seenTokens.add(next);
    }
    continuationToken = next;
  } while (continuationToken !== null);
  return Object.freeze({
    configFingerprint: input.config.configFingerprint,
    managedPrefix: BACKUP_V2_B2_MANAGED_PREFIX,
    managedBytes,
    objectCount: seenKeys.size,
    pagesRead,
    unmanagedObjectRefs: Object.freeze(unmanagedObjectRefs),
    visibleCurrentVersionsOnly: true,
  });
}
