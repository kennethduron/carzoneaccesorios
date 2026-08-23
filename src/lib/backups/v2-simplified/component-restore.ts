import "server-only";

import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";

import { verifyBackupV2EncryptedArtifact } from "../v2/artifact-crypto-pipeline.ts";
import {
  COMPONENT_ARTIFACT_MAGIC,
  COMPONENT_PAYLOAD_MAGIC,
  COMPONENT_PAYLOAD_VERSION,
  componentArtifactAadBytes,
  componentArtifactId,
  parseComponentArtifactManifest,
  type BackupV2ComponentScope,
  type ComponentArtifactManifest,
} from "../v2/component-artifact-format.ts";
import { ComponentPayloadVerifier } from "../v2/component-payload.ts";
import { canonicalJson, sha256Hex } from "../v2/database-artifact-format.ts";
import { BackupV2FailClosedError } from "../v2/types.ts";
import { measureFile, safeHashEqual } from "./core.ts";
import type {
  SimplifiedArtifactDescriptor,
  SimplifiedBackupManifest,
  SimplifiedComponent,
} from "./types.ts";

const COMPONENTS = ["auth", "storage_metadata", "storage_objects", "external_assets"] as const;
const MAX_PLAINTEXT_BYTES = BigInt("1099511627776");
const MAX_RECORD_BYTES = BigInt(64 * 1024 * 1024);
const MAX_RECORDS = 10_000_000;

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

interface RecordHeader {
  id: string;
  metadata: Record<string, unknown>;
  body_bytes: string;
  body_sha256: string;
}

export interface RestoredComponentSummary {
  readonly component: Exclude<SimplifiedComponent, "database">;
  readonly recordCount: bigint;
  readonly bodyBytes: bigint;
  readonly recordIds: readonly string[];
  readonly restoredFiles: readonly string[];
}

class ComponentMaterializer {
  readonly #component: BackupV2ComponentScope;
  readonly #root: string;
  #buffer = Buffer.alloc(0);
  #state: "magic" | "header" | "record_or_trailer" | "body" | "body_newline" | "done" = "magic";
  #expectedHeader: Record<string, unknown> | null = null;
  #current: RecordHeader | null = null;
  #handle: FileHandle | null = null;
  #currentPath: string | null = null;
  #remaining = BigInt(0);
  #currentBytes = BigInt(0);
  #hash = createHash("sha256");
  #recordCount = BigInt(0);
  #bodyBytes = BigInt(0);
  readonly #ids = new Set<string>();
  readonly #files: string[] = [];

  constructor(component: BackupV2ComponentScope, root: string) {
    this.#component = component;
    this.#root = root;
  }

  #line(): Buffer | null {
    const index = this.#buffer.indexOf(10);
    if (index < 0) {
      if (this.#buffer.length > 1_048_576) fail("BACKUP_V2_PAYLOAD_HEADER_LIMIT", "Component header exceeded its limit");
      return null;
    }
    const line = this.#buffer.subarray(0, index);
    this.#buffer = this.#buffer.subarray(index + 1);
    return line;
  }

  #json(line: Buffer): Record<string, unknown> {
    let parsed: unknown;
    try { parsed = JSON.parse(line.toString("utf8")); }
    catch { fail("BACKUP_V2_INVALID_COMPONENT_PAYLOAD", "Component payload line is not JSON"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
        canonicalJson(parsed) !== line.toString("utf8")) {
      fail("BACKUP_V2_NON_CANONICAL_PAYLOAD", "Component payload JSON is not canonical");
    }
    return parsed as Record<string, unknown>;
  }

