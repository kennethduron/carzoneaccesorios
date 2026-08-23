import "server-only";

import { createReadStream } from "node:fs";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";

import { writeBackupV2EncryptedArtifact } from "../v2/artifact-crypto-pipeline.ts";
import {
  COMPONENT_ARTIFACT_MAGIC,
  COMPONENT_PAYLOAD_VERSION,
  componentArtifactAadBytes,
  componentArtifactId,
  componentFilename,
  createComponentArtifactManifest,
  serializeComponentArtifactManifest,
  type BackupV2ComponentScope,
} from "../v2/component-artifact-format.ts";
import {
  collectComponentInventory,
  createComponentPayloadStream,
  type ComponentInventory,
  type ComponentSource,
} from "../v2/component-payload.ts";
import {
  DATABASE_ARTIFACT_MAGIC,
  DATABASE_EXPORT_FORMAT_VERSION,
  createDatabaseArtifactManifest,
  databaseArtifactAadBytes,
  databaseArtifactFilename,
  databaseArtifactId,
  serializeDatabaseArtifactManifest,
  sha256Hex,
} from "../v2/database-artifact-format.ts";
import { verifyDatabaseArtifact } from "../v2/database-artifact-pipeline.ts";
import type { DatabaseExporter } from "../v2/database-exporter.ts";
import { verifyComponentArtifact } from "../v2/component-artifact-pipeline.ts";
import { BackupV2FailClosedError } from "../v2/types.ts";
import { measureFile, simplifiedArtifactBinding } from "./core.ts";
import { parsePlainSqlArtifactManifest } from "./plain-sql.ts";
import type { SimplifiedComponentResult } from "./types.ts";

const COMPRESSION_LEVEL = 9;
const CATALOG_POLICY_VERSION = "simplified-source-read-only-v1";
const KEY_VERSION = "operator-recovery-key-v1";
const KEY_REFERENCE = "external-operator-recovery-key";
const COMPATIBILITY = "SIMPLIFIED_BACKUP_V2";

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

async function writeManifest(filePath: string, value: string): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requireKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    fail("BACKUP_V2_SIMPLIFIED_INVALID_RECOVERY_KEY", "AES-256-GCM requires exactly 32 recovery-key bytes");
  }
  return Buffer.from(value);
}

export interface SimplifiedExportIdentity {
  readonly runId: string;
  readonly createdAt: string;
  readonly bindingKey: string;
  readonly catalogFingerprint: string;
  readonly preflightSnapshotId: string;
}

export function createSimplifiedExportIdentity(input: {
  runId: string;
  createdAt: string;
  measurementsFingerprint: string;
}): SimplifiedExportIdentity {
  if (!/^[0-9a-f]{64}$/.test(input.measurementsFingerprint)) {
    fail("BACKUP_V2_SIMPLIFIED_SOURCE_MEASUREMENT_INVALID", "Source measurement fingerprint is invalid");
  }
  return Object.freeze({
    runId: input.runId,
    createdAt: input.createdAt,
    bindingKey: simplifiedArtifactBinding(input.runId),
    catalogFingerprint: sha256Hex(`SIMPLIFIED_BACKUP_V2_CATALOG\n${input.measurementsFingerprint}`),
    preflightSnapshotId: `simplified-preflight:${input.measurementsFingerprint}`,
  });
}

