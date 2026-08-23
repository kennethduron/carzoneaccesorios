import "server-only";

import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import type { BackblazeB2RuntimeConfig } from "./b2-config.ts";
import type {
  B2HeadObjectResult,
  B2UploadedPart,
  BackblazeB2S3Transport,
} from "./b2-s3-transport.ts";
import {
  BACKUP_V2_STORAGE_CONTRACT_VERSION,
  BackupV2StorageError,
  assertSupportedBackupV2ObjectKey,
  registerBackupV2StorageProvider,
  type BackupV2StorageErrorKind,
  type BackupV2StorageProvider,
  type BackupV2StoredObjectStat,
} from "./storage-contract.ts";

const FIVE_MIB = 5 * 1024 * 1024;
const DEFAULT_MULTIPART_THRESHOLD_BYTES = BigInt(64 * 1024 * 1024);
const DEFAULT_MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MULTIPART_CONCURRENCY = 3;

export interface CreateBackblazeB2StorageProviderInput {
  readonly config: BackblazeB2RuntimeConfig;
  readonly transport: BackblazeB2S3Transport;
  readonly expectedConfigFingerprint?: string;
  readonly multipartThresholdBytes?: bigint;
  readonly multipartPartSizeBytes?: number;
  readonly multipartConcurrency?: number;
  readonly realExecutionAuthorization?: SimplifiedBackupV2RealStorageAuthorization;
}

export interface SimplifiedBackupV2RealStorageAuthorization {
  readonly system: "SIMPLIFIED_BACKUP_V2";
  readonly operatorCommandBound: true;
  readonly representation: "postgres_plain_sql_v1";
}

export function simplifiedBackupV2RealStorageAuthorization(): SimplifiedBackupV2RealStorageAuthorization {
  return Object.freeze({
    system: "SIMPLIFIED_BACKUP_V2",
    operatorCommandBound: true,
    representation: "postgres_plain_sql_v1",
  });
}

interface ProviderErrorShape {
  readonly name: string | null;
  readonly status: number | null;
  readonly code: string | null;
  readonly retryAfterMs: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function retryAfterMs(error: unknown): number | null {
  const response = record(record(error)?.$response);
  const headers = record(response?.headers);
  const raw = stringField(headers?.["retry-after"] ?? headers?.["Retry-After"]);
  if (!raw) return null;
  if (/^[0-9]+$/.test(raw)) return Math.min(Number(raw) * 1_000, 10_000);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed - Date.now(), 0), 10_000) : null;
}

function providerErrorShape(error: unknown): ProviderErrorShape {
  const value = record(error);
  const metadata = record(value?.$metadata);
  return {
    name: stringField(value?.name),
    status: typeof metadata?.httpStatusCode === "number" ? metadata.httpStatusCode : null,
    code: stringField(value?.code),
    retryAfterMs: retryAfterMs(error),
  };
}

function classified(
  code: string,
  message: string,
  kind: BackupV2StorageErrorKind,
  retryable = false,
  retryDelay: number | null = null,
): BackupV2StorageError {
  return new BackupV2StorageError(code, message, kind, retryable, retryDelay);
}

export function classifyBackblazeB2Error(error: unknown, signal?: AbortSignal): BackupV2StorageError {
  if (error instanceof BackupV2StorageError) return error;
  if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
    return classified("BACKUP_V2_STORAGE_CANCELLED", "Storage operation was cancelled", "cancelled");
  }
  const shape = providerErrorShape(error);
  if (shape.status === 412 || shape.name === "PreconditionFailed") {
    return classified(
      "BACKUP_V2_B2_OBJECT_ALREADY_EXISTS",
      "Canonical B2 object already exists",
      "conflict",
    );
  }
  if (shape.name === "NoSuchBucket") {
    return classified(
      "CONFIGURED_B2_BUCKET_NOT_ACCESSIBLE",
      "Configured B2 bucket is not accessible",
      "configuration",
    );
  }
  if (["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"].includes(shape.name ?? "") ||
      [401, 403].includes(shape.status ?? 0)) {
    return classified("BACKUP_V2_B2_AUTHENTICATION_REJECTED", "B2 authentication or permission was rejected", "configuration");
  }
  if (shape.name === "SlowDown" || [429, 503].includes(shape.status ?? 0)) {
    return classified(
      "BACKUP_V2_B2_RATE_LIMITED",
      "B2 temporarily rate limited the operation",
      "rate_limited",
      true,
      shape.retryAfterMs,
    );
  }
  if (["TimeoutError", "RequestTimeout", "ETIMEDOUT"].includes(shape.name ?? "") || shape.code === "ETIMEDOUT") {
    return classified("BACKUP_V2_B2_TIMEOUT", "B2 operation timed out", "timeout", true);
  }
  if (["ECONNRESET", "EPIPE", "ENETRESET", "ECONNREFUSED"].includes(shape.code ?? "") ||
      (shape.status !== null && shape.status >= 500 && shape.status <= 599)) {
    return classified("BACKUP_V2_B2_UNAVAILABLE", "B2 is temporarily unavailable", "unavailable", true);
  }
  return classified("BACKUP_V2_B2_OPERATION_FAILED", "B2 operation failed", "unavailable");
}

