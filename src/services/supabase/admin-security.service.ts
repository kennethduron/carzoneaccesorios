import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AppRole, Permission } from "@/types/auth";
import type { AdminSecurityData, AdminUserSummary, AuditLogRow, BackupLogRow } from "@/types/security";

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

type UserQueryRow = {
  id: string;
  email: string | null;
  username: string | null;
  full_name: string | null;
  phone: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  roles: {
    name: AppRole;
  } | null;
  customers: Array<{ id: string }> | { id: string } | null;
};

type AuthUserMetadata = {
  id: string;
  email?: string;
  last_sign_in_at?: string | null;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
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

function getCustomerId(customers: UserQueryRow["customers"]) {
  if (!customers) {
    return null;
  }

  if (Array.isArray(customers)) {
    return customers[0]?.id ?? null;
  }

  return customers.id ?? null;
}

async function getAuthUserMap() {
  const admin = getSupabaseAdminClient();
  const users = new Map<string, AuthUserMetadata>();
  const maxPages = 50;

  for (let page = 1; page <= maxPages; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });

    if (error) {
      throw new Error(error.message);
    }

    for (const user of data.users ?? []) {
      users.set(user.id, {
        id: user.id,
        email: user.email,
        last_sign_in_at: user.last_sign_in_at ?? null,
        email_confirmed_at: user.email_confirmed_at ?? user.confirmed_at ?? null,
        confirmed_at: user.confirmed_at ?? null,
      });
    }

    if (!data.users || data.users.length < 100) {
      break;
    }
  }

  return users;
}

export async function getAdminSecurity(): Promise<AdminSecurityData> {
  const supabase = await getSupabaseServerClient();
  const admin = getSupabaseAdminClient();

  const [
    { data: roles, error: rolesError },
    { data: users, error: usersError },
    { data: auditLogs, error: auditError },
    { data: backupLogs, error: backupError },
    authUsers,
  ] = await Promise.all([
    supabase.from("roles").select("name, permissions").order("name").returns<RoleQueryRow[]>(),
    admin
      .from("users")
      .select("id, email, username, full_name, phone, active, created_at, updated_at, roles(name), customers(id)")
      .order("created_at", { ascending: false })
      .limit(200)
      .returns<UserQueryRow[]>(),
    supabase
      .from("audit_logs")
      .select("id, user_id, actor_role, table_name, record_id, action, old_data, new_data, created_at, users(email, full_name)")
      .order("created_at", { ascending: false })
      .limit(100)
      .returns<AuditLogQueryRow[]>(),
    supabase
      .from("backup_logs")
      .select("id, requested_by, backup_type, status, storage_location, notes, started_at, completed_at, created_at, users(email)")
      .order("created_at", { ascending: false })
      .limit(50)
      .returns<BackupLogQueryRow[]>(),
    getAuthUserMap(),
  ]);

  if (rolesError) {
    throw new Error(rolesError.message);
  }

  if (usersError) {
    throw new Error(usersError.message);
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
    users: (users ?? []).map((user): AdminUserSummary => {
      const authUser = authUsers.get(user.id);

      return {
        id: user.id,
        email: user.email ?? authUser?.email ?? null,
        username: user.username,
        full_name: user.full_name,
        phone: user.phone,
        role: user.roles?.name ?? "cliente",
        active: user.active,
        created_at: user.created_at,
        updated_at: user.updated_at,
        last_sign_in_at: authUser?.last_sign_in_at ?? null,
        email_confirmed_at: authUser?.email_confirmed_at ?? authUser?.confirmed_at ?? null,
        customer_id: getCustomerId(user.customers),
      };
    }),
    auditLogs: (auditLogs ?? []).map(normalizeAuditLog),
    backupLogs: (backupLogs ?? []).map(normalizeBackupLog),
  };
}
