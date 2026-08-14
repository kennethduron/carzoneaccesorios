import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
  type CipherGCM,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { Transform, Writable, type Readable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import {
  DATABASE_AUTH_TAG_BYTES,
  DATABASE_NONCE_BYTES,
} from "./database-artifact-format.ts";
import { BackupV2FailClosedError } from "./types.ts";

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

function toBuffer(chunk: Buffer | string, encoding: BufferEncoding): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
}

function requireKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    fail("BACKUP_V2_INVALID_ENCRYPTION_KEY", "AES-256-GCM requires exactly 32 key bytes");
  }
  return Buffer.from(value);
}

function requireMagic(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 8) {
    fail("BACKUP_V2_INVALID_ARTIFACT_FORMAT", "Artifact envelope magic must contain exactly eight bytes");
  }
  return Buffer.from(value);
}

function requireCompressionLevel(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 9) {
    fail("BACKUP_V2_INVALID_COMPRESSION_LEVEL", "Compression level must be an integer from 1 through 9");
  }
  return value;
}

function requirePlaintextLimit(value: bigint): bigint {
  if (typeof value !== "bigint" || value <= BigInt(0)) {
    fail("BACKUP_V2_INVALID_RESOURCE_LIMIT", "Plaintext byte limit must be a positive bigint");
  }
  return value;
}

function requireCompressionRatio(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    fail("BACKUP_V2_INVALID_RESOURCE_LIMIT", "Compression ratio limit is invalid");
  }
  return value;
}

class HashMeter extends Transform {
  #bytes = BigInt(0);
  readonly #hash = createHash("sha256");
  readonly #maxBytes: bigint | null;
  #digest: string | null = null;

  constructor(maxBytes: bigint | null = null) {
    super();
    this.#maxBytes = maxBytes;
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    const value = toBuffer(chunk, encoding);
    this.#bytes += BigInt(value.byteLength);
    if (this.#maxBytes !== null && this.#bytes > this.#maxBytes) {
      callback(new BackupV2FailClosedError(
        "BACKUP_V2_DECOMPRESSION_LIMIT_EXCEEDED", "Artifact stream exceeded its configured byte limit",
      ));
      return;
    }
    this.#hash.update(value);
    callback(null, value);
  }

  get bytes(): bigint {
    return this.#bytes;
  }

  digest(): string {
    if (this.#digest === null) this.#digest = this.#hash.digest("hex");
    return this.#digest;
  }
}

class GcmEnvelopeTransform extends Transform {
  readonly #cipher: CipherGCM;
  readonly #magic: Buffer;
  readonly #nonce: Buffer;
  #headerWritten = false;
  #authTag: Buffer | null = null;

  constructor(cipher: CipherGCM, magic: Buffer, nonce: Buffer) {
    super();
    this.#cipher = cipher;
    this.#magic = magic;
    this.#nonce = nonce;
  }

