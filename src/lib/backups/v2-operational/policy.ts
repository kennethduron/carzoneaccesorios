import "server-only";

import { simplifiedArtifactBinding } from "../v2-simplified/core.ts";
import { BackupV2FailClosedError } from "../v2/types.ts";

export const FIRST_RECOVERY_PROVEN_GENERATION =
  "backup-v2-generation:8054c4517784a60b6e8291bbd60eda1a1dc8c761f479422a3b79c4c16a96edd1";
export const B2_SOFT_BUDGET_BYTES = BigInt(8_000_000_000);
export const BUDGET_UPLOAD_RESERVE_BYTES = BigInt(64 * 1024 * 1024);
export const RETENTION_POLICY = Object.freeze({ daily: 7, weekly: 4, monthly: 3 });

const RUN_ID = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_([0-9a-f-]{36})$/;
const OBJECT_KEY = /^car-zone\/v2-simplified\/([^/]+)\/(database|auth|storage_metadata|storage_objects|external_assets|manifest)\/([^/]+)$/;
const REQUIRED_COMPONENTS = ["database", "auth", "storage_metadata", "storage_objects", "external_assets"] as const;

export interface RemoteObjectEvidence {
  readonly key: string;
  readonly sizeBytes: bigint;
}

export interface OperationalGeneration {
  readonly runId: string;
  readonly generationId: string;
  readonly createdAt: string;
  readonly objectCount: number;
  readonly totalBytes: bigint;
  readonly valid: boolean;
}

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

function timestampFromRunId(runId: string): string {
  const match = RUN_ID.exec(runId);
  if (!match) fail("BACKUP_V2_OPERATIONAL_REMOTE_INVENTORY_INVALID", "Remote run identity is invalid");
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}

function componentCompleteness(entries: readonly { component: string; filename: string }[]): boolean {
  for (const component of REQUIRED_COMPONENTS) {
    const files = entries.filter((entry) => entry.component === component).map((entry) => entry.filename);
    if (files.length !== 2 || !files.some((file) => file.endsWith(".czb2")) ||
        !files.some((file) => file.endsWith(".json"))) return false;
  }
  const manifestFiles = entries.filter((entry) => entry.component === "manifest").map((entry) => entry.filename).sort();
  return manifestFiles.length === 2 && manifestFiles.includes("backup-index.json") &&
    manifestFiles.includes("backup-manifest.czb2");
}

