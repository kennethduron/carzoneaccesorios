import assert from "node:assert/strict";
import {
  CAR_ZONE_RECOVERY_POLICY, assertCopyMatchesArtifact, assertIndependentCopies, evaluateRecoverySet,
  validateArtifactCopyEvidence, validateArtifactEvidence,
} from "../src/lib/backups/v2/index.ts";

const now = "2026-08-14T12:00:00.000Z";
const verifiedAt = "2026-08-14T11:55:00.000Z";
const hash = "a".repeat(64);
const generationKey = `backup-v2-generation:${"1".repeat(64)}`;
const otherGenerationKey = `backup-v2-generation:${"2".repeat(64)}`;
const crossGenerationKeys = ["2", "1", "3", "4", "5"]
  .map((digit) => `backup-v2-generation:${digit.repeat(64)}`);
const key = { status: "availability_attested", keyVersion: "offline-v1", safeReference: "custody:offline",
  publicFingerprint: "SHA256:public-only-fingerprint", attestedAt: verifiedAt };
function component(scope, overrides = {}) {
  return { scope, artifact: "present", completion: "completed", integrity: "verified",
    compatibility: { status: "verified", backupFormatVersion: "format-v1", schemaCompatibilityRef: "head:synthetic",
      exporterVersion: "contract-only", verifiedAt },
    copies: [
      { kind: "primary", status: "verified", verifiedAt, providerNeutralRef: `primary:${scope}`,
        copyId: `p:${scope}`, independenceDomain: "primary-domain" },
      { kind: "independent_offsite", status: "verified", verifiedAt, providerNeutralRef: `secondary:${scope}`,
        copyId: `s:${scope}`, independenceDomain: "secondary-domain" },
    ], failClosedReasons: [], evidenceOrigin: "synthetic_fixture", ...overrides };
}
const all = ["database", "auth", "storage_metadata", "storage_objects", "external_assets"].map(component);
function canonicalArtifact(scope, overrides = {}) {
  const copies = [
    { copyRole: "primary", verificationStatus: "verified", ciphertextSizeBytes: "100", ciphertextHash: hash,
      providerNeutralRef: `primary:${scope}`, physicalObjectIdentity: `physical:primary:${scope}`,
      independenceDomain: "primary-domain", evidenceOrigin: "runtime_verified" },
    { copyRole: "secondary_independent", verificationStatus: "verified", ciphertextSizeBytes: "100",
      ciphertextHash: hash, providerNeutralRef: `secondary:${scope}`,
      physicalObjectIdentity: `physical:secondary:${scope}`, independenceDomain: "secondary-domain",
      evidenceOrigin: "runtime_verified" },
  ];
  return { artifactId: `artifact:${scope}`, generationKey, component: scope, verificationStatus: "verified",
    ciphertextSizeBytes: "100", ciphertextHash: hash, evidenceOrigin: "runtime_verified", copies, ...overrides };
}
const canonicalAll = ["database", "auth", "storage_metadata", "storage_objects", "external_assets"]
  .map(canonicalArtifact);
function evaluate(components, overrides = {}) {
  return evaluateRecoverySet({ policy: CAR_ZONE_RECOVERY_POLICY, components, generationKey,
    canonicalArtifacts: canonicalAll,
    recoveryKey: key,
    environment: "synthetic_test", evaluatedAt: now, ...overrides });
}
assert.equal(evaluate(all).fullDrReady, true);
assert.equal(evaluate(all, { generationKey: undefined }).fullDrReady, false);
for (const missingScope of ["database", "auth", "storage_metadata", "storage_objects", "external_assets"]) {
  assert.equal(evaluate(all.filter(({ scope }) => scope !== missingScope)).fullDrReady, false,
    `missing ${missingScope} must fail closed`);
}
assert.equal(evaluate(all, { canonicalArtifacts: canonicalAll.map((artifact) => artifact.component === "auth"
  ? { ...artifact, generationKey: otherGenerationKey } : artifact) }).fullDrReady, false);
assert.equal(evaluate(all, { canonicalArtifacts: canonicalAll.map((artifact, index) => ({
  ...artifact, generationKey: crossGenerationKeys[index],
})) }).fullDrReady, false,
"generation A auth plus database/storage-metadata/storage-objects/external-assets from B/C/D/E must fail closed");
assert.equal(evaluate([], { canonicalArtifacts: [] }).fullDrReady, false, "zero artifacts must fail closed");
assert.equal(evaluate(all, { canonicalArtifacts: [] }).fullDrReady, false,
  "legacy component evidence without canonical artifacts must fail closed");
assert.equal(evaluate(all, { canonicalArtifacts: canonicalAll.map((artifact) => ({ ...artifact,
  copies: artifact.copies.filter(({ copyRole }) => copyRole === "primary") })) }).fullDrReady, false);
assert.equal(evaluate(all, { canonicalArtifacts: canonicalAll.map((artifact) => artifact.component === "database"
  ? { ...artifact, copies: artifact.copies.map((copy) => copy.copyRole === "secondary_independent"
    ? { ...copy, physicalObjectIdentity: `physical:primary:${artifact.component}` } : copy) } : artifact) }).fullDrReady, false);
