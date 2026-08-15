import "server-only";

import type { Readable } from "node:stream";

import { BackupV2FailClosedError, type BackupV2Scope } from "./types.ts";

export const BACKUP_V2_STORAGE_CONTRACT_VERSION = "backup-v2-storage-v1" as const;
export const BACKUP_V2_STORAGE_PROVIDER_TYPES = ["disposable_filesystem"] as const;
export type BackupV2StorageProviderType = (typeof BACKUP_V2_STORAGE_PROVIDER_TYPES)[number];

export interface BackupV2StorageCapabilities {
  streamingWrite: true;
  streamingRead: true;
  stat: true;
  conditionalCreate: true;
  readAfterWrite: true;
  atomicFinalize: boolean;
  immutableVersion: boolean;
  serverChecksum: boolean;
}

export interface BackupV2StorageDescriptor {
  contractVersion: typeof BACKUP_V2_STORAGE_CONTRACT_VERSION;
  providerType: BackupV2StorageProviderType;
  providerInstanceId: string;
  namespaceId: string;
  failureDomain: string | null;
  capabilities: BackupV2StorageCapabilities;
}

export interface BackupV2StoredObjectStat {
  objectKey: string;
  sizeBytes: bigint;
  physicalObjectIdentity: string;
  opaqueVersionId: string | null;
  opaqueEtag: string | null;
  providerChecksum: { algorithm: string; value: string } | null;
}

export interface BackupV2StorageWriteResult {
  disposition: "created" | "already_exists";
  objectKey: string;
}

export interface BackupV2StorageProvider {
  readonly descriptor: BackupV2StorageDescriptor;
  write(input: {
    objectKey: string;
    source: Readable;
    expectedSizeBytes: bigint;
    signal: AbortSignal;
  }): Promise<BackupV2StorageWriteResult>;
  stat(input: { objectKey: string; signal: AbortSignal }): Promise<BackupV2StoredObjectStat | null>;
  openRead(input: { objectKey: string; signal: AbortSignal }): Promise<Readable>;
}

export type BackupV2StorageErrorKind =
  | "cancelled"
  | "configuration"
  | "conflict"
  | "integrity"
  | "not_found"
  | "path_violation"
  | "rate_limited"
  | "timeout"
  | "unavailable";

export class BackupV2StorageError extends BackupV2FailClosedError {
  readonly kind: BackupV2StorageErrorKind;
  readonly retryable: boolean;

  constructor(code: string, message: string, kind: BackupV2StorageErrorKind, retryable = false) {
    super(code, message);
    this.name = "BackupV2StorageError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const SAFE_OPAQUE = /^[A-Za-z0-9._:@+-]{1,200}$/;
const GENERATION = /^backup-v2-generation:([0-9a-f]{64})$/;
const ARTIFACT = /^(database|auth|storage_metadata|storage_objects|external_assets)-[0-9a-f]{64}$/;
const registeredProviders = new WeakSet<object>();

function fail(code: string, message: string, kind: BackupV2StorageErrorKind = "configuration"): never {
  throw new BackupV2StorageError(code, message, kind);
}

export function requireStorageIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    fail("BACKUP_V2_INVALID_STORAGE_IDENTITY", `${field} is not a canonical storage identity`);
  }
  return value;
}

export function requireOpaqueProviderValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_OPAQUE.test(value)) {
    fail("BACKUP_V2_INVALID_PROVIDER_METADATA", `${field} is not safe opaque provider metadata`);
  }
  return value;
}

export function canonicalBackupV2ObjectKey(input: {
  generationKey: string;
  component: BackupV2Scope;
  artifactId: string;
}): string {
  const generation = GENERATION.exec(input.generationKey);
  const artifact = ARTIFACT.exec(input.artifactId);
  if (!generation || !artifact || artifact[1] !== input.component) {
    fail("BACKUP_V2_INVALID_STORAGE_OBJECT_KEY", "Artifact identity cannot form a canonical storage key");
  }
  return `backup-v2/${generation[1]}/${input.component}/${input.artifactId}.czb2`;
}