  #writeHeader(): void {
    if (this.#headerWritten) return;
    this.push(Buffer.concat([this.#magic, this.#nonce]));
    this.#headerWritten = true;
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    this.#writeHeader();
    callback(null, toBuffer(chunk, encoding));
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.#writeHeader();
      this.#authTag = this.#cipher.getAuthTag();
      this.push(this.#authTag);
      callback();
    } catch {
      callback(new BackupV2FailClosedError(
        "BACKUP_V2_ENCRYPTION_FAILED", "AES-GCM authentication tag could not be finalized",
      ));
    }
  }

  authTag(): Buffer {
    if (this.#authTag === null) fail("BACKUP_V2_ENCRYPTION_FAILED", "AES-GCM authentication tag is unavailable");
    return Buffer.from(this.#authTag);
  }
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

async function assertRegularFile(filePath: string): Promise<bigint> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("BACKUP_V2_UNSAFE_ARTIFACT_FILE", "Encrypted artifact is not a regular file");
  }
  return BigInt(stat.size);
}

async function hashFile(filePath: string): Promise<{ bytes: bigint; hash: string }> {
  const meter = new HashMeter();
  await pipeline(createReadStream(filePath), meter, new Writable({
    write(_chunk, _encoding, callback) { callback(); },
  }));
  return { bytes: meter.bytes, hash: meter.digest() };
}

async function readEnvelope(
  filePath: string,
  size: bigint,
  magic: Buffer,
): Promise<{ nonce: Buffer; authTag: Buffer }> {
  const headerBytes = magic.length + DATABASE_NONCE_BYTES;
  const minimumBytes = headerBytes + DATABASE_AUTH_TAG_BYTES + 1;
  if (size < BigInt(minimumBytes) || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("BACKUP_V2_TRUNCATED_ARTIFACT", "Encrypted artifact size is invalid");
  }
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(headerBytes);
    const headerRead = await handle.read(header, 0, header.length, 0);
    const authTag = Buffer.alloc(DATABASE_AUTH_TAG_BYTES);
    const tagPosition = Number(size - BigInt(DATABASE_AUTH_TAG_BYTES));
    const tagRead = await handle.read(authTag, 0, authTag.length, tagPosition);
    if (headerRead.bytesRead !== header.length || tagRead.bytesRead !== authTag.length ||
        !header.subarray(0, magic.length).equals(magic)) {
      fail("BACKUP_V2_TRUNCATED_ARTIFACT", "Encrypted artifact header or tag is invalid");
    }
    return { nonce: header.subarray(magic.length), authTag };
  } finally {
    await handle.close();
  }
}

export interface ArtifactLayerEvidence {
  nonce: Buffer;
  authTag: Buffer;
  plaintextBytes: bigint;
  compressedBytes: bigint;
  encryptedArtifactBytes: bigint;
  plaintextHash: string;
  compressedHash: string;
  encryptedArtifactHash: string;
}

export interface WriteEncryptedArtifactInput {
  source: Readable;
  outputPath: string;
  encryptionKey: Uint8Array;
  aad: Uint8Array;
  magic: Uint8Array;
  compressionLevel: number;
  maxPlaintextBytes: bigint;
  signal?: AbortSignal;
}

export async function writeBackupV2EncryptedArtifact(
  input: WriteEncryptedArtifactInput,
): Promise<ArtifactLayerEvidence> {
  const key = requireKey(input.encryptionKey);
  const magic = requireMagic(input.magic);
  const compressionLevel = requireCompressionLevel(input.compressionLevel);
  const plaintextLimit = requirePlaintextLimit(input.maxPlaintextBytes);
  const nonce = randomBytes(DATABASE_NONCE_BYTES);
  try {
    const gzip = createGzip({ level: compressionLevel });
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: DATABASE_AUTH_TAG_BYTES });
    cipher.setAAD(Buffer.from(input.aad));
    const envelope = new GcmEnvelopeTransform(cipher, magic, nonce);
    const plaintextMeter = new HashMeter(plaintextLimit);
    const compressedMeter = new HashMeter();
    const encryptedMeter = new HashMeter();
    const output = createWriteStream(input.outputPath, { flags: "wx", mode: 0o600 });
    try {
      await pipeline(
        input.source,
        plaintextMeter,
        gzip,
        compressedMeter,
        cipher,
        envelope,
        encryptedMeter,
        output,
        { signal: input.signal },
      );
    } catch (error) {
      if (error instanceof BackupV2FailClosedError) throw error;
      if (input.signal?.aborted) fail("BACKUP_V2_EXPORT_CANCELLED", "Artifact export was cancelled");
      fail("BACKUP_V2_EXPORT_FAILED", "Artifact compression or encryption stream failed");
    }
    const minimumBytes = magic.length + DATABASE_NONCE_BYTES + DATABASE_AUTH_TAG_BYTES + 1;
    if (plaintextMeter.bytes === BigInt(0) || plaintextMeter.bytes > plaintextLimit ||
        compressedMeter.bytes === BigInt(0) || encryptedMeter.bytes < BigInt(minimumBytes)) {
      fail("BACKUP_V2_INVALID_EXPORT_SIZE", "Artifact contains invalid or excessive byte counts");
    }
    return {
      nonce,
      authTag: envelope.authTag(),
      plaintextBytes: plaintextMeter.bytes,
      compressedBytes: compressedMeter.bytes,
      encryptedArtifactBytes: encryptedMeter.bytes,
      plaintextHash: plaintextMeter.digest(),
      compressedHash: compressedMeter.digest(),
      encryptedArtifactHash: encryptedMeter.digest(),
    };
  } finally {
    key.fill(0);
    magic.fill(0);
  }
}

export interface VerifyEncryptedArtifactInput {
  artifactPath: string;
  encryptionKey: Uint8Array;
  aad: Uint8Array;
  magic: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
  plaintextBytes: bigint;
  compressedBytes: bigint;
  encryptedArtifactBytes: bigint;
  plaintextHash: string;
  compressedHash: string;
  encryptedArtifactHash: string;
  maxPlaintextBytes: bigint;
  maxCompressionRatio: number;
  plaintextSink: Writable;
}

export async function verifyBackupV2EncryptedArtifact(
  input: VerifyEncryptedArtifactInput,
): Promise<ArtifactLayerEvidence> {
  const key = requireKey(input.encryptionKey);
  const magic = requireMagic(input.magic);
  const plaintextLimit = requirePlaintextLimit(input.maxPlaintextBytes);
  const compressionRatio = requireCompressionRatio(input.maxCompressionRatio);
  try {
    const artifactSize = await assertRegularFile(input.artifactPath);
    if (artifactSize > plaintextLimit * BigInt(2) + BigInt(1_048_576)) {
      fail("BACKUP_V2_ARTIFACT_LIMIT_EXCEEDED", "Encrypted artifact exceeded its configured resource limit");
    }
    const measuredArtifact = await hashFile(input.artifactPath);
    if (artifactSize !== input.encryptedArtifactBytes || measuredArtifact.bytes !== artifactSize ||
        !safeEqualHex(measuredArtifact.hash, input.encryptedArtifactHash)) {
      fail("BACKUP_V2_ENCRYPTED_ARTIFACT_INTEGRITY_FAILED", "Encrypted artifact bytes or hash do not match");
    }
    const envelope = await readEnvelope(input.artifactPath, artifactSize, magic);
    const expectedNonce = Buffer.from(input.nonce);
    const expectedTag = Buffer.from(input.authTag);
    if (expectedNonce.byteLength !== DATABASE_NONCE_BYTES || expectedTag.byteLength !== DATABASE_AUTH_TAG_BYTES ||
        !timingSafeEqual(envelope.nonce, expectedNonce) || !timingSafeEqual(envelope.authTag, expectedTag)) {
      fail("BACKUP_V2_ENCRYPTION_METADATA_MISMATCH", "Artifact envelope does not match encryption metadata");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm", key, envelope.nonce, { authTagLength: DATABASE_AUTH_TAG_BYTES },
    );
    decipher.setAAD(Buffer.from(input.aad));
    decipher.setAuthTag(envelope.authTag);
    const compressedMeter = new HashMeter();
    const plaintextMeter = new HashMeter(plaintextLimit);
    const ciphertextStart = magic.length + DATABASE_NONCE_BYTES;
    const ciphertextEnd = Number(artifactSize - BigInt(DATABASE_AUTH_TAG_BYTES) - BigInt(1));
    try {
      await pipeline(
        createReadStream(input.artifactPath, { start: ciphertextStart, end: ciphertextEnd }),
        decipher,
        compressedMeter,
        createGunzip(),
        plaintextMeter,
        input.plaintextSink,
      );
    } catch (error) {
      if (error instanceof BackupV2FailClosedError) throw error;
      fail("BACKUP_V2_DECRYPTION_OR_COMPRESSION_FAILED", "Artifact authentication or decompression failed");
    }
    if (plaintextMeter.bytes > plaintextLimit || compressedMeter.bytes === BigInt(0) ||
        plaintextMeter.bytes > compressedMeter.bytes * BigInt(compressionRatio)) {
      fail("BACKUP_V2_DECOMPRESSION_LIMIT_EXCEEDED", "Decompressed artifact exceeded configured limits");
    }
    if (plaintextMeter.bytes !== input.plaintextBytes || compressedMeter.bytes !== input.compressedBytes ||
        !safeEqualHex(plaintextMeter.digest(), input.plaintextHash) ||
        !safeEqualHex(compressedMeter.digest(), input.compressedHash)) {
      fail("BACKUP_V2_INNER_ARTIFACT_INTEGRITY_FAILED", "Decrypted artifact bytes or hashes do not match");
    }
    return {
      nonce: envelope.nonce,
      authTag: envelope.authTag,
      plaintextBytes: plaintextMeter.bytes,
      compressedBytes: compressedMeter.bytes,
      encryptedArtifactBytes: artifactSize,
      plaintextHash: input.plaintextHash,
      compressedHash: input.compressedHash,
      encryptedArtifactHash: measuredArtifact.hash,
    };
  } finally {
    key.fill(0);
    magic.fill(0);
  }
}
