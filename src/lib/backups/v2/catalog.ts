import { createHash } from "node:crypto";

import { BackupV2FailClosedError, isRecoveryEvidenceOrigin, type RecoveryEvidenceOrigin } from "./types.ts";
import { parseExactByteQuantity, serializeExactByteQuantity } from "./measurement.ts";

export const CATALOG_RELATION_KINDS = ["base_table", "partitioned_table", "view", "materialized_view"] as const;
export type CatalogRelationKind = (typeof CATALOG_RELATION_KINDS)[number];
export const CATALOG_CLASSIFICATIONS = [
  "required_backup", "metadata_only", "reconstructable", "exclude_with_justification", "review_required",
] as const;
export type CatalogClassification = (typeof CATALOG_CLASSIFICATIONS)[number];

export interface DiscoveredCatalogRelation {
  schemaName: string;
  relationName: string;
  relationKind: CatalogRelationKind | string;
  estimatedRows: string | null;
  totalBytes: string | null;
  tableBytes: string | null;
  indexBytes: string | null;
  discoveredAt: string;
  evidenceOrigin: RecoveryEvidenceOrigin;
}

export interface ClassifiedCatalogRelation extends DiscoveredCatalogRelation {
  relationKind: CatalogRelationKind | "unknown";
  classification: CatalogClassification;
  classificationReason: string;
}

export interface CatalogSnapshot {
  policyVersion: string;
  discoveredAt: string;
  entries: readonly ClassifiedCatalogRelation[];
  fingerprint: string;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizeClassification(entry: ClassifiedCatalogRelation): ClassifiedCatalogRelation {
  const normalized = normalizeCatalogDiscovery(entry);
  if (![...CATALOG_RELATION_KINDS, "unknown"].includes(entry.relationKind as CatalogRelationKind | "unknown") ||
      !CATALOG_CLASSIFICATIONS.includes(entry.classification) ||
      typeof entry.classificationReason !== "string" || entry.classificationReason.trim().length === 0 ||
      entry.classificationReason.length > 500 ||
      (entry.classification === "exclude_with_justification" && entry.classificationReason.trim().length < 20)) {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_INVALID_CATALOG_CLASSIFICATION", "Catalog classification evidence is invalid",
    );
  }
  return {
    ...normalized,
    relationKind: entry.relationKind,
    classification: entry.classification,
    classificationReason: entry.classificationReason.trim(),
  };
}

export function normalizeClassifiedCatalog(
  entries: readonly ClassifiedCatalogRelation[],
): readonly ClassifiedCatalogRelation[] {
  const identities = new Set<string>();
  const normalized = entries.map((entry) => {
    const value = normalizeClassification(entry);
    const identity = `${value.schemaName}\u0000${value.relationName}`;
    if (identities.has(identity)) {
      throw new BackupV2FailClosedError(
        "BACKUP_V2_DUPLICATE_CATALOG_IDENTITY", `Duplicate catalog identity ${value.schemaName}.${value.relationName}`,
      );
    }
    identities.add(identity);
    return value;
  });
  return normalized.sort((left, right) => compareUtf8(
    `${left.schemaName}\u0000${left.relationName}`, `${right.schemaName}\u0000${right.relationName}`,
  ));
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_$]*$/.test(value)) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_CATALOG_IDENTITY", `${field} is invalid`);
  }
  return value;
}

function normalizeOptionalExact(value: unknown, field: string): string | null {
  if (value === null) return null;
  return serializeExactByteQuantity(parseExactByteQuantity(value, field), field);
}

export function normalizeCatalogDiscovery(value: DiscoveredCatalogRelation): DiscoveredCatalogRelation {
  const discoveredAtMs = Date.parse(value.discoveredAt);
  if (!Number.isFinite(discoveredAtMs) || !isRecoveryEvidenceOrigin(value.evidenceOrigin)) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_CATALOG_EVIDENCE", "Catalog evidence is invalid");
  }
  return {
    schemaName: requireIdentifier(value.schemaName, "schemaName"),
    relationName: requireIdentifier(value.relationName, "relationName"),
    relationKind: value.relationKind,
    estimatedRows: normalizeOptionalExact(value.estimatedRows, "estimatedRows"),
    totalBytes: normalizeOptionalExact(value.totalBytes, "totalBytes"),
    tableBytes: normalizeOptionalExact(value.tableBytes, "tableBytes"),
    indexBytes: normalizeOptionalExact(value.indexBytes, "indexBytes"),
    discoveredAt: new Date(discoveredAtMs).toISOString(),
    evidenceOrigin: value.evidenceOrigin,
  };
}

export function catalogFingerprint(entries: readonly ClassifiedCatalogRelation[]): string {
  const field = (value: string) => `${Buffer.byteLength(value, "utf8")}:${value}`;
  const rows = normalizeClassifiedCatalog(entries).map((entry) => [
    entry.schemaName, entry.relationName, entry.relationKind, entry.classification, entry.classificationReason,
  ].map(field).join(""));
  const canonical = `backup-v2-catalog-v1${rows.length ? `\n${rows.join("\n")}` : ""}`;
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function createCatalogSnapshot(
  entries: readonly ClassifiedCatalogRelation[], policyVersion: string, discoveredAt: string,
): CatalogSnapshot {
  const normalizedPolicyVersion = policyVersion.trim();
  const discoveredAtMs = Date.parse(discoveredAt);
  if (normalizedPolicyVersion.length === 0 || normalizedPolicyVersion.length > 80 || !Number.isFinite(discoveredAtMs)) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_CATALOG_SNAPSHOT", "Catalog snapshot metadata is invalid");
  }
  const normalizedEntries = normalizeClassifiedCatalog(entries);
  return {
    policyVersion: normalizedPolicyVersion,
    discoveredAt: new Date(discoveredAtMs).toISOString(),
    entries: normalizedEntries,
    fingerprint: catalogFingerprint(normalizedEntries),
  };
}

export function assertCatalogUnchanged(before: CatalogSnapshot, used: CatalogSnapshot): void {
  if (before.fingerprint !== used.fingerprint) {
    throw new BackupV2FailClosedError("BACKUP_V2_CATALOG_CHANGED", "Catalog changed after preflight");
  }
}