export function inventoryOperationalGenerations(objects: readonly RemoteObjectEvidence[]): readonly OperationalGeneration[] {
  const grouped = new Map<string, { entries: { component: string; filename: string }[]; bytes: bigint }>();
  for (const object of objects) {
    if (object.sizeBytes < BigInt(0)) fail("BACKUP_V2_OPERATIONAL_REMOTE_INVENTORY_INVALID", "Remote object size is invalid");
    const match = OBJECT_KEY.exec(object.key);
    if (!match) continue;
    const group = grouped.get(match[1]) ?? { entries: [], bytes: BigInt(0) };
    group.entries.push({ component: match[2], filename: match[3] });
    group.bytes += object.sizeBytes;
    grouped.set(match[1], group);
  }
  return Object.freeze([...grouped.entries()].map(([runId, group]) => Object.freeze({
    runId,
    generationId: simplifiedArtifactBinding(runId),
    createdAt: timestampFromRunId(runId),
    objectCount: group.entries.length,
    totalBytes: group.bytes,
    valid: componentCompleteness(group.entries),
  })).sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
}

function localDateParts(iso: string): { date: string; month: string; week: string } {
  const instant = new Date(iso);
  const local = new Date(instant.getTime() - 6 * 60 * 60 * 1000);
  const date = local.toISOString().slice(0, 10);
  const month = date.slice(0, 7);
  const day = new Date(`${date}T00:00:00.000Z`);
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil((((day.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return { date, month, week: `${day.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}` };
}

function newestByWindow(generations: readonly OperationalGeneration[], field: "date" | "week" | "month", count: number): string[] {
  const selected = new Map<string, string>();
  for (const generation of generations) {
    const key = localDateParts(generation.createdAt)[field];
    if (!selected.has(key)) selected.set(key, generation.generationId);
    if (selected.size === count) break;
  }
  return [...selected.values()];
}

export function planOperationalRetention(input: {
  readonly generations: readonly OperationalGeneration[];
  readonly successfulScheduledGenerations: number;
  readonly requestedMode: "DRY_RUN" | "ACTIVE";
}): {
  readonly mode: "DRY_RUN" | "ACTIVE";
  readonly retainedGenerationIds: readonly string[];
  readonly deletionCandidateGenerationIds: readonly string[];
  readonly latestTwoProtected: true;
  readonly firstProvenGenerationPinned: true;
  readonly destructiveEligible: boolean;
} {
  const valid = input.generations.filter((generation) => generation.valid);
  if (!valid.some((generation) => generation.generationId === FIRST_RECOVERY_PROVEN_GENERATION)) {
    fail("BACKUP_V2_OPERATIONAL_PINNED_GENERATION_MISSING", "The first recovery-proven generation is not present and valid");
  }
  const latestTwo = valid.slice(0, 2).map((generation) => generation.generationId);
  const retained = new Set<string>([
    FIRST_RECOVERY_PROVEN_GENERATION,
    ...latestTwo,
    ...newestByWindow(valid, "date", RETENTION_POLICY.daily),
    ...newestByWindow(valid, "week", RETENTION_POLICY.weekly),
    ...newestByWindow(valid, "month", RETENTION_POLICY.monthly),
  ]);
  const deletionCandidates = valid
    .filter((generation) => !retained.has(generation.generationId))
    .map((generation) => generation.generationId);
  const destructiveEligible = input.requestedMode === "ACTIVE" && input.successfulScheduledGenerations >= 3;
  return Object.freeze({
    mode: destructiveEligible ? "ACTIVE" : "DRY_RUN",
    retainedGenerationIds: Object.freeze([...retained]),
    deletionCandidateGenerationIds: Object.freeze(deletionCandidates),
    latestTwoProtected: true,
    firstProvenGenerationPinned: true,
    destructiveEligible,
  });
}

export function assertOperationalBudget(input: {
  readonly currentUsageBytes: bigint;
  readonly estimatedSourceBytes: bigint;
  readonly softBudgetBytes: bigint;
  readonly reserveBytes?: bigint;
}): { readonly projectedBytes: bigint; readonly remainingBytes: bigint } {
  const reserve = input.reserveBytes ?? BUDGET_UPLOAD_RESERVE_BYTES;
  if (input.currentUsageBytes < BigInt(0) || input.estimatedSourceBytes < BigInt(0) || reserve < BigInt(0) ||
      input.softBudgetBytes !== B2_SOFT_BUDGET_BYTES) {
    fail("BACKUP_V2_OPERATIONAL_BUDGET_INVALID", "Operational B2 budget inputs are invalid");
  }
  const projectedBytes = input.currentUsageBytes + input.estimatedSourceBytes + reserve;
  if (projectedBytes > input.softBudgetBytes) {
    fail("BACKUP_V2_OPERATIONAL_BUDGET_BLOCKED", "B2 soft budget cannot safely accommodate another generation");
  }
  return Object.freeze({ projectedBytes, remainingBytes: input.softBudgetBytes - projectedBytes });
}

export function sanitizeOperationalText(value: unknown, maximum = 300): string {
  const source = typeof value === "string" ? value : "Operational backup failure";
  return source
    .replace(/[\r\n\t]+/g, " ")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/(?:authorization|password|secret|token|api[_-]?key|application[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z0-9+/]{43}=/g, "[REDACTED_KEY]")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, maximum);
}
