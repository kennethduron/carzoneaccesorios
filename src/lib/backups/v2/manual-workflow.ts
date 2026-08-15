import "server-only";

import {
  BACKUP_V2_B2_MANAGED_PREFIX,
  CAR_ZONE_B2_BUCKET,
  CAR_ZONE_B2_DESTINATION_ID,
  CAR_ZONE_B2_ENDPOINT,
  CAR_ZONE_B2_FAILURE_DOMAIN_ID,
  CAR_ZONE_B2_REGION,
  BACKUP_V2_B2_ENV_NAMES,
  backblazeB2ConfigFingerprint,
  inspectBackblazeB2Environment,
  parsePositiveByteBudget,
} from "./b2-config.ts";
import { planBackupV2Capacity } from "./b2-capacity-planner.ts";
import { BACKUP_V2_SCOPES } from "./types.ts";
import { BackupV2FailClosedError } from "./types.ts";

export const BACKUP_V2_MANUAL_MODES = [
  "plan",
  "provider_preflight",
  "synthetic_execute",
  "real_execute",
] as const;
export type BackupV2ManualMode = (typeof BACKUP_V2_MANUAL_MODES)[number];

export const PHASE_4B5_INITIAL_MANUAL_EXECUTOR = "LOCAL_TRUSTED_OPERATOR" as const;
export const PHASE_4B5_REAL_EXECUTION_STATUS = "BLOCKED_UNTIL_PHASE_4B6" as const;

export interface Phase4B5ManualPlan {
  readonly mode: "plan";
  readonly provider: "backblaze-b2";
  readonly providerRole: "primary";
  readonly executionSurface: typeof PHASE_4B5_INITIAL_MANUAL_EXECUTOR;
  readonly destination: {
    readonly endpoint: typeof CAR_ZONE_B2_ENDPOINT;
    readonly region: typeof CAR_ZONE_B2_REGION;
    readonly bucket: typeof CAR_ZONE_B2_BUCKET;
    readonly destinationId: typeof CAR_ZONE_B2_DESTINATION_ID;
    readonly failureDomainId: typeof CAR_ZONE_B2_FAILURE_DOMAIN_ID;
    readonly managedPrefix: typeof BACKUP_V2_B2_MANAGED_PREFIX;
    readonly configFingerprint: string;
  };
  readonly environment: ReturnType<typeof inspectBackblazeB2Environment>;
  readonly componentPlan: readonly {
    component: (typeof BACKUP_V2_SCOPES)[number];
    objectKeyPattern: string;
    encryptedBytes: null;
  }[];
  readonly capacity: ReturnType<typeof planBackupV2Capacity>;
  readonly readinessGates: readonly string[];
  readonly realExecution: typeof PHASE_4B5_REAL_EXECUTION_STATUS;
  readonly productionConnections: 0;
}

export function createPhase4B5ManualPlan(environment: NodeJS.ProcessEnv = process.env): Phase4B5ManualPlan {
  let configuredSoftBudgetBytes: bigint | null = null;
  try {
    configuredSoftBudgetBytes = parsePositiveByteBudget(environment[BACKUP_V2_B2_ENV_NAMES.softBudgetBytes]);
  } catch { /* Invalid or missing budget remains an explicit fail-closed planning blocker. */ }
  const componentPlan = BACKUP_V2_SCOPES.map((component) => Object.freeze({
    component,
    objectKeyPattern: `${BACKUP_V2_B2_MANAGED_PREFIX}{generation-sha256}/${component}/${component}-{artifact-sha256}.czb2`,
    encryptedBytes: null,
  }));
  return Object.freeze({
    mode: "plan",
    provider: "backblaze-b2",
    providerRole: "primary",
    executionSurface: PHASE_4B5_INITIAL_MANUAL_EXECUTOR,
    destination: Object.freeze({
      endpoint: CAR_ZONE_B2_ENDPOINT,
      region: CAR_ZONE_B2_REGION,
      bucket: CAR_ZONE_B2_BUCKET,
      destinationId: CAR_ZONE_B2_DESTINATION_ID,
      failureDomainId: CAR_ZONE_B2_FAILURE_DOMAIN_ID,
      managedPrefix: BACKUP_V2_B2_MANAGED_PREFIX,
      configFingerprint: backblazeB2ConfigFingerprint({
        endpoint: CAR_ZONE_B2_ENDPOINT,
        region: CAR_ZONE_B2_REGION,
        bucket: CAR_ZONE_B2_BUCKET,
        destinationId: CAR_ZONE_B2_DESTINATION_ID,
        failureDomainId: CAR_ZONE_B2_FAILURE_DOMAIN_ID,
      }),
    }),
    environment: inspectBackblazeB2Environment(environment),
    componentPlan: Object.freeze(componentPlan),
    capacity: planBackupV2Capacity({
      components: componentPlan.map(({ component }) => ({ component, encryptedBytes: null })),
      currentManagedBytes: null,
      softBudgetBytes: configuredSoftBudgetBytes,
    }),
    readinessGates: Object.freeze([
      "all_five_runtime_verified_encrypted_artifacts",
      "exact_encrypted_byte_counts",
      "bucket_restricted_application_key",
      "read_only_provider_preflight_authorized",
      "current_managed_capacity_measured",
      "positive_soft_budget_configured",
      "isolated_restore_procedure_ready",
      "phase_4b6_explicit_authorization",
    ]),
    realExecution: PHASE_4B5_REAL_EXECUTION_STATUS,
    productionConnections: 0,
  });
}

export function blockPhase4B5ProviderPreflight(): never {
  throw new BackupV2FailClosedError(
    "REAL_B2_PREFLIGHT_BLOCKED_UNTIL_CONTROLLED_RELEASE",
    "Real B2 provider preflight is blocked until an explicitly authorized controlled release",
  );
}

export function blockPhase4B5RealExecution(): never {
  throw new BackupV2FailClosedError(
    "REAL_BACKUP_V2_EXECUTION_BLOCKED_UNTIL_PHASE_4B6",
    "Real Backup V2 execution is blocked until Phase 4B.6",
  );
}
