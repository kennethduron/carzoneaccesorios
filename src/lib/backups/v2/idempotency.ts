import { createHash } from "node:crypto";
import { BackupV2FailClosedError, requireBackupV2Scope, type BackupV2Scope } from "./types.ts";

export interface SemanticBackupRequest {
  policyVersion: string; sourceEnvironment: string; generationBoundary: string;
  scopes: readonly BackupV2Scope[]; triggerType: "manual" | "scheduled" | "system";
  manualRequestId?: string | null; executionId?: string | null;
}

const SEMANTIC_FIELD = /^[A-Za-z0-9._:@/-]{1,160}$/;

export function canonicalScopeSet(scopes: readonly BackupV2Scope[]): readonly BackupV2Scope[] {
  const normalized = [...new Set(scopes.map(requireBackupV2Scope))].sort();
  if (normalized.length === 0) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_REQUEST_KEY_INPUT", "Request scope is missing");
  }
  return normalized;
}

export function canonicalSemanticRequest(input: SemanticBackupRequest): string {
  const policyVersion = input.policyVersion.trim();
  const sourceEnvironment = input.sourceEnvironment.trim().toLowerCase();
  const manualRequestId = input.manualRequestId?.trim() || null;
  if (!SEMANTIC_FIELD.test(policyVersion) || !SEMANTIC_FIELD.test(sourceEnvironment) ||
      !Number.isFinite(Date.parse(input.generationBoundary)) ||
      !["manual", "scheduled", "system"].includes(input.triggerType) ||
      (input.triggerType === "manual" && (manualRequestId === null || !SEMANTIC_FIELD.test(manualRequestId))) ||
      (manualRequestId !== null && !SEMANTIC_FIELD.test(manualRequestId))) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_REQUEST_KEY_INPUT", "Semantic request inputs are invalid");
  }
  const scopes = canonicalScopeSet(input.scopes);
  return [
    "backup-v2-semantic-v1", `policyVersion=${policyVersion}`, `sourceEnvironment=${sourceEnvironment}`,
    `generationBoundary=${new Date(input.generationBoundary).toISOString()}`, `scopes=${scopes.join(",")}`,
    `triggerType=${input.triggerType}`, `manualRequestId=${manualRequestId ?? "-"}`,
  ].join("\n");
}

export function semanticRequestKey(input: SemanticBackupRequest): string {
  const canonical = canonicalSemanticRequest(input);
  return `backup-v2:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function generationKey(input: SemanticBackupRequest): string {
  return semanticRequestKey(input).replace("backup-v2:", "backup-v2-generation:");
}
