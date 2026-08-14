import { BackupV2FailClosedError } from "./types.ts";

export interface BackupV2Lease {
  ownerRef: string; acquiredAt: string; heartbeatAt: string; expiresAt: string; generation: number;
}
export function validateLease(value: BackupV2Lease, now: string): BackupV2Lease {
  const nowMs = Date.parse(now); const acquired = Date.parse(value.acquiredAt);
  const heartbeat = Date.parse(value.heartbeatAt); const expires = Date.parse(value.expiresAt);
  if (!value.ownerRef.trim() || !Number.isSafeInteger(value.generation) || value.generation <= 0 ||
      ![nowMs, acquired, heartbeat, expires].every(Number.isFinite) || acquired > heartbeat || heartbeat >= expires) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_LEASE", "Lease evidence is invalid");
  }
  return value;
}
export function assertLeaseAuthority(
  lease: BackupV2Lease, ownerRef: string, generation: number, now: string,
): void {
  validateLease(lease, now);
  if (lease.ownerRef !== ownerRef || lease.generation !== generation || Date.parse(lease.expiresAt) <= Date.parse(now)) {
    throw new BackupV2FailClosedError("BACKUP_V2_LEASE_NOT_AUTHORITATIVE", "Worker no longer owns this lease");
  }
}
