import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  BACKUP_V2_STORAGE_CONTRACT_VERSION,
  BackupV2StorageError,
  assertCanonicalBackupV2ObjectKey,
  registerBackupV2StorageProvider,
  requireStorageIdentity,
  type BackupV2StorageProvider,
  type BackupV2StoredObjectStat,
} from "./storage-contract.ts";
import { BackupV2FailClosedError } from "./types.ts";

export interface DisposableFilesystemFaults {
  failWriteAfterBytes?: bigint;
  falseSuccessTruncateBytes?: number;
  transientWriteFailures?: number;
  transientStatFailures?: number;
  transientReadFailures?: number;
  operationDelayMs?: number;
  statSizeOverride?: bigint;
  statObjectKeyOverride?: string;
  readMode?: "normal" | "corrupt" | "truncate" | "append" | "missing";
  wrongObjectKey?: string;
  secretBearingError?: boolean;
}

export interface DisposableFilesystemStorageProvider extends BackupV2StorageProvider {
  resolveObjectPathForTest(objectKey: string): Promise<string>;
}

export interface CreateDisposableFilesystemStorageProviderInput {
  root: string;
  providerInstanceId: string;
  namespaceId: string;
  failureDomain: string | null;
  faults?: DisposableFilesystemFaults;
}

function storageError(code: string, message: string, kind: ConstructorParameters<typeof BackupV2StorageError>[2], retryable = false): BackupV2StorageError {
  return new BackupV2StorageError(code, message, kind, retryable);
}

function abortError(): BackupV2StorageError {
  return storageError("BACKUP_V2_STORAGE_CANCELLED", "Storage operation was cancelled", "cancelled");
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void { signal.removeEventListener("abort", cancelled); resolve(); }
    function cancelled(): void { clearTimeout(timer); reject(abortError()); }
    signal.addEventListener("abort", cancelled, { once: true });
  });
}

async function requireSafeRoot(rootValue: string): Promise<string> {
  if (typeof rootValue !== "string" || rootValue.trim().length === 0 || rootValue.includes("\0")) {
    throw storageError("BACKUP_V2_INVALID_STORAGE_ROOT", "Disposable storage root is invalid", "path_violation");
  }
  await mkdir(rootValue, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(rootValue);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw storageError("BACKUP_V2_INVALID_STORAGE_ROOT", "Disposable storage root is unsafe", "path_violation");
  }
  const root = await realpath(rootValue);
  if (root !== path.resolve(rootValue)) {
    throw storageError("BACKUP_V2_INVALID_STORAGE_ROOT", "Disposable storage root resolves through a link", "path_violation");
  }
  await chmod(root, 0o700).catch(() => undefined);
  return root;
}

function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function safeObjectPath(root: string, objectKeyValue: string, createParents: boolean): Promise<string> {
  const objectKey = assertCanonicalBackupV2ObjectKey(objectKeyValue);
  const parts = objectKey.split("/");
  let parent = root;
  for (const segment of parts.slice(0, -1)) {
    const candidate = path.resolve(parent, segment);
    if (!withinRoot(root, candidate)) {
      throw storageError("BACKUP_V2_STORAGE_PATH_VIOLATION", "Object path escaped provider root", "path_violation");
    }
    if (createParents) await mkdir(candidate, { mode: 0o700 }).catch((error: unknown) => {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    });
    let stat;
    try { stat = await lstat(candidate); } catch (error) {
      if (!createParents && error && typeof error === "object" && "code" in error && error.code === "ENOENT") return path.resolve(root, ...parts);
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(candidate) !== candidate) {
      throw storageError("BACKUP_V2_STORAGE_SYMLINK_DENIED", "Unsafe provider directory was denied", "path_violation");
    }
    parent = candidate;
  }
  const target = path.resolve(parent, parts.at(-1)!);
  if (!withinRoot(root, target) || path.dirname(target) !== parent) {
    throw storageError("BACKUP_V2_STORAGE_PATH_VIOLATION", "Object path escaped provider root", "path_violation");
  }
  try {
    const targetStat = await lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw storageError("BACKUP_V2_STORAGE_SYMLINK_DENIED", "Unsafe provider object was denied", "path_violation");
    }
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  return target;
}

