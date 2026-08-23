import "server-only";

import { Readable, Writable } from "node:stream";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { verifyBackupV2EncryptedArtifact, writeBackupV2EncryptedArtifact } from "../v2/artifact-crypto-pipeline.ts";
import { canonicalJson, sha256Hex } from "../v2/database-artifact-format.ts";
import { BackupV2FailClosedError } from "../v2/types.ts";
import {
  assertSimplifiedObjectKey,
  createSimplifiedIndex,
  createSimplifiedManifest,
  measureFile,
  parseSimplifiedIndex,
  parseSimplifiedManifest,
  readBoundedUtf8,
  simplifiedRemotePrefix,
  writeCanonicalJsonFile,
} from "./core.ts";
import type {
  SimplifiedArtifactDescriptor,
  SimplifiedBackupIndex,
  SimplifiedBackupManifest,
  SimplifiedComponentManifestEntry,
  SimplifiedComponentResult,
} from "./types.ts";

const MANIFEST_MAGIC = Buffer.from("CZB2SM01", "ascii");
const MAX_MANIFEST_BYTES = BigInt(2 * 1024 * 1024);

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

function componentObjectKeys(runId: string, result: SimplifiedComponentResult): {
  artifact: string;
  manifest: string;
} {
  const prefix = simplifiedRemotePrefix(runId);
  return {
    artifact: assertSimplifiedObjectKey(`${prefix}${result.component}/${path.basename(result.artifactPath)}`, runId),
    manifest: assertSimplifiedObjectKey(`${prefix}${result.component}/${path.basename(result.manifestPath)}`, runId),
  };
}

export function componentArtifactDescriptors(
  runId: string,
  results: readonly SimplifiedComponentResult[],
): readonly SimplifiedArtifactDescriptor[] {
  return Object.freeze(results.flatMap((result) => {
    const keys = componentObjectKeys(runId, result);
    return [
      Object.freeze({
        component: result.component,
        kind: "encrypted_payload" as const,
        localPath: result.artifactPath,
        objectKey: keys.artifact,
        bytes: result.artifactBytes,
        sha256: result.artifactSha256,
        artifactId: result.artifactId,
      }),
      Object.freeze({
        component: result.component,
        kind: "manifest_sidecar" as const,
        localPath: result.manifestPath,
        objectKey: keys.manifest,
        bytes: result.manifestBytes,
        sha256: result.manifestSha256,
        artifactId: result.artifactId,
      }),
    ];
  }));
}

function manifestEntry(runId: string, result: SimplifiedComponentResult): SimplifiedComponentManifestEntry {
  const keys = componentObjectKeys(runId, result);
  return Object.freeze({
    component: result.component,
    artifact_id: result.artifactId,
    artifact_object_key: keys.artifact,
    artifact_bytes: result.artifactBytes.toString(),
    artifact_sha256: result.artifactSha256,
    manifest_object_key: keys.manifest,
    manifest_bytes: result.manifestBytes.toString(),
    manifest_sha256: result.manifestSha256,
    plaintext_bytes: result.plaintextBytes.toString(),
    plaintext_sha256: result.plaintextSha256,
    logical_count: result.logicalCount.toString(),
    format_version: result.formatVersion,
    encryption_envelope: "car-zone-aesgcm-envelope-v1",
    representation: result.representation,
    plaintext_filename: result.plaintextFilename,
    restore_strategy: result.restoreStrategy,
    postgres_major: result.postgresMajor,
  });
}

class BoundedCollector extends Writable {
  readonly #maximum: bigint;
  #bytes = BigInt(0);
  #chunks: Buffer[] = [];