  async #start(header: RecordHeader): Promise<void> {
    if (this.#ids.has(header.id) || header.id.length < 1 || header.id.length > 1024 ||
        typeof header.metadata !== "object" || header.metadata === null || Array.isArray(header.metadata) ||
        !/^(0|[1-9][0-9]*)$/.test(header.body_bytes) || !/^[0-9a-f]{64}$/.test(header.body_sha256)) {
      fail("BACKUP_V2_INVALID_COMPONENT_RECORD", "Component record is invalid or duplicated");
    }
    const bytes = BigInt(header.body_bytes);
    if (bytes > MAX_RECORD_BYTES || this.#ids.size >= MAX_RECORDS) {
      fail("BACKUP_V2_RESTORE_RESOURCE_LIMIT", "Component restore limits were exceeded");
    }
    this.#ids.add(header.id);
    const extension = this.#component === "auth" || this.#component === "storage_metadata" ? ".json" : ".bin";
    this.#currentPath = path.join(this.#root, `${sha256Hex(header.id)}${extension}`);
    this.#handle = await open(this.#currentPath, "wx", 0o600);
    this.#current = header;
    this.#remaining = bytes;
    this.#currentBytes = BigInt(0);
    this.#hash = createHash("sha256");
  }

  async #finish(): Promise<void> {
    if (!this.#handle || !this.#current || !this.#currentPath) {
      fail("BACKUP_V2_INVALID_COMPONENT_RECORD", "Component record state is incomplete");
    }
    await this.#handle.sync();
    await this.#handle.close();
    this.#handle = null;
    if (this.#currentBytes !== BigInt(this.#current.body_bytes) ||
        this.#hash.digest("hex") !== this.#current.body_sha256) {
      fail("BACKUP_V2_COMPONENT_RECORD_INTEGRITY_FAILED", "Restored component record failed SHA-256");
    }
    if (this.#component === "auth" || this.#component === "storage_metadata") {
      const value = await readFile(this.#currentPath, "utf8");
      let parsed: unknown;
      try { parsed = JSON.parse(value); }
      catch { fail("BACKUP_V2_INVALID_RESTORED_JSON", "Restored structured component is not JSON"); }
      if (canonicalJson(parsed) !== value) fail("BACKUP_V2_INVALID_RESTORED_JSON", "Restored structured component is not canonical");
    }
    const filename = path.basename(this.#currentPath);
    await appendFile(path.join(this.#root, "inventory.jsonl"), `${canonicalJson({
      body_bytes: this.#current.body_bytes,
      body_sha256: this.#current.body_sha256,
      id: this.#current.id,
      metadata: this.#current.metadata,
      restored_file: filename,
    })}\n`, { encoding: "utf8", mode: 0o600 });
    this.#files.push(filename);
    this.#recordCount += BigInt(1);
    this.#bodyBytes += this.#currentBytes;
    this.#current = null;
    this.#currentPath = null;
  }

  async consume(chunk: Buffer): Promise<void> {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      if (this.#state === "done") {
        if (this.#buffer.length > 0) fail("BACKUP_V2_TRAILING_COMPONENT_PAYLOAD", "Component payload has trailing bytes");
        return;
      }
      if (this.#state === "body") {
        if (this.#remaining === BigInt(0)) { this.#state = "body_newline"; continue; }
        if (this.#buffer.length === 0) return;
        if (!this.#handle) fail("BACKUP_V2_INVALID_COMPONENT_RECORD", "Component body has no destination");
        const count = Number(this.#remaining < BigInt(this.#buffer.length) ? this.#remaining : BigInt(this.#buffer.length));
        const value = this.#buffer.subarray(0, count);
        this.#buffer = this.#buffer.subarray(count);
        await this.#handle.write(value);
        this.#hash.update(value);
        this.#remaining -= BigInt(count);
        this.#currentBytes += BigInt(count);
        continue;
      }
      if (this.#state === "body_newline") {
        if (this.#buffer.length === 0) return;
        if (this.#buffer[0] !== 10) fail("BACKUP_V2_COMPONENT_RECORD_INTEGRITY_FAILED", "Component delimiter is invalid");
        this.#buffer = this.#buffer.subarray(1);
        await this.#finish();
        this.#state = "record_or_trailer";
        continue;
      }
      const line = this.#line();
      if (line === null) return;
      if (this.#state === "magic") {
        if (line.toString("ascii") !== COMPONENT_PAYLOAD_MAGIC) fail("BACKUP_V2_UNKNOWN_PAYLOAD_FORMAT", "Unknown component payload");
        this.#state = "header";
        continue;
      }
      const value = this.#json(line);
      if (this.#state === "header") {
        if (value.component !== this.#component || value.format_version !== COMPONENT_PAYLOAD_VERSION) {
          fail("BACKUP_V2_COMPONENT_PAYLOAD_IDENTITY_MISMATCH", "Component header is inconsistent");
        }
        this.#expectedHeader = value;
        this.#state = "record_or_trailer";
        continue;
      }
      if (value.trailer === "authenticated-final") {
        if (!this.#expectedHeader || value.component !== this.#component ||
            value.record_count !== this.#expectedHeader.record_count ||
            value.snapshot_before !== this.#expectedHeader.snapshot_id ||
            value.snapshot_after !== this.#expectedHeader.snapshot_id ||
            value.inventory_before !== this.#expectedHeader.inventory_fingerprint ||
            value.inventory_after !== this.#expectedHeader.inventory_fingerprint) {
          fail("BACKUP_V2_SOURCE_DRIFT", "Component trailer is inconsistent");
        }
        this.#state = "done";
        continue;
      }
      const header = value as unknown as RecordHeader;
      await this.#start(header);
      this.#state = "body";
    }
  }

  finalize(): RestoredComponentSummary {
    if (this.#state !== "done" || this.#buffer.length !== 0 || this.#current ||
        !this.#expectedHeader || this.#recordCount.toString() !== this.#expectedHeader.record_count) {
      fail("BACKUP_V2_TRUNCATED_COMPONENT_PAYLOAD", "Component restore is incomplete");
    }
    return Object.freeze({
      component: this.#component,
      recordCount: this.#recordCount,
      bodyBytes: this.#bodyBytes,
      recordIds: Object.freeze([...this.#ids].sort()),
      restoredFiles: Object.freeze([...this.#files].sort()),
    }) as RestoredComponentSummary;
  }

  async abort(): Promise<void> {
    await this.#handle?.close().catch(() => undefined);
    this.#handle = null;
    if (this.#currentPath) await rm(this.#currentPath, { force: true });
  }
}

class VerifiedMaterializingSink extends Writable {
  readonly #verifier: ComponentPayloadVerifier;
  readonly #materializer: ComponentMaterializer;

  constructor(manifest: ComponentArtifactManifest, root: string) {
    super();
    this.#verifier = new ComponentPayloadVerifier({
      component: manifest.component,
      snapshotId: manifest.payload.source_snapshot_id,
      inventoryFingerprint: manifest.payload.inventory_fingerprint,
      bindingFingerprint: manifest.payload.binding_fingerprint,
      recordCount: BigInt(manifest.payload.record_count),
      bodyBytes: BigInt(manifest.payload.body_bytes),
    });
    this.#materializer = new ComponentMaterializer(manifest.component, root);
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.#verifier.write(value, (error) => {
      if (error) { callback(error); return; }
      void this.#materializer.consume(value).then(() => callback(), callback);
    });
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#verifier.end((error?: Error | null) => {
      if (error) { callback(error); return; }
      try {
        this.#verifier.assertValid();
        this.#materializer.finalize();
        callback();
      } catch (value) { callback(value as Error); }
    });
  }

  summary(): RestoredComponentSummary { return this.#materializer.finalize(); }
  async abort(): Promise<void> { await this.#materializer.abort(); }
}

function descriptor(
  descriptors: readonly SimplifiedArtifactDescriptor[],
  component: BackupV2ComponentScope,
  kind: "encrypted_payload" | "manifest_sidecar",
): SimplifiedArtifactDescriptor {
  const matches = descriptors.filter((item) => item.component === component && item.kind === kind);
  if (matches.length !== 1) fail("BACKUP_V2_COMPONENT_MISSING", "Required component descriptor is missing or duplicated");
  return matches[0];
}

async function assertDownloaded(pathValue: string, expected: SimplifiedArtifactDescriptor): Promise<void> {
  const measured = await measureFile(pathValue);
  if (measured.bytes !== expected.bytes || !safeHashEqual(measured.sha256, expected.sha256)) {
    fail("BACKUP_V2_INTEGRITY_FAILED", "Downloaded component failed SHA-256 verification");
  }
}

function componentAad(manifest: ComponentArtifactManifest): Buffer {
  return componentArtifactAadBytes({
    runId: manifest.run_id,
    generationKey: manifest.generation_key,
    artifactId: manifest.artifact_id,
    component: manifest.component,
    createdAt: manifest.created_at,
    catalogFingerprint: manifest.catalog.fingerprint,
    catalogPolicyVersion: manifest.catalog.policy_version,
    preflightSnapshotId: manifest.preflight.snapshot_id,
    sourceSnapshotId: manifest.payload.source_snapshot_id,
    inventoryFingerprint: manifest.payload.inventory_fingerprint,
    bindingFingerprint: manifest.payload.binding_fingerprint,
    keyVersion: manifest.encryption.key_version,
    keyReference: manifest.encryption.key_reference,
    keyFingerprint: manifest.encryption.key_fingerprint,
    compressionLevel: manifest.compression.level,
  });
}

export async function restoreSimplifiedComponents(input: {
  readonly manifest: SimplifiedBackupManifest;
  readonly descriptors: readonly SimplifiedArtifactDescriptor[];
  readonly downloadedPaths: ReadonlyMap<string, string>;
  readonly restoreRoot: string;
  readonly recoveryKey: Uint8Array;
}): Promise<readonly RestoredComponentSummary[]> {
  const key = Buffer.from(input.recoveryKey);
  if (key.byteLength !== 32) fail("BACKUP_V2_SIMPLIFIED_INVALID_RECOVERY_KEY", "Recovery key is invalid");
  const results: RestoredComponentSummary[] = [];
  try {
    for (const component of COMPONENTS) {
      const entry = input.manifest.components.find((item) => item.component === component);
      if (!entry) fail("BACKUP_V2_COMPONENT_MISSING", "Required component is absent from the manifest");
      const artifactDescriptor = descriptor(input.descriptors, component, "encrypted_payload");
      const manifestDescriptor = descriptor(input.descriptors, component, "manifest_sidecar");
      const artifactPath = input.downloadedPaths.get(artifactDescriptor.objectKey);
      const manifestPath = input.downloadedPaths.get(manifestDescriptor.objectKey);
      if (!artifactPath || !manifestPath) fail("BACKUP_V2_COMPONENT_MISSING", "Required downloaded component is absent");
      await assertDownloaded(artifactPath, artifactDescriptor);
      await assertDownloaded(manifestPath, manifestDescriptor);
      const sidecar = parseComponentArtifactManifest(await readFile(manifestPath, "utf8"));
      if (sidecar.component !== component || sidecar.generation_key !== input.manifest.local_artifact_binding ||
          sidecar.artifact_id !== componentArtifactId(component, input.manifest.local_artifact_binding) ||
          sidecar.artifact_id !== entry.artifact_id || sidecar.run_id !== input.manifest.run_id ||
          sidecar.encryption.key_fingerprint !== sha256Hex(key)) {
        fail("BACKUP_V2_SIMPLIFIED_CROSS_RUN_DENIED", "Component sidecar is outside the authenticated run");
      }
      const directory = path.join(input.restoreRoot, component);
      await mkdir(directory, { mode: 0o700 });
      const sink = new VerifiedMaterializingSink(sidecar, directory);
      try {
        await verifyBackupV2EncryptedArtifact({
          artifactPath,
          encryptionKey: key,
          aad: componentAad(sidecar),
          magic: COMPONENT_ARTIFACT_MAGIC,
          nonce: Buffer.from(sidecar.encryption.nonce_base64, "base64"),
          authTag: Buffer.from(sidecar.encryption.auth_tag_base64, "base64"),
          plaintextBytes: BigInt(sidecar.byte_counts.plaintext_export),
          compressedBytes: BigInt(sidecar.byte_counts.compressed),
          encryptedArtifactBytes: BigInt(sidecar.byte_counts.encrypted_artifact),
          plaintextHash: sidecar.hashes.plaintext_export,
          compressedHash: sidecar.hashes.compressed,
          encryptedArtifactHash: sidecar.hashes.encrypted_artifact,
          maxPlaintextBytes: MAX_PLAINTEXT_BYTES,
          maxCompressionRatio: 500,
          plaintextSink: sink,
        });
        results.push(sink.summary());
      } catch (error) {
        await sink.abort();
        throw error;
      }
    }
    const metadata = results.find((item) => item.component === "storage_metadata")!;
    const objects = results.find((item) => item.component === "storage_objects")!;
    const missing = metadata.recordIds.filter((id) => !objects.recordIds.includes(id));
    const unexpected = objects.recordIds.filter((id) => !metadata.recordIds.includes(id));
    if (missing.length > 0 || unexpected.length > 0) {
      fail("BACKUP_V2_STORAGE_RESTORE_CROSS_VERIFY_FAILED", "Storage metadata and object identities differ");
    }
    return Object.freeze(results);
  } finally {
    key.fill(0);
  }
}