function opaqueHash(value: string | null): string | null {
  return value === null ? null : `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function physicalIdentity(config: BackblazeB2RuntimeConfig, objectKey: string, head: B2HeadObjectResult): string {
  const providerVersion = head.versionId ?? head.etag ?? "current-object";
  const digest = createHash("sha256").update([
    config.configFingerprint,
    objectKey,
    providerVersion,
  ].join("\n")).digest("hex");
  return `backup-v2-b2-object-v1:${config.destinationId}:${digest}`;
}

function options(input: CreateBackblazeB2StorageProviderInput): {
  threshold: bigint;
  partSize: number;
  concurrency: number;
} {
  const threshold = input.multipartThresholdBytes ?? DEFAULT_MULTIPART_THRESHOLD_BYTES;
  const partSize = input.multipartPartSizeBytes ?? DEFAULT_MULTIPART_PART_SIZE_BYTES;
  const concurrency = input.multipartConcurrency ?? DEFAULT_MULTIPART_CONCURRENCY;
  if (typeof threshold !== "bigint" || threshold < BigInt(FIVE_MIB) ||
      !Number.isSafeInteger(partSize) || partSize < FIVE_MIB || partSize > 512 * 1024 * 1024 ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw classified("BACKUP_V2_B2_MULTIPART_POLICY_INVALID", "B2 multipart policy is invalid", "configuration");
  }
  return { threshold, partSize, concurrency };
}

async function* boundedParts(
  source: Readable,
  partSize: number,
  expectedSizeBytes: bigint,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let total = BigInt(0);
  let buffer = Buffer.allocUnsafe(partSize);
  let offset = 0;
  for await (const raw of source) {
    if (signal.aborted) throw classified("BACKUP_V2_STORAGE_CANCELLED", "Storage operation was cancelled", "cancelled");
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    let cursor = 0;
    total += BigInt(chunk.byteLength);
    if (total > expectedSizeBytes) {
      throw classified("BACKUP_V2_UPLOAD_SIZE_MISMATCH", "Upload exceeded expected bytes", "integrity");
    }
    while (cursor < chunk.byteLength) {
      const copied = chunk.copy(buffer, offset, cursor, Math.min(chunk.byteLength, cursor + partSize - offset));
      cursor += copied;
      offset += copied;
      if (offset === partSize) {
        yield buffer;
        buffer = Buffer.allocUnsafe(partSize);
        offset = 0;
      }
    }
  }
  if (offset > 0) yield buffer.subarray(0, offset);
  if (total !== expectedSizeBytes) {
    throw classified("BACKUP_V2_UPLOAD_SIZE_MISMATCH", "Upload byte count did not match", "integrity");
  }
}

async function multipartWrite(input: {
  config: BackblazeB2RuntimeConfig;
  transport: BackblazeB2S3Transport;
  objectKey: string;
  source: Readable;
  expectedSizeBytes: bigint;
  signal: AbortSignal;
  partSize: number;
  concurrency: number;
}): Promise<void> {
  let uploadId: string | null = null;
  try {
    uploadId = (await input.transport.createMultipartUpload({
      bucket: input.config.bucket,
      key: input.objectKey,
      contentType: "application/octet-stream",
      metadata: { "backup-v2-config-fingerprint": input.config.configFingerprint },
      signal: input.signal,
    })).uploadId;
    const completedParts: B2UploadedPart[] = [];
    let batch: Promise<B2UploadedPart>[] = [];
    let partNumber = 0;
    for await (const body of boundedParts(input.source, input.partSize, input.expectedSizeBytes, input.signal)) {
      partNumber += 1;
      if (partNumber > 10_000) {
        throw classified("BACKUP_V2_B2_MULTIPART_LIMIT_EXCEEDED", "B2 multipart part limit was exceeded", "configuration");
      }
      batch.push(input.transport.uploadPart({
        bucket: input.config.bucket,
        key: input.objectKey,
        uploadId,
        partNumber,
        body,
        signal: input.signal,
      }));
      if (batch.length === input.concurrency) {
        completedParts.push(...await Promise.all(batch));
        batch = [];
      }
    }
    if (batch.length > 0) completedParts.push(...await Promise.all(batch));
    if (completedParts.length === 0) {
      throw classified("BACKUP_V2_B2_MULTIPART_EMPTY", "B2 multipart upload had no parts", "integrity");
    }
    completedParts.sort((left, right) => left.partNumber - right.partNumber);
    await input.transport.completeMultipartUpload({
      bucket: input.config.bucket,
      key: input.objectKey,
      uploadId,
      parts: completedParts,
      signal: input.signal,
    });
    uploadId = null;
  } catch (error) {
    if (uploadId !== null) {
      try {
        await input.transport.abortMultipartUpload({
          bucket: input.config.bucket,
          key: input.objectKey,
          uploadId,
          signal: AbortSignal.timeout(5_000),
        });
      } catch { /* Best-effort cleanup must not hide the original fail-closed result. */ }
    }
    throw error;
  }
}

function statFromHead(
  config: BackblazeB2RuntimeConfig,
  objectKey: string,
  head: B2HeadObjectResult,
): BackupV2StoredObjectStat | null {
  if (!head.found) return null;
  if (head.sizeBytes === null || head.sizeBytes < BigInt(0)) {
    throw classified("BACKUP_V2_B2_RESPONSE_INVALID", "B2 object size was invalid", "integrity");
  }
  return {
    objectKey,
    sizeBytes: head.sizeBytes,
    physicalObjectIdentity: physicalIdentity(config, objectKey, head),
    opaqueVersionId: opaqueHash(head.versionId),
    opaqueEtag: opaqueHash(head.etag),
    providerChecksum: null,
  };
}

function assertAuthorizedTransport(input: CreateBackblazeB2StorageProviderInput): void {
  const authorization = input.realExecutionAuthorization;
  const simplified = authorization?.system === "SIMPLIFIED_BACKUP_V2" &&
    authorization.operatorCommandBound === true &&
    authorization.representation === "postgres_plain_sql_v1";
  if (input.transport.executionClass !== "synthetic" && !simplified) {
    throw classified(
      "REAL_BACKUP_V2_EXECUTION_BLOCKED_UNTIL_PHASE_4B6",
      "Real Backup V2 provider operations are blocked until Phase 4B.6",
      "configuration",
    );
  }
}

export function createBackblazeB2ArtifactStorageProvider(
  input: CreateBackblazeB2StorageProviderInput,
): BackupV2StorageProvider {
  const config = input.config;
  if (input.expectedConfigFingerprint !== undefined && input.expectedConfigFingerprint !== config.configFingerprint) {
    throw classified("BACKUP_V2_B2_DESTINATION_DRIFT", "B2 destination changed after planning", "configuration");
  }
  const multipart = options(input);
  const transport = input.transport;
  const provider: BackupV2StorageProvider = {
    descriptor: {
      contractVersion: BACKUP_V2_STORAGE_CONTRACT_VERSION,
      providerType: "backblaze_b2",
      providerInstanceId: config.destinationId,
      namespaceId: `b2-${config.configFingerprint.slice(0, 40)}`,
      failureDomain: config.failureDomainId,
      allowedCopyRoles: ["primary"],
      capabilities: {
        streamingWrite: true,
        streamingRead: true,
        stat: true,
        conditionalCreate: true,
        readAfterWrite: true,
        atomicFinalize: true,
        immutableVersion: false,
        serverChecksum: false,
      },
    },

    async write({ objectKey: rawObjectKey, source, expectedSizeBytes, signal }) {
      assertAuthorizedTransport(input);
      const objectKey = assertSupportedBackupV2ObjectKey(rawObjectKey);
      if (expectedSizeBytes < BigInt(0) || expectedSizeBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw classified("BACKUP_V2_B2_CONTENT_LENGTH_INVALID", "B2 content length is outside the supported exact range", "configuration");
      }
      try {
        const existing = await transport.headObject({ bucket: config.bucket, key: objectKey, signal });
        if (existing.found) return { disposition: "already_exists", objectKey };
        if (expectedSizeBytes < multipart.threshold) {
          await transport.putObject({
            bucket: config.bucket,
            key: objectKey,
            body: source,
            contentLength: expectedSizeBytes,
            contentType: "application/octet-stream",
            metadata: { "backup-v2-config-fingerprint": config.configFingerprint },
            signal,
          });
        } else {
          await multipartWrite({
            config,
            transport,
            objectKey,
            source,
            expectedSizeBytes,
            signal,
            partSize: multipart.partSize,
            concurrency: multipart.concurrency,
          });
        }
        return { disposition: "created", objectKey };
      } catch (error) {
        const value = classifyBackblazeB2Error(error, signal);
        if (value.code === "BACKUP_V2_B2_OBJECT_ALREADY_EXISTS") {
          return { disposition: "already_exists", objectKey };
        }
        throw value;
      }
    },

    async stat({ objectKey: rawObjectKey, signal }) {
      assertAuthorizedTransport(input);
      const objectKey = assertSupportedBackupV2ObjectKey(rawObjectKey);
      try {
        return statFromHead(
          config,
          objectKey,
          await transport.headObject({ bucket: config.bucket, key: objectKey, signal }),
        );
      } catch (error) {
        throw classifyBackblazeB2Error(error, signal);
      }
    },

    async openRead({ objectKey: rawObjectKey, signal }) {
      assertAuthorizedTransport(input);
      const objectKey = assertSupportedBackupV2ObjectKey(rawObjectKey);
      try {
        return await transport.getObject({ bucket: config.bucket, key: objectKey, signal });
      } catch (error) {
        throw classifyBackblazeB2Error(error, signal);
      }
    },
  };
  return registerBackupV2StorageProvider(provider);
}
