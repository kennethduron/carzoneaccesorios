import {
  BACKUP_V2_STATES, BACKUP_V2_TERMINAL_STATES, BackupV2FailClosedError,
  type BackupV2State, type BackupV2TerminalState, type RetryMode, requireBackupV2State,
} from "./types.ts";

export const BACKUP_V2_TRANSITIONS: Readonly<Record<BackupV2State, readonly BackupV2State[]>> = {
  requested: ["preflight", "failed", "cancelled"],
  preflight: ["running", "failed", "cancelled"],
  running: ["validating", "failed", "cancelled"],
  validating: ["completed", "completed_with_warnings", "failed", "cancelled"],
  completed: [], completed_with_warnings: [], failed: [], cancelled: [],
};

const SAME_ARTIFACT_RETRY_OPERATIONS = [
  "primary_upload", "primary_verification", "secondary_upload", "secondary_verification",
] as const;
const FRESH_ATTEMPT_OPERATIONS = [
  "catalog_discovery", "snapshot", "export", "consistency_validation", "archive", "encryption",
] as const;
export type RetryableOperation =
  | (typeof SAME_ARTIFACT_RETRY_OPERATIONS)[number]
  | (typeof FRESH_ATTEMPT_OPERATIONS)[number];

export function isTerminalState(value: unknown): value is BackupV2TerminalState {
  const state = requireBackupV2State(value);
  return BACKUP_V2_TERMINAL_STATES.includes(state as (typeof BACKUP_V2_TERMINAL_STATES)[number]);
}

export function allowedTransitions(value: unknown): readonly BackupV2State[] {
  return BACKUP_V2_TRANSITIONS[requireBackupV2State(value)];
}

export function transitionBackupV2State(currentValue: unknown, nextValue: unknown): BackupV2State {
  const current = requireBackupV2State(currentValue);
  const next = requireBackupV2State(nextValue);
  if (isTerminalState(current)) {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_TERMINAL_STATE_IMMUTABLE", `Terminal state ${current} cannot transition to ${next}`,
    );
  }
  if (!BACKUP_V2_TRANSITIONS[current].includes(next)) {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_INVALID_TRANSITION", `Lifecycle transition ${current} -> ${next} is not allowed`,
    );
  }
  return next;
}

export function retryModeForOperation(value: unknown): RetryMode {
  if (typeof value === "string" && SAME_ARTIFACT_RETRY_OPERATIONS.includes(
    value as (typeof SAME_ARTIFACT_RETRY_OPERATIONS)[number],
  )) return "same_artifact_operation";
  if (typeof value === "string" && FRESH_ATTEMPT_OPERATIONS.includes(
    value as (typeof FRESH_ATTEMPT_OPERATIONS)[number],
  )) return "fresh_backup_attempt";
  throw new BackupV2FailClosedError(
    "BACKUP_V2_UNKNOWN_RETRY_OPERATION", `Rejected unknown retry operation: ${String(value)}`,
  );
}

export function assertStateMachineIsComplete(): void {
  for (const state of BACKUP_V2_STATES) {
    if (!(state in BACKUP_V2_TRANSITIONS)) {
      throw new BackupV2FailClosedError(
        "BACKUP_V2_STATE_MACHINE_INCOMPLETE", `No transition definition exists for ${state}`,
      );
    }
  }
}
