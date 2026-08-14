import "server-only";

import { isIP } from "node:net";
import { Readable } from "node:stream";

import { canonicalJson, sha256Hex } from "./database-artifact-format.ts";
import type { ComponentSource, ComponentSourcePage, ComponentSourceRecord } from "./component-payload.ts";
import { BackupV2FailClosedError } from "./types.ts";

export const AUTH_DURABLE_TABLES = [
  "users", "identities", "mfa_factors", "webauthn_credentials", "oauth_clients", "oauth_consents",
  "sso_providers", "sso_domains", "saml_providers",
] as const;

export const AUTH_TRANSIENT_TABLES = [
  "sessions", "refresh_tokens", "one_time_tokens", "flow_state", "mfa_challenges", "mfa_amr_claims",
  "oauth_authorizations", "oauth_client_states", "webauthn_challenges",
] as const;

const AUTH_TRANSIENT_COLUMNS = new Set([
  "confirmation_token", "recovery_token", "email_change_token_new", "email_change", "reauthentication_token",
  "phone_change_token", "email_change_token_current",
]);

const AUTH_TRANSIENT_NESTED_KEYS = new Set([
  "access_token", "refresh_token", "provider_token", "provider_refresh_token", "client_secret",
  "client_secret_plaintext", "oauth_state", "authorization_code", "code_verifier",
]);

export interface PagedRecordResult<T> {
  records: readonly T[];
  nextCursor: string | null;
  snapshotId: string;
  complete: boolean;
}

export interface AuthSchemaReader {
  listTablePage(table: (typeof AUTH_DURABLE_TABLES)[number], cursor: string | null, signal?: AbortSignal): Promise<PagedRecordResult<Record<string, unknown>>>;
}

export interface StorageMetadataRecord {
  bucket: string;
  key: string | null;
  metadata: Record<string, unknown>;
}

export interface StorageMetadataReader {
  listPage(cursor: string | null, signal?: AbortSignal): Promise<PagedRecordResult<StorageMetadataRecord>>;
}

export interface StorageObjectRecord {
  bucket: string;
  key: string;
  metadata: Record<string, unknown>;
  bytes: bigint;
  sha256: string;
  open: (signal?: AbortSignal) => Readable;
}

export interface StorageObjectReader {
  listPage(cursor: string | null, signal?: AbortSignal): Promise<PagedRecordResult<StorageObjectRecord>>;
}

export interface CloudinaryOriginalRecord {
  publicId: string;
  resourceType: "image" | "video" | "raw";
  type: string;
  version: string;
  format: string | null;
  bytes: bigint;
  sha256: string;
  secureUrl: string;
  metadata: Record<string, unknown>;
}

export interface CloudinaryResourceReader {
  cloudName: string;
  listOriginalsPage(cursor: string | null, signal?: AbortSignal): Promise<PagedRecordResult<CloudinaryOriginalRecord>>;
}

export interface ExternalFetchPolicy {
  fetch: typeof fetch;
  resolve: (hostname: string) => Promise<readonly string[]>;
  maxRedirects?: number;
  maxBytes?: bigint;
}

function fail(code: string, message: string): never { throw new BackupV2FailClosedError(code, message); }

function body(value: unknown): { bytes: bigint; sha256: string; openBody: () => Readable } {
  const encoded = Buffer.from(canonicalJson(value), "utf8");
  return { bytes: BigInt(encoded.byteLength), sha256: sha256Hex(encoded), openBody: () => Readable.from([encoded]) };
}

function string(value: unknown, field: string, max = 1024): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) fail("BACKUP_V2_INVALID_SOURCE_RECORD", `${field} is invalid`);
  return value;
}

function encodeCursor(tableIndex: number, providerCursor: string | null): string {
  return Buffer.from(canonicalJson({ cursor: providerCursor, table: tableIndex }), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): { table: number; cursor: string | null } {
  if (value === null) return { table: 0, cursor: null };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!Number.isSafeInteger(parsed.table) || (parsed.table as number) < 0 || (parsed.table as number) >= AUTH_DURABLE_TABLES.length || (parsed.cursor !== null && typeof parsed.cursor !== "string")) throw new Error("invalid");
    return { table: parsed.table as number, cursor: parsed.cursor as string | null };
  } catch { fail("BACKUP_V2_INVALID_PAGINATION_CURSOR", "Auth cursor is invalid"); }
}

function stripTransientAuthValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTransientAuthValues);
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (!AUTH_TRANSIENT_NESTED_KEYS.has(key.toLowerCase())) {
      output[key] = stripTransientAuthValues((value as Record<string, unknown>)[key]);
    }
  }
  return output;
}

