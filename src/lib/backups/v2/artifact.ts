import {
  BackupV2FailClosedError, isRecoveryEvidenceOrigin, requireBackupV2Scope,
  type BackupV2Scope, type RecoveryEvidenceOrigin,
} from "./types.ts";
import { serializeExactByteQuantity } from "./measurement.ts";

export const ARTIFACT_HASH_ALGORITHMS = ["sha256"] as const;
export const ARTIFACT_ENCRYPTION_ALGORITHMS = ["aes-256-gcm"] as const;
export const ARTIFACT_COPY_ROLES = ["primary", "secondary_independent", "optional_offline"] as const;
export type ArtifactCopyRole = (typeof ARTIFACT_COPY_ROLES)[number];
export type ArtifactVerificationStatus = "planned" | "unverified" | "verified" | "failed";

export interface BackupArtifactEvidence {
  artifactId: string; recoverySetId: string; runId: string; generationKey: string;
  component: BackupV2Scope;
  createdByOwnerRef: string; leaseGeneration: number;
  formatVersion: string; artifactVersion: string; artifactSizeBytes: unknown;
  plaintextSizeBytes: unknown | null; ciphertextSizeBytes: unknown | null;
  hashAlgorithm: string; plaintextHash: string | null; ciphertextHash: string | null;
  encryptionAlgorithm: string | null; keyVersion: string | null; keyReference: string | null;
  keyFingerprint: string | null; createdAt: string; verifiedAt: string | null;
  verificationStatus: ArtifactVerificationStatus; evidenceOrigin: RecoveryEvidenceOrigin;
  compatibilityRef: string | null;
}

export interface ValidatedBackupArtifactEvidence extends Omit<BackupArtifactEvidence,
  "artifactSizeBytes" | "plaintextSizeBytes" | "ciphertextSizeBytes" | "hashAlgorithm" | "encryptionAlgorithm"> {
  artifactSizeBytes: string; plaintextSizeBytes: string | null; ciphertextSizeBytes: string | null;
  hashAlgorithm: "sha256"; encryptionAlgorithm: "aes-256-gcm" | null;
}

export interface BackupArtifactCopyEvidence {
  copyId: string; artifactId: string; copyRole: ArtifactCopyRole | string;
  providerNeutralRef: string; physicalObjectIdentity: string; independenceDomain: string | null;
  recordedByOwnerRef: string; leaseGeneration: number; storageClass: string | null;
  storedAt: string; verifiedAt: string | null; ciphertextSizeBytes: unknown;
  ciphertextHash: string; providerChecksumRef: string | null;
  verificationStatus: ArtifactVerificationStatus; evidenceOrigin: RecoveryEvidenceOrigin;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_ARTIFACT_EVIDENCE", `${field} is required`);
  }
  return value;
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_ARTIFACT_HASH", `${field} must be a SHA-256 digest`);
  }
  return value;
}

export function validateArtifactEvidence(value: BackupArtifactEvidence): ValidatedBackupArtifactEvidence {
  for (const [field, fieldValue] of Object.entries({
    artifactId: value.artifactId, recoverySetId: value.recoverySetId, runId: value.runId,
    generationKey: value.generationKey,
    formatVersion: value.formatVersion, artifactVersion: value.artifactVersion,
    createdByOwnerRef: value.createdByOwnerRef,
  })) nonEmpty(fieldValue, field);
  if (!/^backup-v2-generation:[0-9a-f]{64}$/.test(value.generationKey)) {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_INVALID_GENERATION_KEY", "Artifact generation key is not canonical",
    );
  }
  if (!Number.isSafeInteger(value.leaseGeneration) || value.leaseGeneration <= 0) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_ARTIFACT_EVIDENCE", "Lease generation is invalid");
  }
  requireBackupV2Scope(value.component);
  if (!["planned", "unverified", "verified", "failed"].includes(value.verificationStatus)) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_ARTIFACT_EVIDENCE", "Unknown verification status");
  }
  if (!ARTIFACT_HASH_ALGORITHMS.includes(value.hashAlgorithm as "sha256")) {
    throw new BackupV2FailClosedError("BACKUP_V2_UNKNOWN_HASH_ALGORITHM", "Unknown artifact hash algorithm");
  }
  if (!isRecoveryEvidenceOrigin(value.evidenceOrigin)) {
    throw new BackupV2FailClosedError("BACKUP_V2_UNKNOWN_EVIDENCE_ORIGIN", "Unknown artifact evidence origin");
  }
  const artifactSizeBytes = serializeExactByteQuantity(value.artifactSizeBytes, "artifactSizeBytes");
  const plaintextSizeBytes = value.plaintextSizeBytes === null ? null
    : serializeExactByteQuantity(value.plaintextSizeBytes, "plaintextSizeBytes");
  const ciphertextSizeBytes = value.ciphertextSizeBytes === null ? null
    : serializeExactByteQuantity(value.ciphertextSizeBytes, "ciphertextSizeBytes");
  if (!Number.isFinite(Date.parse(value.createdAt)) || value.compatibilityRef?.trim().length === 0) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_ARTIFACT_EVIDENCE", "Artifact metadata is invalid");
  }
  if (value.verificationStatus === "verified") {
    if (value.encryptionAlgorithm !== "aes-256-gcm" || value.ciphertextHash === null ||
        ciphertextSizeBytes === null || value.verifiedAt === null || !Number.isFinite(Date.parse(value.verifiedAt)) ||
        value.compatibilityRef === null || value.keyVersion === null || value.keyReference === null ||
        value.keyFingerprint === null || value.evidenceOrigin !== "runtime_verified" ||
        ciphertextSizeBytes !== artifactSizeBytes || Date.parse(value.verifiedAt) < Date.parse(value.createdAt)) {
      throw new BackupV2FailClosedError(
        "BACKUP_V2_UNVERIFIED_ARTIFACT_CLAIM", "Verified artifacts require complete encryption, hash, key, and compatibility evidence",
      );
    }
    sha256(value.ciphertextHash, "ciphertextHash");
  } else if (value.encryptionAlgorithm !== null && value.encryptionAlgorithm !== "aes-256-gcm") {
    throw new BackupV2FailClosedError("BACKUP_V2_UNKNOWN_ENCRYPTION_METADATA", "Unknown encryption metadata");
  }
  if (value.plaintextHash !== null) sha256(value.plaintextHash, "plaintextHash");
  if (value.ciphertextHash !== null) sha256(value.ciphertextHash, "ciphertextHash");
  return { ...value, artifactSizeBytes, plaintextSizeBytes, ciphertextSizeBytes,
    hashAlgorithm: "sha256", encryptionAlgorithm: value.encryptionAlgorithm as "aes-256-gcm" | null };
}

