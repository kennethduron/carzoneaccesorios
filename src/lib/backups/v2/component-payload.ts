import "server-only";

import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";

import { canonicalJson, sha256Hex } from "./database-artifact-format.ts";
import {
  COMPONENT_PAYLOAD_MAGIC,
  COMPONENT_PAYLOAD_VERSION,
  type BackupV2ComponentScope,
} from "./component-artifact-format.ts";
import { BackupV2FailClosedError } from "./types.ts";

const SAFE_ID = /^[\u0020-\u007e\u0080-\uffff]{1,1024}$/u;
const HASH = /^[0-9a-f]{64}$/;

export interface ComponentSourceRecord {
  id: string;
  metadata: Record<string, unknown>;
  bodyBytes: bigint;
  bodySha256: string;
  openBody: (signal?: AbortSignal) => Readable;
}

export interface ComponentSourcePage {
  records: readonly ComponentSourceRecord[];
  nextCursor: string | null;
  snapshotId: string;
  complete: boolean;
}

export interface ComponentSource {
  component: BackupV2ComponentScope;
  listPage(cursor: string | null, signal?: AbortSignal): Promise<ComponentSourcePage>;
}

export interface ComponentInventory {
  component: BackupV2ComponentScope;
  snapshotId: string;
  fingerprint: string;
  records: readonly ComponentSourceRecord[];
  recordCount: bigint;
  bodyBytes: bigint;
}

export interface ComponentPayloadSummary {
  component: BackupV2ComponentScope;
  snapshotId: string;
  inventoryFingerprint: string;
  bindingFingerprint: string | null;
  recordCount: bigint;
  bodyBytes: bigint;
}

export interface InventoryLimits {
  maxPages?: number;
  maxRecords?: number;
  maxBodyBytes?: bigint;
  maxRetries?: number;
}

const DEFAULT_MAX_PAGES = 100_000;
const DEFAULT_MAX_RECORDS = 10_000_000;
const DEFAULT_MAX_BODY_BYTES = BigInt("1099511627776");

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const b = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function validateRecord(value: ComponentSourceRecord): void {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !SAFE_ID.test(value.id) || value.id.includes("\0")) {
    fail("BACKUP_V2_INVALID_SOURCE_RECORD", "Source record ID is invalid");
  }
  if (typeof value.metadata !== "object" || value.metadata === null || Array.isArray(value.metadata)) fail("BACKUP_V2_INVALID_SOURCE_RECORD", "Record metadata must be an object");
  canonicalJson(value.metadata);
  if (typeof value.bodyBytes !== "bigint" || value.bodyBytes < BigInt(0)) fail("BACKUP_V2_INVALID_SOURCE_RECORD", "Record byte count is invalid");
  if (!HASH.test(value.bodySha256) || typeof value.openBody !== "function") fail("BACKUP_V2_INVALID_SOURCE_RECORD", "Record body contract is invalid");
}

async function withRetry<T>(operation: () => Promise<T>, retries: number, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) fail("BACKUP_V2_EXPORT_CANCELLED", "Component inventory was cancelled");
    try { return await operation(); } catch (error) {
      if (error instanceof BackupV2FailClosedError) throw error;
      void error;
    }
  }
  throw new BackupV2FailClosedError("BACKUP_V2_SOURCE_RETRY_EXHAUSTED", "Component source failed after bounded retries");
}

function inventoryCanonical(component: BackupV2ComponentScope, snapshotId: string, records: readonly ComponentSourceRecord[]): string {
  return canonicalJson({
    component,
    format_version: COMPONENT_PAYLOAD_VERSION,
    records: records.map(({ id, metadata, bodyBytes, bodySha256 }) => ({
      body_bytes: bodyBytes.toString(), body_sha256: bodySha256, id, metadata,
    })),
    snapshot_id: snapshotId,
  });
}

