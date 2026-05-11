import type { AppRole, Permission } from "@/types/auth";

export type AuditLogRow = {
  id: string;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  actor_role: string | null;
  table_name: string;
  record_id: string | null;
  action: string;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  created_at: string;
};

export type BackupStatus = "requested" | "running" | "completed" | "failed";
export type BackupType = "manual" | "scheduled" | "pre_deploy";

export type BackupLogRow = {
  id: string;
  requested_by: string | null;
  requested_by_email: string | null;
  backup_type: BackupType;
  status: BackupStatus;
  storage_location: string | null;
  notes: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
};

export type SecurityRoleSummary = {
  role: AppRole;
  permissions: Permission[];
};

export type AdminSecurityData = {
  roles: SecurityRoleSummary[];
  auditLogs: AuditLogRow[];
  backupLogs: BackupLogRow[];
};