export function validateArtifactCopyEvidence(value: BackupArtifactCopyEvidence): BackupArtifactCopyEvidence & {
  copyRole: ArtifactCopyRole; ciphertextSizeBytes: string;
} {
  if (!ARTIFACT_COPY_ROLES.includes(value.copyRole as ArtifactCopyRole)) {
    throw new BackupV2FailClosedError("BACKUP_V2_UNKNOWN_COPY_ROLE", "Unknown copy role");
  }
  if (!["planned", "unverified", "verified", "failed"].includes(value.verificationStatus)) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_COPY_EVIDENCE", "Unknown verification status");
  }
  nonEmpty(value.copyId, "copyId"); nonEmpty(value.artifactId, "artifactId");
  nonEmpty(value.providerNeutralRef, "providerNeutralRef");
  nonEmpty(value.physicalObjectIdentity, "physicalObjectIdentity");
  nonEmpty(value.recordedByOwnerRef, "recordedByOwnerRef");
  if (!Number.isSafeInteger(value.leaseGeneration) || value.leaseGeneration <= 0) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_COPY_EVIDENCE", "Lease generation is invalid");
  }
  if (!Number.isFinite(Date.parse(value.storedAt)) || !isRecoveryEvidenceOrigin(value.evidenceOrigin)) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_COPY_EVIDENCE", "Copy evidence is invalid");
  }
  if (value.copyRole === "secondary_independent") nonEmpty(value.independenceDomain, "independenceDomain");
  if (value.verificationStatus === "verified" &&
      (value.verifiedAt === null || !Number.isFinite(Date.parse(value.verifiedAt)) ||
       value.evidenceOrigin !== "runtime_verified" || Date.parse(value.verifiedAt) < Date.parse(value.storedAt))) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_COPY_EVIDENCE", "Verified copy time is required");
  }
  sha256(value.ciphertextHash, "ciphertextHash");
  return { ...value, copyRole: value.copyRole as ArtifactCopyRole,
    ciphertextSizeBytes: serializeExactByteQuantity(value.ciphertextSizeBytes, "ciphertextSizeBytes") };
}

export function assertIndependentCopies(
  primary: BackupArtifactCopyEvidence, secondary: BackupArtifactCopyEvidence,
): void {
  const left = validateArtifactCopyEvidence(primary); const right = validateArtifactCopyEvidence(secondary);
  if (left.copyRole !== "primary" || right.copyRole !== "secondary_independent" ||
      left.copyId === right.copyId || left.providerNeutralRef === right.providerNeutralRef ||
      left.physicalObjectIdentity === right.physicalObjectIdentity ||
      (left.independenceDomain !== null && left.independenceDomain === right.independenceDomain)) {
    throw new BackupV2FailClosedError("BACKUP_V2_COPY_INDEPENDENCE_FAILED", "Copies are not independent");
  }
}

export function assertCopyMatchesArtifact(
  artifactValue: BackupArtifactEvidence, copyValue: BackupArtifactCopyEvidence,
): void {
  const artifact = validateArtifactEvidence(artifactValue);
  const copy = validateArtifactCopyEvidence(copyValue);
  if (artifact.verificationStatus !== "verified" || copy.verificationStatus !== "verified" ||
      copy.artifactId !== artifact.artifactId || copy.ciphertextHash !== artifact.ciphertextHash ||
      copy.ciphertextSizeBytes !== artifact.ciphertextSizeBytes) {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_COPY_EQUIVALENCE_FAILED", "Copy does not prove byte-for-byte equivalence with the artifact",
    );
  }
}

export interface BackupV2ManifestComponent {
  component: BackupV2Scope; artifactId: string; artifactHash: string; artifactSizeBytes: string;
  compatibilityRef: string;
}
export interface BackupV2Manifest {
  manifestVersion: string; generationKey: string; catalogFingerprint: string;
  components: readonly BackupV2ManifestComponent[]; configurationSourceRef: string;
}