export async function collectComponentInventory(
  source: ComponentSource,
  limits: InventoryLimits = {},
  signal?: AbortSignal,
): Promise<ComponentInventory> {
  const maxPages = limits.maxPages ?? DEFAULT_MAX_PAGES;
  const maxRecords = limits.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxBodyBytes = limits.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const retries = limits.maxRetries ?? 2;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || !Number.isSafeInteger(maxRecords) || maxRecords < 0 || typeof maxBodyBytes !== "bigint" || maxBodyBytes < BigInt(0) || !Number.isSafeInteger(retries) || retries < 0 || retries > 10) fail("BACKUP_V2_INVALID_RESOURCE_LIMIT", "Invalid component inventory limits");
  const records: ComponentSourceRecord[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let snapshotId: string | null = null;
  let bodyBytes = BigInt(0);
  for (let pageNumber = 0; ; pageNumber += 1) {
    if (pageNumber >= maxPages) fail("BACKUP_V2_PAGINATION_LIMIT_EXCEEDED", "Component inventory exceeded page limit");
    const page = await withRetry(() => source.listPage(cursor, signal), retries, signal);
    if (!page || !Array.isArray(page.records) || typeof page.snapshotId !== "string" || page.snapshotId.length === 0 || page.snapshotId.length > 200 || typeof page.complete !== "boolean") fail("BACKUP_V2_INVALID_SOURCE_PAGE", "Component source returned an invalid page");
    if (snapshotId === null) snapshotId = page.snapshotId;
    if (snapshotId !== page.snapshotId) fail("BACKUP_V2_SOURCE_DRIFT", "Source snapshot changed during pagination");
    for (const item of page.records) {
      validateRecord(item);
      if (ids.has(item.id)) fail("BACKUP_V2_DUPLICATE_SOURCE_RECORD", "Duplicate source record ID");
      ids.add(item.id); records.push(item); bodyBytes += item.bodyBytes;
      if (records.length > maxRecords || bodyBytes > maxBodyBytes) fail("BACKUP_V2_SOURCE_LIMIT_EXCEEDED", "Component inventory exceeded resource limits");
    }
    if (page.nextCursor === null) {
      if (!page.complete) fail("BACKUP_V2_PARTIAL_PAGINATION", "Component source ended before confirming complete pagination");
      break;
    }
    if (page.complete) fail("BACKUP_V2_INVALID_SOURCE_PAGE", "Complete source page cannot declare a continuation cursor");
    if (typeof page.nextCursor !== "string" || page.nextCursor.length === 0 || page.nextCursor.length > 500 || cursors.has(page.nextCursor)) fail("BACKUP_V2_INVALID_PAGINATION_CURSOR", "Component pagination cursor is invalid or repeated");
    cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  const sorted = records.sort((left, right) => compareCodePoints(left.id, right.id));
  const resolvedSnapshot = snapshotId ?? fail("BACKUP_V2_EMPTY_PAGINATION", "Source returned no inventory page");
  return {
    component: source.component,
    snapshotId: resolvedSnapshot,
    fingerprint: sha256Hex(inventoryCanonical(source.component, resolvedSnapshot, sorted)),
    records: sorted,
    recordCount: BigInt(sorted.length),
    bodyBytes,
  };
}

async function* payloadChunks(
  source: ComponentSource,
  before: ComponentInventory,
  bindingFingerprint: string | null,
  limits: InventoryLimits,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  yield Buffer.from(`${COMPONENT_PAYLOAD_MAGIC}\n`, "utf8");
  yield Buffer.from(`${canonicalJson({
    binding_fingerprint: bindingFingerprint,
    component: before.component,
    format_version: COMPONENT_PAYLOAD_VERSION,
    inventory_fingerprint: before.fingerprint,
    record_count: before.recordCount.toString(),
    snapshot_id: before.snapshotId,
  })}\n`, "utf8");
  for (const item of before.records) {
    if (signal?.aborted) fail("BACKUP_V2_EXPORT_CANCELLED", "Component export was cancelled");
    yield Buffer.from(`${canonicalJson({ body_bytes: item.bodyBytes.toString(), body_sha256: item.bodySha256, id: item.id, metadata: item.metadata })}\n`, "utf8");
    const meter = createHash("sha256");
    let bytes = BigInt(0);
    const body = item.openBody(signal);
    if (!(body instanceof Readable)) fail("BACKUP_V2_INVALID_SOURCE_RECORD", "Body factory did not return a readable stream");
    for await (const chunk of body) {
      if (signal?.aborted) fail("BACKUP_V2_EXPORT_CANCELLED", "Component body export was cancelled");
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += BigInt(value.byteLength);
      if (bytes > item.bodyBytes) fail("BACKUP_V2_SOURCE_OBJECT_CHANGED", "Source body exceeded its inventory byte count");
      meter.update(value); yield value;
    }
    if (bytes !== item.bodyBytes || meter.digest("hex") !== item.bodySha256) fail("BACKUP_V2_SOURCE_OBJECT_CHANGED", "Source body bytes or hash changed during export");
    yield Buffer.from("\n", "ascii");
  }
  const after = await collectComponentInventory(source, limits, signal);
  if (after.snapshotId !== before.snapshotId || after.fingerprint !== before.fingerprint) fail("BACKUP_V2_SOURCE_DRIFT", "Component inventory changed before finalization");
  yield Buffer.from(`${canonicalJson({
    binding_fingerprint: bindingFingerprint,
    component: before.component,
    inventory_after: after.fingerprint,
    inventory_before: before.fingerprint,
    record_count: before.recordCount.toString(),
    snapshot_after: after.snapshotId,
    snapshot_before: before.snapshotId,
    trailer: "authenticated-final",
  })}\n`, "utf8");
}

export function createComponentPayloadStream(
  source: ComponentSource,
  before: ComponentInventory,
  bindingFingerprint: string | null,
  limits: InventoryLimits = {},
  signal?: AbortSignal,
): Readable {
  return Readable.from(payloadChunks(source, before, bindingFingerprint, limits, signal));
}

interface ParsedHeader { id: string; metadata: Record<string, unknown>; body_bytes: string; body_sha256: string }

export class ComponentPayloadVerifier extends Writable {
  readonly #expected: ComponentPayloadSummary;
  #buffer = Buffer.alloc(0);
  #state: "magic" | "header" | "record_or_trailer" | "body" | "body_newline" | "done" = "magic";
  #current: ParsedHeader | null = null;
  #remaining = BigInt(0);
  #bodyHash = createHash("sha256");
  #records = BigInt(0);
  #bodyBytes = BigInt(0);
  readonly #ids = new Set<string>();

  constructor(expected: ComponentPayloadSummary) { super(); this.#expected = expected; }

  #line(): Buffer | null {
    const newline = this.#buffer.indexOf(10);
    if (newline < 0) return null;
    const line = this.#buffer.subarray(0, newline); this.#buffer = this.#buffer.subarray(newline + 1); return line;
  }

  #json(line: Buffer): Record<string, unknown> {
    if (line.length > 1_048_576) fail("BACKUP_V2_PAYLOAD_HEADER_LIMIT", "Payload header exceeded limit");
    let parsed: unknown; try { parsed = JSON.parse(line.toString("utf8")); } catch { fail("BACKUP_V2_INVALID_COMPONENT_PAYLOAD", "Payload line is not JSON"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || canonicalJson(parsed) !== line.toString("utf8")) fail("BACKUP_V2_NON_CANONICAL_PAYLOAD", "Payload JSON is not canonical");
    return parsed as Record<string, unknown>;
  }

  #consume(): void {
    while (true) {
      if (this.#state === "done") {
        if (this.#buffer.length > 0) fail("BACKUP_V2_TRAILING_COMPONENT_PAYLOAD", "Component payload contains trailing bytes");
        return;
      }
      if (this.#state === "body") {
        if (this.#remaining === BigInt(0)) { this.#state = "body_newline"; continue; }
        if (this.#buffer.length === 0) return;
        const take = Number(this.#remaining < BigInt(this.#buffer.length) ? this.#remaining : BigInt(this.#buffer.length));
        const chunk = this.#buffer.subarray(0, take); this.#buffer = this.#buffer.subarray(take);
        this.#bodyHash.update(chunk); this.#remaining -= BigInt(take); this.#bodyBytes += BigInt(take); continue;
      }
      if (this.#state === "body_newline") {
        if (this.#buffer.length === 0) return;
        if (this.#buffer[0] !== 10 || this.#current === null || this.#bodyHash.digest("hex") !== this.#current.body_sha256) fail("BACKUP_V2_COMPONENT_RECORD_INTEGRITY_FAILED", "Record boundary or hash is invalid");
        this.#buffer = this.#buffer.subarray(1); this.#current = null; this.#bodyHash = createHash("sha256"); this.#records += BigInt(1); this.#state = "record_or_trailer"; continue;
      }
      const line = this.#line(); if (line === null) return;
      if (this.#state === "magic") { if (line.toString("ascii") !== COMPONENT_PAYLOAD_MAGIC) fail("BACKUP_V2_UNKNOWN_PAYLOAD_FORMAT", "Unknown component payload magic"); this.#state = "header"; continue; }
      const value = this.#json(line);
      if (this.#state === "header") {
        if (value.component !== this.#expected.component || value.format_version !== COMPONENT_PAYLOAD_VERSION || value.snapshot_id !== this.#expected.snapshotId || value.inventory_fingerprint !== this.#expected.inventoryFingerprint || value.binding_fingerprint !== this.#expected.bindingFingerprint || value.record_count !== this.#expected.recordCount.toString()) fail("BACKUP_V2_COMPONENT_PAYLOAD_IDENTITY_MISMATCH", "Payload header does not match manifest");
        this.#state = "record_or_trailer"; continue;
      }
      if (value.trailer === "authenticated-final") {
        if (value.component !== this.#expected.component || value.snapshot_before !== this.#expected.snapshotId || value.snapshot_after !== this.#expected.snapshotId || value.inventory_before !== this.#expected.inventoryFingerprint || value.inventory_after !== this.#expected.inventoryFingerprint || value.binding_fingerprint !== this.#expected.bindingFingerprint || value.record_count !== this.#expected.recordCount.toString()) fail("BACKUP_V2_SOURCE_DRIFT", "Authenticated payload trailer is inconsistent");
        this.#state = "done"; continue;
      }
      const header = value as unknown as ParsedHeader;
      if (typeof header.id !== "string" || !SAFE_ID.test(header.id) || this.#ids.has(header.id) || typeof header.metadata !== "object" || header.metadata === null || Array.isArray(header.metadata) || typeof header.body_bytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(header.body_bytes) || typeof header.body_sha256 !== "string" || !HASH.test(header.body_sha256)) fail("BACKUP_V2_INVALID_COMPONENT_RECORD", "Payload record header is invalid or duplicate");
      this.#ids.add(header.id); this.#current = header; this.#remaining = BigInt(header.body_bytes); this.#state = "body";
    }
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try { this.#buffer = Buffer.concat([this.#buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)]); this.#consume(); callback(); } catch (error) { callback(error as Error); }
  }

  assertValid(): void {
    if (this.#state !== "done" || this.#buffer.length !== 0 || this.#records !== this.#expected.recordCount || this.#bodyBytes !== this.#expected.bodyBytes) fail("BACKUP_V2_TRUNCATED_COMPONENT_PAYLOAD", "Component payload is incomplete or has incorrect counts");
  }

  recordIds(): readonly string[] {
    this.assertValid();
    return [...this.#ids].sort(compareCodePoints);
  }
}