function durableAuthRow(row: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    if (!AUTH_TRANSIENT_COLUMNS.has(key) && !AUTH_TRANSIENT_NESTED_KEYS.has(key.toLowerCase())) {
      output[key] = stripTransientAuthValues(row[key]);
    }
  }
  canonicalJson(output);
  return output;
}

export function createAuthSchemaSource(reader: AuthSchemaReader): ComponentSource {
  let sourceSnapshot: string | null = null;
  return {
    component: "auth",
    async listPage(cursorValue, signal): Promise<ComponentSourcePage> {
      const cursor = decodeCursor(cursorValue); const table = AUTH_DURABLE_TABLES[cursor.table];
      const page = await reader.listTablePage(table, cursor.cursor, signal);
      if (sourceSnapshot === null) sourceSnapshot = page.snapshotId;
      if (sourceSnapshot !== page.snapshotId) fail("BACKUP_V2_SOURCE_DRIFT", "Auth schema snapshot changed across tables");
      const records = page.records.map((raw): ComponentSourceRecord => {
        const row = durableAuthRow(raw); const primary = typeof row.id === "string" ? row.id : sha256Hex(canonicalJson(row));
        const encoded = body(row);
        return { id: `${table}:${string(primary, `auth.${table}.id`)}`, metadata: { table }, bodyBytes: encoded.bytes, bodySha256: encoded.sha256, openBody: encoded.openBody };
      });
      const nextCursor = page.nextCursor !== null
        ? encodeCursor(cursor.table, page.nextCursor)
        : cursor.table + 1 < AUTH_DURABLE_TABLES.length ? encodeCursor(cursor.table + 1, null) : null;
      if (nextCursor === null) sourceSnapshot = null;
      if ((page.nextCursor === null) !== page.complete) fail("BACKUP_V2_PARTIAL_PAGINATION", "Auth table pagination did not prove completion");
      return { records, nextCursor, snapshotId: page.snapshotId, complete: nextCursor === null };
    },
  };
}

function storageId(bucket: string, key: string | null): string {
  return canonicalJson({ bucket: string(bucket, "bucket", 255), key: key === null ? null : string(key, "key", 700) });
}

export function createStorageMetadataSource(reader: StorageMetadataReader): ComponentSource {
  return {
    component: "storage_metadata",
    async listPage(cursor, signal): Promise<ComponentSourcePage> {
      const page = await reader.listPage(cursor, signal);
      return { snapshotId: page.snapshotId, nextCursor: page.nextCursor, complete: page.complete, records: page.records.map((item) => {
        const value = { bucket: string(item.bucket, "bucket", 255), key: item.key === null ? null : string(item.key, "key", 700), metadata: item.metadata };
        const encoded = body(value);
        return { id: storageId(item.bucket, item.key), metadata: { bucket: item.bucket, key: item.key }, bodyBytes: encoded.bytes, bodySha256: encoded.sha256, openBody: encoded.openBody };
      }) };
    },
  };
}

export function createStorageObjectsSource(reader: StorageObjectReader): ComponentSource {
  return {
    component: "storage_objects",
    async listPage(cursor, signal): Promise<ComponentSourcePage> {
      const page = await reader.listPage(cursor, signal);
      return { snapshotId: page.snapshotId, nextCursor: page.nextCursor, complete: page.complete, records: page.records.map((item) => {
        string(item.bucket, "bucket", 255); string(item.key, "key", 700);
        if (typeof item.bytes !== "bigint" || item.bytes < BigInt(0) || !/^[0-9a-f]{64}$/.test(item.sha256) || typeof item.open !== "function") fail("BACKUP_V2_INVALID_SOURCE_RECORD", "Storage object contract is invalid");
        canonicalJson(item.metadata);
        return { id: storageId(item.bucket, item.key), metadata: { bucket: item.bucket, key: item.key, object_metadata: item.metadata }, bodyBytes: item.bytes, bodySha256: item.sha256, openBody: item.open };
      }) };
    },
  };
}

function ipv4Private(address: string): boolean {
  const parts = address.split(".").map(Number); if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && [0, 2, 168].includes(parts[1])) ||
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || parts[1] === 51)) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);
}

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (isIP(normalized) === 4) return ipv4Private(normalized);
  if (isIP(normalized) !== 6) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice(7);
    if (isIP(mapped) === 4) return ipv4Private(mapped);
    const groups = mapped.split(":");
    if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
      const high = Number.parseInt(groups[0], 16); const low = Number.parseInt(groups[1], 16);
      return ipv4Private(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
  }
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") ||
    normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") ||
    normalized.startsWith("ff") || normalized.startsWith("2001:db8:");
}

