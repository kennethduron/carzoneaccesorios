import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AppRole, Permission } from "@/types/auth";
import type { AdminSecurityData, AuditLogRow, BackupLogRow } from "@/types/security";

type AuditLogQueryRow = Omit<AuditLogRow, "user_email" | "user_name"> & {
  users: {
    email: string | null;
    full_name: string | null;
  } | null;
};

type BackupLogQueryRow = Omit<BackupLogRow, "requested_by_email"> & {
  users: {
    email: string | null;
  } | null;
};

type RoleQueryRow = {
  name: AppRole;
  permissions: Permission[];
};

function normalizeAuditLog(row: AuditLogQueryRow): AuditLogRow {
  return {
    ...row,
    user_email: row.users?.email ?? null,
    user_name: row.users?.full_name ?? null,
  };
}

function normalizeBackupLog(row: BackupLogQueryRow): BackupLogRow {
  return {
    ...row,
    requested_by_email: row.users?.email ?? null,
  };
}

export async function getAdminSecurity(): Promise<AdminSecurityData> {
  const supabase = await getSupabaseServerClient();

  const [
    { data: roles, error: rolesError },
    { data: auditLogs, error: auditError },
    { data: backupLogs, error: backupError },
  ] = await Promise.all([
    supabase.from("roles").select("name, permissions").order("name").returns<RoleQueryRow[]>(),
    supabase
      .from("audit_logs")
      .select("id, user_id, table_name, record_id, action, old_data, new_data, created_at, users(email, full_name)")
      .order("created_at", { ascending: false })
      .limit(100)
      .returns<AuditLogQueryRow[]>(),
    supabase
      .from("backup_logs")
      .select("id, requested_by, backup_type, status, storage_location, notes, started_at, completed_at, created_at, users(email)")
      .order("created_at", { ascending: false })
      .limit(50)
      .returns<BackupLogQueryRow[]>(),
  ]);

  if (rolesError) {
    throw new Error(rolesError.message);
  }

  if (auditError) {
    throw new Error(auditError.message);
  }

  if (backupError) {
    throw new Error(backupError.message);
  }

  return {
    roles: (roles ?? []).map((role) => ({
      role: role.name,
      permissions: role.permissions,
    })),
    auditLogs: (auditLogs ?? []).map(normalizeAuditLog),
    backupLogs: (backupLogs ?? []).map(normalizeBackupLog),
  };
}