export async function exportSimplifiedDatabase(input: {
  readonly root: string;
  readonly identity: SimplifiedExportIdentity;
  readonly exporter: DatabaseExporter;
  readonly recoveryKey: Uint8Array;
  readonly signal?: AbortSignal;
}): Promise<SimplifiedComponentResult> {
  if (input.exporter.tool !== "pg_dump" || input.exporter.format !== "postgresql_custom" || !input.exporter.toolVersion) {
    fail("BACKUP_V2_SIMPLIFIED_DATABASE_EXPORTER_INVALID", "Database exporter is not the approved pg_dump custom-format exporter");
  }
  const key = requireKey(input.recoveryKey);
  const directory = path.join(input.root, "database");
  const artifactId = databaseArtifactId(input.identity.bindingKey);
  const artifactPath = path.join(directory, databaseArtifactFilename(artifactId));
  const manifestPath = path.join(directory, `${artifactId}.manifest.json`);
  await mkdir(directory, { mode: 0o700 });
  try {
    const aadInput = {
      runId: input.identity.runId,
      generationKey: input.identity.bindingKey,
      artifactId,
      createdAt: input.identity.createdAt,
      catalogFingerprint: input.identity.catalogFingerprint,
      catalogPolicyVersion: CATALOG_POLICY_VERSION,
      preflightSnapshotId: input.identity.preflightSnapshotId,
      keyVersion: KEY_VERSION,
      keyReference: KEY_REFERENCE,
      keyFingerprint: sha256Hex(key),
      exportTool: input.exporter.tool,
      exportToolVersion: input.exporter.toolVersion,
      compressionLevel: COMPRESSION_LEVEL,
    } as const;
    const session = input.exporter.open(input.signal);
    let layers;
    try {
      layers = await writeBackupV2EncryptedArtifact({
        source: session.stream,
        outputPath: artifactPath,
        encryptionKey: key,
        aad: databaseArtifactAadBytes(aadInput),
        magic: DATABASE_ARTIFACT_MAGIC,
        compressionLevel: COMPRESSION_LEVEL,
        maxPlaintextBytes: BigInt("1099511627776"),
        signal: input.signal,
      });
      await session.completed;
    } catch (error) {
      session.cancel();
      await session.completed.catch(() => undefined);
      throw error;
    }
    await chmod(artifactPath, 0o600).catch(() => undefined);
    const manifest = createDatabaseArtifactManifest({
      ...aadInput,
      nonce: layers.nonce,
      authTag: layers.authTag,
      plaintextBytes: layers.plaintextBytes,
      compressedBytes: layers.compressedBytes,
      encryptedArtifactBytes: layers.encryptedArtifactBytes,
      plaintextHash: layers.plaintextHash,
      compressedHash: layers.compressedHash,
      encryptedArtifactHash: layers.encryptedArtifactHash,
      compatibilityRef: COMPATIBILITY,
    });
    await writeManifest(manifestPath, serializeDatabaseArtifactManifest(manifest));
    await verifyDatabaseArtifact({
      artifactPath,
      manifestPath,
      encryptionKey: key,
      expected: {
        runId: input.identity.runId,
        generationKey: input.identity.bindingKey,
        artifactId,
        catalogFingerprint: input.identity.catalogFingerprint,
        preflightSnapshotId: input.identity.preflightSnapshotId,
      },
    });
    const measuredArtifact = await measureFile(artifactPath);
    const measuredManifest = await measureFile(manifestPath);
    return Object.freeze({
      component: "database",
      artifactId,
      artifactPath,
      manifestPath,
      artifactBytes: measuredArtifact.bytes,
      artifactSha256: measuredArtifact.sha256,
      manifestBytes: measuredManifest.bytes,
      manifestSha256: measuredManifest.sha256,
      plaintextBytes: layers.plaintextBytes,
      plaintextSha256: layers.plaintextHash,
      logicalCount: BigInt(1),
      formatVersion: DATABASE_EXPORT_FORMAT_VERSION,
      representation: "postgresql_custom_legacy",
      plaintextFilename: "database.dump",
      restoreStrategy: "pg_restore_legacy_only",
      postgresMajor: null,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    key.fill(0);
  }
}

interface ExportedComponent extends SimplifiedComponentResult {
  readonly inventory: ComponentInventory;
  readonly verifiedRecordIds: readonly string[];
}

export async function exportSimplifiedComponent(input: {
  readonly root: string;
  readonly identity: SimplifiedExportIdentity;
  readonly source: ComponentSource;
  readonly recoveryKey: Uint8Array;
  readonly storageMetadata?: ExportedComponent;
  readonly signal?: AbortSignal;
}): Promise<ExportedComponent> {
  const key = requireKey(input.recoveryKey);
  const component = input.source.component;
  const directory = path.join(input.root, component);
  const artifactId = componentArtifactId(component, input.identity.bindingKey);
  const artifactPath = path.join(directory, componentFilename(component, artifactId));
  const manifestPath = path.join(directory, `${artifactId}.manifest.json`);
  await mkdir(directory, { mode: 0o700 });
  try {
    const inventory = await collectComponentInventory(input.source, {}, input.signal);
    let bindingFingerprint: string | null = null;
    if (component === "storage_objects") {
      if (!input.storageMetadata) {
        fail("BACKUP_V2_SIMPLIFIED_STORAGE_METADATA_BINDING_REQUIRED", "Storage objects require verified storage metadata");
      }
      bindingFingerprint = input.storageMetadata.inventory.fingerprint;
      const metadataIds = new Set(input.storageMetadata.verifiedRecordIds);
      for (const record of inventory.records) {
        if (!metadataIds.has(record.id)) {
          fail("BACKUP_V2_STORAGE_METADATA_RELATIONSHIP_MISSING", "Storage object has no matching metadata record");
        }
      }
    }
    const aadInput = {
      runId: input.identity.runId,
      generationKey: input.identity.bindingKey,
      artifactId,
      component,
      createdAt: input.identity.createdAt,
      catalogFingerprint: input.identity.catalogFingerprint,
      catalogPolicyVersion: CATALOG_POLICY_VERSION,
      preflightSnapshotId: input.identity.preflightSnapshotId,
      sourceSnapshotId: inventory.snapshotId,
      inventoryFingerprint: inventory.fingerprint,
      bindingFingerprint,
      keyVersion: KEY_VERSION,
      keyReference: KEY_REFERENCE,
      keyFingerprint: sha256Hex(key),
      compressionLevel: COMPRESSION_LEVEL,
    } as const;
    const layers = await writeBackupV2EncryptedArtifact({
      source: createComponentPayloadStream(input.source, inventory, bindingFingerprint, {}, input.signal),
      outputPath: artifactPath,
      encryptionKey: key,
      aad: componentArtifactAadBytes(aadInput),
      magic: COMPONENT_ARTIFACT_MAGIC,
      compressionLevel: COMPRESSION_LEVEL,
      maxPlaintextBytes: BigInt("1099511627776"),
      signal: input.signal,
    });
    await chmod(artifactPath, 0o600).catch(() => undefined);
    const manifest = createComponentArtifactManifest({
      ...aadInput,
      nonce: layers.nonce,
      authTag: layers.authTag,
      recordCount: inventory.recordCount,
      bodyBytes: inventory.bodyBytes,
      plaintextBytes: layers.plaintextBytes,
      compressedBytes: layers.compressedBytes,
      encryptedArtifactBytes: layers.encryptedArtifactBytes,
      plaintextHash: layers.plaintextHash,
      compressedHash: layers.compressedHash,
      encryptedArtifactHash: layers.encryptedArtifactHash,
      compatibilityRef: COMPATIBILITY,
    });
    await writeManifest(manifestPath, serializeComponentArtifactManifest(manifest));
    const verified = await verifyComponentArtifact({
      artifactPath,
      manifestPath,
      encryptionKey: key,
      expected: {
        runId: input.identity.runId,
        generationKey: input.identity.bindingKey,
        artifactId,
        component,
        catalogFingerprint: input.identity.catalogFingerprint,
        preflightSnapshotId: input.identity.preflightSnapshotId,
      },
    });
    const measuredArtifact = await measureFile(artifactPath);
    const measuredManifest = await measureFile(manifestPath);
    return Object.freeze({
      component,
      artifactId,
      artifactPath,
      manifestPath,
      artifactBytes: measuredArtifact.bytes,
      artifactSha256: measuredArtifact.sha256,
      manifestBytes: measuredManifest.bytes,
      manifestSha256: measuredManifest.sha256,
      plaintextBytes: layers.plaintextBytes,
      plaintextSha256: layers.plaintextHash,
      logicalCount: inventory.recordCount,
      formatVersion: COMPONENT_PAYLOAD_VERSION,
      representation: COMPONENT_PAYLOAD_VERSION,
      plaintextFilename: null,
      restoreStrategy: "component_file_materialization_v1",
      postgresMajor: null,
      inventory,
      verifiedRecordIds: verified.recordIds,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    key.fill(0);
  }
}

export async function verifySimplifiedLocalComponent(
  input: { result: SimplifiedComponentResult; identity: SimplifiedExportIdentity; recoveryKey: Uint8Array },
): Promise<void> {
  if (input.result.component === "database") {
    if (input.result.representation === "postgres_plain_sql_v1") {
      const parsed = parsePlainSqlArtifactManifest(await (await import("node:fs/promises")).readFile(input.result.manifestPath, "utf8"));
      if (parsed.run_id !== input.identity.runId || parsed.generation_key !== input.identity.bindingKey ||
          parsed.artifact_id !== input.result.artifactId ||
          parsed.catalog.fingerprint !== input.identity.catalogFingerprint ||
          parsed.preflight.snapshot_id !== input.identity.preflightSnapshotId) {
        fail("BACKUP_V2_SIMPLIFIED_LOCAL_INTEGRITY_FAILED", "Plain SQL artifact identity changed after export");
      }
    } else {
      await verifyDatabaseArtifact({
        artifactPath: input.result.artifactPath,
        manifestPath: input.result.manifestPath,
        encryptionKey: input.recoveryKey,
        expected: {
          runId: input.identity.runId,
          generationKey: input.identity.bindingKey,
          artifactId: input.result.artifactId,
          catalogFingerprint: input.identity.catalogFingerprint,
          preflightSnapshotId: input.identity.preflightSnapshotId,
        },
      });
    }
  } else {
    await verifyComponentArtifact({
      artifactPath: input.result.artifactPath,
      manifestPath: input.result.manifestPath,
      encryptionKey: input.recoveryKey,
      expected: {
        runId: input.identity.runId,
        generationKey: input.identity.bindingKey,
        artifactId: input.result.artifactId,
        component: input.result.component as BackupV2ComponentScope,
        catalogFingerprint: input.identity.catalogFingerprint,
        preflightSnapshotId: input.identity.preflightSnapshotId,
      },
    });
  }
  const artifact = await measureFile(input.result.artifactPath);
  const manifest = await measureFile(input.result.manifestPath);
  if (artifact.bytes !== input.result.artifactBytes || artifact.sha256 !== input.result.artifactSha256 ||
      manifest.bytes !== input.result.manifestBytes || manifest.sha256 !== input.result.manifestSha256) {
    fail("BACKUP_V2_SIMPLIFIED_LOCAL_INTEGRITY_FAILED", "Local artifact bytes changed after export");
  }
  createReadStream(input.result.artifactPath).destroy();
}
