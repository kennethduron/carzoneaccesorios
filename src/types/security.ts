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
  ip_address: string | null;
  user_agent: string | null;
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

export type AdminUserSummary = {
  id: string;
  email: string | null;
  full_name: string | null;
  username: string | null;
  phone: string | null;
  role: AppRole;
  active: boolean;
  created_at: string;
  updated_at: string;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  customer_id: string | null;
  customer_status: string | null;
  customer_wholesale_status: string | null;
  customer_business_name: string | null;
  order_count: number;
  invoice_count: number;
  wholesale_request_count: number;
  recent_orders: Array<{
    id: string;
    order_number: string;
    status: string;
    price_mode: string;
    total: number;
    created_at: string;
  }>;
};

export type AdminSecurityData = {
  roles: SecurityRoleSummary[];
  users: AdminUserSummary[];
  auditLogs: AuditLogRow[];
  backupLogs: BackupLogRow[];
};
