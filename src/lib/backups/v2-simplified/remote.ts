import "server-only";

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  assertRegisteredBackupV2StorageProvider,
  BackupV2StorageError,
  sanitizeStorageError,
  type BackupV2StorageProvider,
} from "../v2/storage-contract.ts";
import { BackupV2FailClosedError } from "../v2/types.ts";
import { assertSimplifiedObjectKey, safeHashEqual } from "./core.ts";
import type { SimplifiedArtifactDescriptor } from "./types.ts";

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}
class HashMeter extends Transform {
  #bytes = BigInt(0);
  readonly #hash = createHash("sha256");

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.#bytes += BigInt(value.byteLength);
    this.#hash.update(value);
    callback(null, value);
  }

  result(): { bytes: bigint; sha256: string } {
    return { bytes: this.#bytes, sha256: this.#hash.digest("hex") };
  }
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() { signal?.removeEventListener("abort", cancelled); resolve(); }
    function cancelled() {
      clearTimeout(timer);
      reject(new BackupV2StorageError("BACKUP_V2_STORAGE_CANCELLED", "Storage operation was cancelled", "cancelled"));
    }
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}

export async function retrySimplifiedStorageOperation<T>(input: {
  readonly operation: (signal: AbortSignal, attempt: number) => Promise<T>;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<T> {
  const attempts = input.maxAttempts ?? 3;
  const delay = input.baseDelayMs ?? 250;
  const timeout = input.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5 ||
      !Number.isSafeInteger(delay) || delay < 0 || delay > 10_000 ||
      !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15 * 60_000) {
    fail("BACKUP_V2_SIMPLIFIED_RETRY_POLICY_INVALID", "Remote retry policy is invalid");
  }
  let last: BackupV2StorageError | null = null;
  for (let index = 0; index < attempts; index += 1) {
    if (input.signal?.aborted) throw new BackupV2StorageError("BACKUP_V2_STORAGE_CANCELLED", "Storage operation was cancelled", "cancelled");
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    try {
      return await input.operation(signal, index + 1);
    } catch (error) {
      const classified = timeoutSignal.aborted && !input.signal?.aborted
        ? new BackupV2StorageError("BACKUP_V2_B2_TIMEOUT", "B2 operation timed out", "timeout", true)
        : sanitizeStorageError(error, "BACKUP_V2_SIMPLIFIED_B2_UNAVAILABLE");
      last = classified;
      if (!classified.retryable || index + 1 >= attempts) throw classified;
      await pause(classified.retryAfterMs ?? Math.min(delay * (2 ** index), 10_000), input.signal);
    }
  }
  throw last ?? new BackupV2StorageError("BACKUP_V2_SIMPLIFIED_B2_UNAVAILABLE", "B2 operation failed", "unavailable");
}

async function readback(input: {
  provider: BackupV2StorageProvider;
  descriptor: SimplifiedArtifactDescriptor;
  maxAttempts?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  await retrySimplifiedStorageOperation({
    maxAttempts: input.maxAttempts,
    baseDelayMs: input.baseDelayMs,
    signal: input.signal,
    async operation(signal) {
      const stream = await input.provider.openRead({ objectKey: input.descriptor.objectKey, signal });
      const meter = new HashMeter();
      await pipeline(stream, meter, new Transform({ transform(_chunk, _encoding, callback) { callback(); } }), { signal });
      const measured = meter.result();
      if (measured.bytes !== input.descriptor.bytes || !safeHashEqual(measured.sha256, input.descriptor.sha256)) {
        throw new BackupV2StorageError(
          "BACKUP_V2_SIMPLIFIED_REMOTE_COLLISION",
          "Remote object bytes differ from the immutable local artifact",
          "conflict",
        );
      }
    },
  });
}

export interface SimplifiedRemoteObjectResult {
  readonly descriptor: SimplifiedArtifactDescriptor;
  readonly disposition: "created" | "same_bytes_reused";
}

export async function uploadAndVerifySimplifiedArtifacts(input: {
  readonly provider: BackupV2StorageProvider;
  readonly runId: string;
  readonly descriptors: readonly SimplifiedArtifactDescriptor[];
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly signal?: AbortSignal;
}): Promise<readonly SimplifiedRemoteObjectResult[]> {
  assertRegisteredBackupV2StorageProvider(input.provider);
  const results: SimplifiedRemoteObjectResult[] = [];
  for (const descriptor of input.descriptors) {
    assertSimplifiedObjectKey(descriptor.objectKey, input.runId);
    const writeDisposition = await retrySimplifiedStorageOperation({
      maxAttempts: input.maxAttempts,
      baseDelayMs: input.baseDelayMs,
      signal: input.signal,
      async operation(signal) {
        // A new file stream is deliberately created inside every retry attempt.
        const source = createReadStream(descriptor.localPath);
        try {
          const write = await input.provider.write({
            objectKey: descriptor.objectKey,
            source,
            expectedSizeBytes: descriptor.bytes,
            signal,
          });
          return write.disposition;
        } finally {
          source.destroy();
        }
      },
    });
    const stat = await retrySimplifiedStorageOperation({
      maxAttempts: input.maxAttempts,
      baseDelayMs: input.baseDelayMs,
      signal: input.signal,
      operation: (signal) => input.provider.stat({ objectKey: descriptor.objectKey, signal }),
    });
    if (stat === null || stat.objectKey !== descriptor.objectKey || stat.sizeBytes !== descriptor.bytes) {
      throw new BackupV2StorageError(
        writeDisposition === "already_exists" ? "BACKUP_V2_SIMPLIFIED_REMOTE_COLLISION" : "BACKUP_V2_SIMPLIFIED_REMOTE_STAT_MISMATCH",
        "Remote object stat does not match the local artifact",
        writeDisposition === "already_exists" ? "conflict" : "integrity",
      );
    }
    await readback({
      provider: input.provider,
      descriptor,
      maxAttempts: input.maxAttempts,
      baseDelayMs: input.baseDelayMs,
      signal: input.signal,
    });
    results.push(Object.freeze({
      descriptor,
      disposition: writeDisposition === "already_exists" ? "same_bytes_reused" : "created",
    }));
  }
  return Object.freeze(results);
}

export async function downloadAndVerifySimplifiedArtifacts(input: {
  readonly provider: BackupV2StorageProvider;
  readonly runId: string;
  readonly descriptors: readonly SimplifiedArtifactDescriptor[];
  readonly downloadRoot: string;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyMap<string, string>> {
  assertRegisteredBackupV2StorageProvider(input.provider);
  await mkdir(input.downloadRoot, { mode: 0o700 });
  const output = new Map<string, string>();
  for (const descriptor of input.descriptors) {
    assertSimplifiedObjectKey(descriptor.objectKey, input.runId);
    const directory = path.join(input.downloadRoot, descriptor.component);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, path.basename(descriptor.localPath));
    const partial = `${destination}.partial`;
    try {
      await retrySimplifiedStorageOperation({
        maxAttempts: input.maxAttempts,
        baseDelayMs: input.baseDelayMs,
        signal: input.signal,
        async operation(signal) {
          await rm(partial, { force: true });
          const stream = await input.provider.openRead({ objectKey: descriptor.objectKey, signal });
          const meter = new HashMeter();
          await pipeline(stream, meter, createWriteStream(partial, { flags: "wx", mode: 0o600 }), { signal });
          const measured = meter.result();
          if (measured.bytes !== descriptor.bytes || !safeHashEqual(measured.sha256, descriptor.sha256)) {
            throw new BackupV2StorageError(
              "BACKUP_V2_SIMPLIFIED_REMOTE_SHA256_MISMATCH",
              "Downloaded object failed exact byte and SHA-256 verification",
              "integrity",
            );
          }
        },
      });
      await rename(partial, destination);
      output.set(descriptor.objectKey, destination);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }
  return output;
}