function limitWrite(expected: bigint, failAfter?: bigint): Transform {
  let bytes = BigInt(0);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += BigInt(chunk.byteLength);
      if (failAfter !== undefined && bytes > failAfter) {
        callback(storageError("BACKUP_V2_SYNTHETIC_PARTIAL_UPLOAD", "Synthetic upload interruption", "unavailable", true));
      } else if (bytes > expected) {
        callback(storageError("BACKUP_V2_UPLOAD_SIZE_MISMATCH", "Upload exceeded expected bytes", "integrity"));
      } else callback(null, chunk);
    },
    flush(callback) {
      if (bytes !== expected) callback(storageError("BACKUP_V2_UPLOAD_SIZE_MISMATCH", "Upload byte count did not match", "integrity"));
      else callback();
    },
  });
}

export async function createDisposableFilesystemStorageProvider(
  input: CreateDisposableFilesystemStorageProviderInput,
): Promise<DisposableFilesystemStorageProvider> {
  const root = await requireSafeRoot(input.root);
  const providerInstanceId = requireStorageIdentity(input.providerInstanceId, "providerInstanceId");
  const namespaceId = requireStorageIdentity(input.namespaceId, "namespaceId");
  const failureDomain = input.failureDomain === null ? null : requireStorageIdentity(input.failureDomain, "failureDomain");
  const faults: Readonly<DisposableFilesystemFaults> = Object.freeze({ ...(input.faults ?? {}) });
  let writeFailures = faults.transientWriteFailures ?? 0;
  let statFailures = faults.transientStatFailures ?? 0;
  let readFailures = faults.transientReadFailures ?? 0;

  async function maybeFail(operation: "write" | "stat" | "read", signal: AbortSignal): Promise<void> {
    await abortableDelay(faults.operationDelayMs ?? 0, signal);
    if (signal.aborted) throw abortError();
    const remaining = operation === "write" ? writeFailures : operation === "stat" ? statFailures : readFailures;
    if (remaining > 0) {
      if (operation === "write") writeFailures -= 1;
      else if (operation === "stat") statFailures -= 1;
      else readFailures -= 1;
      const raw = faults.secretBearingError ? " synthetic-secret token=https://example.invalid/?sig=secret" : "";
      throw storageError("BACKUP_V2_PROVIDER_RATE_LIMITED", `Provider throttled.${raw}`, "rate_limited", true);
    }
  }

  const provider: DisposableFilesystemStorageProvider = {
    descriptor: {
      contractVersion: BACKUP_V2_STORAGE_CONTRACT_VERSION,
      providerType: "disposable_filesystem",
      providerInstanceId,
      namespaceId,
      failureDomain,
      capabilities: {
        streamingWrite: true, streamingRead: true, stat: true, conditionalCreate: true,
        readAfterWrite: true, atomicFinalize: true, immutableVersion: false, serverChecksum: false,
      },
    },

    async write({ objectKey, source, expectedSizeBytes, signal }) {
      await maybeFail("write", signal);
      if (typeof expectedSizeBytes !== "bigint" || expectedSizeBytes < BigInt(0)) {
        throw storageError("BACKUP_V2_INVALID_UPLOAD_SIZE", "Expected upload size is invalid", "configuration");
      }
      const target = await safeObjectPath(root, objectKey, true);
      const stagingRoot = path.join(root, ".staging");
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      const stagingStat = await lstat(stagingRoot);
      if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink() || await realpath(stagingRoot) !== stagingRoot) {
        throw storageError("BACKUP_V2_STORAGE_SYMLINK_DENIED", "Unsafe staging directory was denied", "path_violation");
      }
      const partial = path.join(stagingRoot, `${randomUUID()}.partial`);
      try {
        await pipeline(source, limitWrite(expectedSizeBytes, faults.failWriteAfterBytes), createWriteStream(partial, { flags: "wx", mode: 0o600 }), { signal });
        const handle = await open(partial, "r+");
        try { await handle.sync(); } finally { await handle.close(); }
        if (faults.falseSuccessTruncateBytes !== undefined) {
          const handleToTruncate = await open(partial, "r+");
          try { await handleToTruncate.truncate(faults.falseSuccessTruncateBytes); await handleToTruncate.sync(); }
          finally { await handleToTruncate.close(); }
        }
        await chmod(partial, 0o400).catch(() => undefined);
        let disposition: "created" | "already_exists" = "created";
        try { await link(partial, target); } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") disposition = "already_exists";
          else throw error;
        }
        return { disposition, objectKey };
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof BackupV2StorageError) throw error;
        if (error instanceof BackupV2FailClosedError) {
          throw storageError("BACKUP_V2_SOURCE_ARTIFACT_MISMATCH", "Upload source failed runtime verification", "integrity");
        }
        throw storageError("BACKUP_V2_PROVIDER_WRITE_FAILED", "Provider write failed", "unavailable", true);
      } finally {
        await rm(partial, { force: true }).catch(() => undefined);
      }
    },

    async stat({ objectKey, signal }): Promise<BackupV2StoredObjectStat | null> {
      await maybeFail("stat", signal);
      const target = await safeObjectPath(root, objectKey, false);
      try {
        const value = await lstat(target, { bigint: true });
        if (!value.isFile() || value.isSymbolicLink()) {
          throw storageError("BACKUP_V2_STORAGE_SYMLINK_DENIED", "Unsafe provider object was denied", "path_violation");
        }
        const identityHash = createHash("sha256").update(`${providerInstanceId}\n${namespaceId}\n${objectKey}\n${value.dev}\n${value.ino}`).digest("hex");
        return {
          objectKey: faults.statObjectKeyOverride ?? objectKey,
          sizeBytes: faults.statSizeOverride ?? value.size,
          physicalObjectIdentity: `backup-v2-object-v1:${providerInstanceId}:${namespaceId}:${identityHash}`,
          opaqueVersionId: null,
          opaqueEtag: null,
          providerChecksum: null,
        };
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
        if (error instanceof BackupV2StorageError) throw error;
        throw storageError("BACKUP_V2_PROVIDER_STAT_FAILED", "Provider stat failed", "unavailable", true);
      }
    },

    async openRead({ objectKey, signal }): Promise<Readable> {
      await maybeFail("read", signal);
      if (faults.readMode === "missing") {
        throw storageError("BACKUP_V2_STORED_OBJECT_NOT_FOUND", "Stored object was not found", "not_found");
      }
      const target = await safeObjectPath(root, faults.wrongObjectKey ?? objectKey, false);
      try {
        const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
        const handle = await open(target, flags);
        const value = await handle.stat();
        if (!value.isFile()) { await handle.close(); throw storageError("BACKUP_V2_STORAGE_SYMLINK_DENIED", "Unsafe provider object was denied", "path_violation"); }
        const stream = handle.createReadStream({ autoClose: true });
        signal.addEventListener("abort", () => stream.destroy(), { once: true });
        if (faults.readMode === "normal" || faults.readMode === undefined) return stream;
        let seen = false;
        const mode = faults.readMode;
        return stream.pipe(new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            const output = Buffer.from(chunk);
            if (mode === "corrupt" && !seen && output.length > 0) { output[0] ^= 1; seen = true; }
            if (mode === "truncate") { this.push(output.subarray(0, Math.max(0, output.length - 1))); seen = true; callback(); }
            else callback(null, output);
          },
          flush(callback) { if (mode === "append") this.push(Buffer.from([0])); callback(); },
        }));
      } catch (error) {
        if (error instanceof BackupV2StorageError) throw error;
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          throw storageError("BACKUP_V2_STORED_OBJECT_NOT_FOUND", "Stored object was not found", "not_found");
        }
        throw storageError("BACKUP_V2_PROVIDER_READ_FAILED", "Provider read failed", "unavailable", true);
      }
    },

    async resolveObjectPathForTest(objectKey: string): Promise<string> {
      return safeObjectPath(root, objectKey, false);
    },
  };
  return registerBackupV2StorageProvider(provider);
}