async function permittedCloudinaryUrl(value: string, cloudName: string, resolve: ExternalFetchPolicy["resolve"]): Promise<URL> {
  let url: URL; try { url = new URL(value); } catch { fail("BACKUP_V2_EXTERNAL_URL_DENIED", "External asset URL is invalid"); }
  const expectedHost = "res.cloudinary.com";
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname.toLowerCase() !== expectedHost || !url.pathname.startsWith(`/${encodeURIComponent(cloudName)}/`)) fail("BACKUP_V2_EXTERNAL_URL_DENIED", "External asset URL is outside the configured Cloudinary origin");
  const addresses = await resolve(url.hostname); if (addresses.length === 0 || addresses.some(privateAddress)) fail("BACKUP_V2_EXTERNAL_ADDRESS_DENIED", "Cloudinary hostname resolved to a disallowed address");
  return url;
}

function externalBody(item: CloudinaryOriginalRecord, reader: CloudinaryResourceReader, policy: ExternalFetchPolicy): (signal?: AbortSignal) => Readable {
  return (signal) => Readable.from((async function* () {
    let current = item.secureUrl; const redirects = policy.maxRedirects ?? 3; const maximum = policy.maxBytes ?? BigInt("5368709120");
    if (!Number.isSafeInteger(redirects) || redirects < 0 || redirects > 10 || typeof maximum !== "bigint" || maximum < item.bytes) fail("BACKUP_V2_INVALID_RESOURCE_LIMIT", "External fetch limits are invalid");
    for (let hop = 0; hop <= redirects; hop += 1) {
      const url = await permittedCloudinaryUrl(current, reader.cloudName, policy.resolve);
      const response = await policy.fetch(url, { redirect: "manual", headers: { accept: "application/octet-stream" }, signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location"); if (!location || hop === redirects) fail("BACKUP_V2_EXTERNAL_REDIRECT_DENIED", "External redirect chain is invalid");
        current = new URL(location, url).toString(); continue;
      }
      if (!response.ok || response.body === null) fail("BACKUP_V2_EXTERNAL_FETCH_FAILED", `Cloudinary original returned HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? null;
      if (contentType === "text/html" || (item.resourceType === "image" && contentType !== null && !contentType.startsWith("image/")) ||
          (item.resourceType === "video" && contentType !== null && !contentType.startsWith("video/") && !contentType.startsWith("audio/"))) {
        fail("BACKUP_V2_EXTERNAL_CONTENT_TYPE_MISMATCH", "Cloudinary original content type is inconsistent");
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && (!/^(0|[1-9][0-9]*)$/.test(contentLength) || BigInt(contentLength) !== item.bytes)) fail("BACKUP_V2_SOURCE_OBJECT_CHANGED", "Cloudinary content length changed");
      let bytes = BigInt(0);
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { if (signal?.aborted) fail("BACKUP_V2_EXPORT_CANCELLED", "External asset fetch was cancelled"); const value = Buffer.from(chunk); bytes += BigInt(value.byteLength); if (bytes > maximum) fail("BACKUP_V2_SOURCE_LIMIT_EXCEEDED", "External asset exceeded byte limit"); yield value; }
      return;
    }
  })());
}

export function createCloudinaryOriginalsSource(reader: CloudinaryResourceReader, policy: ExternalFetchPolicy): ComponentSource {
  string(reader.cloudName, "cloudinary.cloud_name", 255);
  return {
    component: "external_assets",
    async listPage(cursor, signal): Promise<ComponentSourcePage> {
      const page = await reader.listOriginalsPage(cursor, signal);
      return { snapshotId: page.snapshotId, nextCursor: page.nextCursor, complete: page.complete, records: page.records.map((item) => {
        if (!["image", "video", "raw"].includes(item.resourceType) || typeof item.bytes !== "bigint" || item.bytes < BigInt(0) || !/^[0-9a-f]{64}$/.test(item.sha256)) fail("BACKUP_V2_INVALID_SOURCE_RECORD", "Cloudinary original contract is invalid");
        const publicId = string(item.publicId, "cloudinary.public_id", 700); const type = string(item.type, "cloudinary.type", 100); const version = string(item.version, "cloudinary.version", 100);
        const id = canonicalJson({ public_id: publicId, resource_type: item.resourceType, type, version });
        return { id, metadata: { ...item.metadata, format: item.format, public_id: publicId, resource_type: item.resourceType, type, version }, bodyBytes: item.bytes, bodySha256: item.sha256, openBody: externalBody(item, reader, policy) };
      }) };
    },
  };
}