assert.equal(evaluate(all, { canonicalArtifacts: canonicalAll.map((artifact) => artifact.component === "database"
  ? { ...artifact, copies: artifact.copies.map((copy) => copy.copyRole === "secondary_independent"
    ? { ...copy, ciphertextHash: "b".repeat(64) } : copy) } : artifact) }).fullDrReady, false);
assert.equal(evaluate(all, { canonicalArtifacts: canonicalAll.map((artifact) => artifact.component === "database"
  ? { ...artifact, copies: artifact.copies.map((copy) => copy.copyRole === "secondary_independent"
    ? { ...copy, ciphertextSizeBytes: "101" } : copy) } : artifact) }).fullDrReady, false);
assert.equal(evaluate(all, { canonicalArtifacts: canonicalAll.map((artifact) => artifact.component === "database"
  ? { ...artifact, copies: artifact.copies.map((copy) => copy.copyRole === "secondary_independent"
    ? { ...copy, verificationStatus: "unverified" } : copy) } : artifact) }).fullDrReady, false);
assert.equal(evaluate(all, { canonicalArtifacts: canonicalAll.filter(({ component: scope }) => scope !== "external_assets") }).fullDrReady, false);
assert.equal(evaluate(all.map((item) => item.scope === "external_assets" ? { ...item, integrity: "unknown" } : item)).fullDrReady, false);
assert.equal(evaluateRecoverySet({ policy: CAR_ZONE_RECOVERY_POLICY,
  components: all.map((item) => ({ ...item, evidenceOrigin: item.scope === "external_assets" ? "future_origin" : "runtime_verified" })),
  generationKey,
  canonicalArtifacts: canonicalAll,
  recoveryKey: key, environment: "runtime", evaluatedAt: now }).fullDrReady, false);
assert.equal(evaluate(all.map((item) => item.scope === "database" ? { ...item, copies: item.copies.map((copy) =>
  copy.kind === "independent_offsite" ? { ...copy, copyId: "p:database", providerNeutralRef: "primary:database" } : copy) } : item)).fullDrReady, false);

const artifact = { artifactId: "artifact-1", recoverySetId: "set-1", runId: "run-1", generationKey,
  component: "database",
  createdByOwnerRef: "worker-a", leaseGeneration: 1,
  formatVersion: "format-v1", artifactVersion: "generation-v1", artifactSizeBytes: "90071992547409930",
  plaintextSizeBytes: "90071992547409920", ciphertextSizeBytes: "90071992547409930",
  hashAlgorithm: "sha256", plaintextHash: hash, ciphertextHash: hash, encryptionAlgorithm: "aes-256-gcm",
  keyVersion: "offline-v1", keyReference: "custody:offline", keyFingerprint: "SHA256:public-only",
  createdAt: verifiedAt, verifiedAt, verificationStatus: "verified", evidenceOrigin: "runtime_verified",
  compatibilityRef: "head:synthetic" };
assert.equal(validateArtifactEvidence(artifact).artifactSizeBytes, "90071992547409930");
for (const change of [
  { artifactSizeBytes: Number.MAX_SAFE_INTEGER + 1 }, { artifactSizeBytes: "-1" }, { hashAlgorithm: "md5" },
  { ciphertextHash: "bad" }, { encryptionAlgorithm: "none" }, { evidenceOrigin: "unknown" },
  { compatibilityRef: null },
  { generationKey: otherGenerationKey.replace("2", "z") },
  { component: null }, { verificationStatus: "trusted" },
]) assert.throws(() => validateArtifactEvidence({ ...artifact, ...change }));

function copy(copyRole, copyId, ref, domain) {
  return { copyId, artifactId: "artifact-1", copyRole, providerNeutralRef: ref, independenceDomain: domain,
    physicalObjectIdentity: `physical:${copyId}`, recordedByOwnerRef: "worker-a", leaseGeneration: 1,
    storageClass: null, storedAt: verifiedAt, verifiedAt, ciphertextSizeBytes: "90071992547409930",
    ciphertextHash: hash, providerChecksumRef: null, verificationStatus: "verified", evidenceOrigin: "runtime_verified" };
}
const primary = copy("primary", "copy-primary", "copy:primary", "primary-domain");
const secondary = copy("secondary_independent", "copy-secondary", "copy:secondary", "secondary-domain");
assert.equal(validateArtifactCopyEvidence(primary).copyRole, "primary");
assert.doesNotThrow(() => assertIndependentCopies(primary, secondary));
assert.doesNotThrow(() => assertCopyMatchesArtifact(artifact, primary));
assert.throws(() => assertIndependentCopies(primary, { ...secondary, providerNeutralRef: primary.providerNeutralRef }));
assert.throws(() => assertIndependentCopies(primary,
  { ...secondary, physicalObjectIdentity: primary.physicalObjectIdentity }));
assert.throws(() => assertCopyMatchesArtifact(artifact, { ...primary, ciphertextHash: "b".repeat(64) }));
assert.throws(() => assertCopyMatchesArtifact(artifact,
  { ...secondary, artifactId: "artifact-from-another-generation" }));
assert.throws(() => validateArtifactCopyEvidence({ ...primary, copyRole: "replica" }));
assert.throws(() => validateArtifactCopyEvidence({ ...secondary, verificationStatus: "verified", verifiedAt: null }));
console.log("Backup V2 Phase 4B.1 recovery/artifact contracts: PASS");
