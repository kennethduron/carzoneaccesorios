import "server-only";

import { Readable } from "node:stream";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

import type { BackblazeB2RuntimeConfig } from "./b2-config.ts";
import { BackupV2StorageError } from "./storage-contract.ts";

export interface B2HeadObjectResult {
  readonly found: boolean;
  readonly sizeBytes: bigint | null;
  readonly etag: string | null;
  readonly versionId: string | null;
}

export interface B2UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface B2ListObject {
  readonly key: string;
  readonly sizeBytes: bigint;
}

export interface B2ListObjectsResult {
  readonly objects: readonly B2ListObject[];
  readonly nextContinuationToken: string | null;
}

export interface BackblazeB2S3Transport {
  readonly executionClass: "synthetic" | "real";
  headObject(input: { bucket: string; key: string; signal: AbortSignal }): Promise<B2HeadObjectResult>;
  putObject(input: {
    bucket: string;
    key: string;
    body: Readable;
    contentLength: bigint;
    contentType: "application/octet-stream";
    metadata: Readonly<Record<string, string>>;
    ifNoneMatch: "*";
    signal: AbortSignal;
  }): Promise<void>;
  createMultipartUpload(input: {
    bucket: string;
    key: string;
    contentType: "application/octet-stream";
    metadata: Readonly<Record<string, string>>;
    signal: AbortSignal;
  }): Promise<{ uploadId: string }>;
  uploadPart(input: {
    bucket: string;
    key: string;
    uploadId: string;
    partNumber: number;
    body: Uint8Array;
    signal: AbortSignal;
  }): Promise<B2UploadedPart>;
  completeMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
    parts: readonly B2UploadedPart[];
    ifNoneMatch: "*";
    signal: AbortSignal;
  }): Promise<void>;
  abortMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
    signal: AbortSignal;
  }): Promise<void>;
  getObject(input: { bucket: string; key: string; signal: AbortSignal }): Promise<Readable>;
  listObjectsV2(input: {
    bucket: string;
    prefix: string;
    continuationToken: string | null;
    maxKeys: number;
    signal: AbortSignal;
  }): Promise<B2ListObjectsResult>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function providerName(error: unknown): string | null {
  const value = record(error)?.name;
  return typeof value === "string" ? value : null;
}

function providerStatus(error: unknown): number | null {
  const metadata = record(record(error)?.$metadata);
  return typeof metadata?.httpStatusCode === "number" ? metadata.httpStatusCode : null;
}

function objectNotFound(error: unknown): boolean {
  return providerStatus(error) === 404 || ["NotFound", "NoSuchKey"].includes(providerName(error) ?? "");
}

function safeBytes(value: unknown, field: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BackupV2StorageError(
      "BACKUP_V2_B2_RESPONSE_INVALID",
      `${field} was invalid`,
      "integrity",
    );
  }
  return BigInt(value);
}

function normalizeBody(value: unknown): Readable {
  if (value instanceof Readable) return value;
  if (value instanceof Uint8Array) return Readable.from([value]);
  if (value && typeof value === "object" && typeof (value as { getReader?: unknown }).getReader === "function") {
    return Readable.fromWeb(value as never);
  }
  throw new BackupV2StorageError(
    "BACKUP_V2_B2_BODY_UNSUPPORTED",
    "B2 returned an unsupported streaming body",
    "integrity",
  );
}

export function createAwsSdkBackblazeB2Transport(config: BackblazeB2RuntimeConfig): BackblazeB2S3Transport {
  // Client creation is intentionally lazy: callers must explicitly select an operator action first.
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.applicationKey },
  });
  return Object.freeze({
    executionClass: "real",
    async headObject({ bucket, key, signal }): Promise<B2HeadObjectResult> {
      try {
        const output = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
        return {
          found: true,
          sizeBytes: safeBytes(output.ContentLength, "ContentLength"),
          etag: output.ETag ?? null,
          versionId: output.VersionId ?? null,
        };
      } catch (error) {
        if (objectNotFound(error)) return { found: false, sizeBytes: null, etag: null, versionId: null };
        throw error;
      }
    },

    async putObject(input): Promise<void> {
      await client.send(new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentLength: Number(input.contentLength),
        ContentType: input.contentType,
        Metadata: { ...input.metadata },
        IfNoneMatch: input.ifNoneMatch,
      }), { abortSignal: input.signal });
    },

    async createMultipartUpload(input): Promise<{ uploadId: string }> {
      const output = await client.send(new CreateMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        ContentType: input.contentType,
        Metadata: { ...input.metadata },
      }), { abortSignal: input.signal });
      if (!output.UploadId) {
        throw new BackupV2StorageError(
          "BACKUP_V2_B2_MULTIPART_ID_MISSING",
          "B2 did not return a multipart upload identity",
          "integrity",
        );
      }
      return { uploadId: output.UploadId };
    },

    async uploadPart(input): Promise<B2UploadedPart> {
      const output = await client.send(new UploadPartCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
        Body: input.body,
        ContentLength: input.body.byteLength,
      }), { abortSignal: input.signal });
      if (!output.ETag) {
        throw new BackupV2StorageError(
          "BACKUP_V2_B2_MULTIPART_ETAG_MISSING",
          "B2 did not acknowledge a multipart part",
          "integrity",
        );
      }
      return { partNumber: input.partNumber, etag: output.ETag };
    },

    async completeMultipartUpload(input): Promise<void> {
      await client.send(new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        IfNoneMatch: input.ifNoneMatch,
        MultipartUpload: {
          Parts: input.parts.map((part) => ({ ETag: part.etag, PartNumber: part.partNumber })),
        },
      }), { abortSignal: input.signal });
    },

    async abortMultipartUpload(input): Promise<void> {
      await client.send(new AbortMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
      }), { abortSignal: input.signal });
    },

    async getObject(input): Promise<Readable> {
      const output = await client.send(new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
      }), { abortSignal: input.signal });
      return normalizeBody(output.Body);
    },

    async listObjectsV2(input): Promise<B2ListObjectsResult> {
      const output = await client.send(new ListObjectsV2Command({
        Bucket: input.bucket,
        Prefix: input.prefix,
        ContinuationToken: input.continuationToken ?? undefined,
        MaxKeys: input.maxKeys,
      }), { abortSignal: input.signal });
      const objects = (output.Contents ?? []).map((item) => {
        if (!item.Key) {
          throw new BackupV2StorageError(
            "BACKUP_V2_B2_RESPONSE_INVALID",
            "B2 list response omitted an object key",
            "integrity",
          );
        }
        return Object.freeze({ key: item.Key, sizeBytes: safeBytes(item.Size, "Size") });
      });
      if (output.IsTruncated && !output.NextContinuationToken) {
        throw new BackupV2StorageError(
          "BACKUP_V2_B2_RESPONSE_INVALID",
          "B2 truncated a list response without a continuation token",
          "integrity",
        );
      }
      return {
        objects: Object.freeze(objects),
        nextContinuationToken: output.IsTruncated ? output.NextContinuationToken ?? null : null,
      };
    },
  } satisfies BackblazeB2S3Transport);
}