  constructor(maximum: bigint) {
    super();
    this.#maximum = maximum;
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const value = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding);
    this.#bytes += BigInt(value.byteLength);
    if (this.#bytes > this.#maximum) {
      callback(new BackupV2FailClosedError("BACKUP_V2_SIMPLIFIED_MANIFEST_LIMIT_EXCEEDED", "Decrypted manifest exceeded its limit"));
      return;
    }
    this.#chunks.push(value);
    callback();
  }

  value(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

function manifestAad(input: {
  runId: string;
  createdAt: string;
  manifestPlaintextSha256: string;
}): Buffer {
  return Buffer.from(canonicalJson({
    created_at: input.createdAt,
    manifest_plaintext_sha256: input.manifestPlaintextSha256,
    run_id: input.runId,
    schema: "car-zone-backup-v2-simplified-manifest-aad-v1",
  }), "utf8");
}

export interface WrittenSimplifiedManifest {
  readonly manifest: SimplifiedBackupManifest;
  readonly index: SimplifiedBackupIndex;
  readonly descriptors: readonly SimplifiedArtifactDescriptor[];
}

export async function writeSimplifiedManifestBundle(input: {
  readonly root: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly bindingKey: string;
  readonly results: readonly SimplifiedComponentResult[];
  readonly recoveryKey: Uint8Array;
}): Promise<WrittenSimplifiedManifest> {
  if (input.results.length !== 5) fail("BACKUP_V2_SIMPLIFIED_MANIFEST_INVALID", "Exactly five components are required");
  const manifest = createSimplifiedManifest({
    schema: "car-zone-backup-v2-simplified-manifest-v1",
    application: "car-zone-accesorios",
    run_id: input.runId,
    created_at: input.createdAt,
    local_artifact_binding: input.bindingKey,
    remote_prefix: simplifiedRemotePrefix(input.runId),
    components: Object.freeze(input.results.map((result) => manifestEntry(input.runId, result))),
    production_source_access: "READ_ONLY",
    production_mutations: 0,
    independent_secondary_present: false,
    full_dr_ready: false,
  });
  const plaintext = `${canonicalJson(manifest)}\n`;
  parseSimplifiedManifest(plaintext);
  const directory = path.join(input.root, "manifest");
  await mkdir(directory, { mode: 0o700 });
  const encryptedPath = path.join(directory, "backup-manifest.czb2");
  const indexPath = path.join(directory, "backup-index.json");
  const plaintextHash = sha256Hex(plaintext);
  const aad = manifestAad({ runId: input.runId, createdAt: input.createdAt, manifestPlaintextSha256: plaintextHash });
  const layers = await writeBackupV2EncryptedArtifact({
    source: Readable.from([Buffer.from(plaintext, "utf8")]),
    outputPath: encryptedPath,
    encryptionKey: input.recoveryKey,
    aad,
    magic: MANIFEST_MAGIC,
    compressionLevel: 9,
    maxPlaintextBytes: MAX_MANIFEST_BYTES,
  });
  const manifestObjectKey = assertSimplifiedObjectKey(
    `${simplifiedRemotePrefix(input.runId)}manifest/backup-manifest.czb2`, input.runId,
  );
  const index = createSimplifiedIndex({
    schema: "car-zone-backup-v2-simplified-index-v1",
    run_id: input.runId,
    created_at: input.createdAt,
    manifest_object_key: manifestObjectKey,
    manifest_encrypted_bytes: layers.encryptedArtifactBytes.toString(),
    manifest_encrypted_sha256: layers.encryptedArtifactHash,
    manifest_plaintext_bytes: layers.plaintextBytes.toString(),
    manifest_plaintext_sha256: layers.plaintextHash,
    manifest_compressed_bytes: layers.compressedBytes.toString(),
    manifest_compressed_sha256: layers.compressedHash,
    encryption: {
      algorithm: "aes-256-gcm",
      envelope: "car-zone-aesgcm-envelope-v1",
      nonce_base64: layers.nonce.toString("base64"),
      auth_tag_base64: layers.authTag.toString("base64"),
      aad_sha256: sha256Hex(aad),
    },
  });
  await writeCanonicalJsonFile(indexPath, index);
  parseSimplifiedIndex(await readBoundedUtf8(indexPath));
  const encrypted = await measureFile(encryptedPath);
  const indexMeasured = await measureFile(indexPath);
  if (encrypted.bytes !== layers.encryptedArtifactBytes || encrypted.sha256 !== layers.encryptedArtifactHash) {
    fail("BACKUP_V2_SIMPLIFIED_LOCAL_INTEGRITY_FAILED", "Encrypted manifest changed after creation");
  }
  const descriptors = Object.freeze([
    Object.freeze({
      component: "backup_manifest" as const,
      kind: "encrypted_manifest" as const,
      localPath: encryptedPath,
      objectKey: manifestObjectKey,
      bytes: encrypted.bytes,
      sha256: encrypted.sha256,
      artifactId: "backup-manifest",
    }),
    Object.freeze({
      component: "backup_index" as const,
      kind: "index" as const,
      localPath: indexPath,
      objectKey: assertSimplifiedObjectKey(`${simplifiedRemotePrefix(input.runId)}manifest/backup-index.json`, input.runId),
      bytes: indexMeasured.bytes,
      sha256: indexMeasured.sha256,
      artifactId: "backup-index",
    }),
  ] satisfies SimplifiedArtifactDescriptor[]);
  return Object.freeze({ manifest, index, descriptors });
}

export async function decryptAndVerifySimplifiedManifest(input: {
  readonly encryptedManifestPath: string;
  readonly indexPath: string;
  readonly recoveryKey: Uint8Array;
}): Promise<SimplifiedBackupManifest> {
  const index = parseSimplifiedIndex(await readBoundedUtf8(input.indexPath));
  const aad = manifestAad({
    runId: index.run_id,
    createdAt: index.created_at,
    manifestPlaintextSha256: index.manifest_plaintext_sha256,
  });
  if (sha256Hex(aad) !== index.encryption.aad_sha256) {
    fail("BACKUP_V2_SIMPLIFIED_INDEX_TAMPERED", "Manifest AAD does not match the backup index");
  }
  const collector = new BoundedCollector(MAX_MANIFEST_BYTES);
  await verifyBackupV2EncryptedArtifact({
    artifactPath: input.encryptedManifestPath,
    encryptionKey: input.recoveryKey,
    aad,
    magic: MANIFEST_MAGIC,
    nonce: Buffer.from(index.encryption.nonce_base64, "base64"),
    authTag: Buffer.from(index.encryption.auth_tag_base64, "base64"),
    plaintextBytes: BigInt(index.manifest_plaintext_bytes),
    compressedBytes: BigInt(index.manifest_compressed_bytes),
    encryptedArtifactBytes: BigInt(index.manifest_encrypted_bytes),
    plaintextHash: index.manifest_plaintext_sha256,
    compressedHash: index.manifest_compressed_sha256,
    encryptedArtifactHash: index.manifest_encrypted_sha256,
    maxPlaintextBytes: MAX_MANIFEST_BYTES,
    maxCompressionRatio: 100,
    plaintextSink: collector,
  });
  const manifest = parseSimplifiedManifest(collector.value());
  if (manifest.run_id !== index.run_id || manifest.created_at !== index.created_at ||
      sha256Hex(`${canonicalJson(manifest)}\n`) !== index.manifest_plaintext_sha256) {
    fail("BACKUP_V2_SIMPLIFIED_CROSS_RUN_DENIED", "Encrypted manifest does not belong to the backup index");
  }
  return manifest;
}