export function assertCanonicalBackupV2ObjectKey(value: unknown): string {
  if (typeof value !== "string" || value.length > 320 || value.includes("\\") || value.includes("\0") ||
      value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.startsWith("//")) {
    fail("BACKUP_V2_STORAGE_PATH_VIOLATION", "Storage object key is unsafe", "path_violation");
  }
  const parts = value.split("/");
  if (parts.length !== 4 || parts[0] !== "backup-v2" || !/^[0-9a-f]{64}$/.test(parts[1]) ||
      !["database", "auth", "storage_metadata", "storage_objects", "external_assets"].includes(parts[2]) ||
      !ARTIFACT.test(parts[3].replace(/\.czb2$/, "")) || parts.some((part) => part === "." || part === "..") ||
      value !== `backup-v2/${parts[1]}/${parts[2]}/${parts[3].replace(/\.czb2$/, "")}.czb2`) {
    fail("BACKUP_V2_STORAGE_PATH_VIOLATION", "Storage object key is not canonical", "path_violation");
  }
  return value;
}

export function registerBackupV2StorageProvider<T extends BackupV2StorageProvider>(provider: T): T {
  assertStorageProviderDescriptor(provider.descriptor);
  if (typeof provider.write !== "function" || typeof provider.stat !== "function" ||
      typeof provider.openRead !== "function") {
    fail("BACKUP_V2_UNSUPPORTED_STORAGE_PROVIDER", "Storage provider operations are incomplete");
  }
  Object.freeze(provider.descriptor.capabilities);
  Object.freeze(provider.descriptor);
  Object.freeze(provider);
  registeredProviders.add(provider);
  return provider;
}

export function assertRegisteredBackupV2StorageProvider(value: BackupV2StorageProvider): void {
  if (!value || typeof value !== "object" || !registeredProviders.has(value)) {
    fail("BACKUP_V2_UNKNOWN_STORAGE_PROVIDER", "Storage provider is not an explicitly registered adapter");
  }
  assertStorageProviderDescriptor(value.descriptor);
}

export function assertStorageProviderDescriptor(value: BackupV2StorageDescriptor): void {
  if (!value || value.contractVersion !== BACKUP_V2_STORAGE_CONTRACT_VERSION ||
      !BACKUP_V2_STORAGE_PROVIDER_TYPES.includes(value.providerType) ||
      !value.capabilities || value.capabilities.streamingWrite !== true ||
      value.capabilities.streamingRead !== true || value.capabilities.stat !== true ||
      value.capabilities.conditionalCreate !== true || value.capabilities.readAfterWrite !== true) {
    fail("BACKUP_V2_UNSUPPORTED_STORAGE_PROVIDER", "Storage provider lacks a required capability");
  }
  requireStorageIdentity(value.providerInstanceId, "providerInstanceId");
  requireStorageIdentity(value.namespaceId, "namespaceId");
  if (value.failureDomain !== null) requireStorageIdentity(value.failureDomain, "failureDomain");
}

export function providerNeutralObjectRef(descriptor: BackupV2StorageDescriptor, objectKey: string): string {
  assertStorageProviderDescriptor(descriptor);
  const key = assertCanonicalBackupV2ObjectKey(objectKey);
  return `${BACKUP_V2_STORAGE_CONTRACT_VERSION}:${descriptor.providerType}:${descriptor.providerInstanceId}:${descriptor.namespaceId}:${Buffer.from(key, "utf8").toString("base64url")}`;
}

export function sanitizeStorageError(error: unknown, fallbackCode = "BACKUP_V2_PROVIDER_OPERATION_FAILED"): BackupV2StorageError {
  if (error instanceof BackupV2StorageError) {
    const messages: Record<BackupV2StorageErrorKind, string> = {
      cancelled: "Storage operation was cancelled",
      configuration: "Storage provider configuration was rejected",
      conflict: "Immutable storage object conflicts with canonical identity",
      integrity: "Stored object failed integrity verification",
      not_found: "Stored object was not found",
      path_violation: "Storage path was denied",
      rate_limited: "Storage provider rate limited the operation",
      timeout: "Storage provider operation timed out",
      unavailable: "Storage provider is unavailable",
    };
    return new BackupV2StorageError(error.code, messages[error.kind], error.kind, error.retryable);
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new BackupV2StorageError("BACKUP_V2_STORAGE_CANCELLED", "Storage operation was cancelled", "cancelled");
  }
  return new BackupV2StorageError(fallbackCode, "Storage provider operation failed", "unavailable", true);
}
