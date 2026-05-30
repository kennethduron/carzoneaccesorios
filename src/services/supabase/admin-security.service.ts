import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { internalRoleLabel, isInternalRole } from "@/lib/auth/roles";
import { effectivePermissions, effectiveRole, isProtectedTechnicalEmail } from "@/lib/auth/permissions";
import type { AppRole, AuthProfile, Permission } from "@/types/auth";
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

type CustomerProfileLinkRow = {
  id: string;
  user_id: string | null;
  status: string | null;
  wholesale_status: string | null;
  business_name: string | null;
  contact_name: string | null;
};

type SecurityOrderRow = {
  id: string;
  user_id: string | null;
  customer_id: string | null;
  order_number: string;
  status: string;
  price_mode: string;
  total: unknown;
  created_at: string;
};

type SecurityCountRow = {
  id: string;
  customer_id: string | null;
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

function pushToMap<T>(map: Map<string, T[]>, key: string | null | undefined, value: T) {
  if (!key) {
    return;
  }

  const current = map.get(key) ?? [];
  current.push(value);
  map.set(key, current);
}

function operationalAuditOnly(log: AuditLogRow) {
  if (log.actor_role === "technical_owner" || log.actor_role === "admin") {
    return false;
  }

  if (["error_logs", "notification_logs", "backup_logs", "operational_cron_runs"].includes(log.table_name)) {
    return false;
  }

  const serialized = `${JSON.stringify(log.old_data ?? {})} ${JSON.stringify(log.new_data ?? {})}`.toLowerCase();
  if (serialized.includes(protectedTechnicalEmail)) {
    return false;
  }

  return true;
}

const businessOwnerVisibleRoles = new Set(["cliente", "vendedor", "bodega", "contadora", "soporte"]);
const protectedTechnicalEmail = "kennethduron.paz@gmail.com";

function isVisibleToBusinessOwner(user: UserQueryRow) {
  const role = user.roles?.name ?? "cliente";
  return businessOwnerVisibleRoles.has(role) && !isProtectedTechnicalEmail(user.email);
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

export async function getAdminSecurity(profile?: AuthProfile): Promise<AdminSecurityData> {
  const supabase = await getSupabaseServerClient();
  const admin = getSupabaseAdminClient();
  const ownerView = profile?.role === "business_owner";

  const [
    { data: roles, error: rolesError },
    { data: users, error: usersError },
    { data: customers, error: customersError },
    { data: orders, error: ordersError },
    { data: invoices, error: invoicesError },
    { data: wholesaleCodes, error: wholesaleCodesError },
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
    admin
      .from("customers")
      .select("id, user_id, status, wholesale_status, business_name, contact_name")
      .limit(500)
      .returns<CustomerProfileLinkRow[]>(),
    admin
      .from("orders")
      .select("id, user_id, customer_id, order_number, status, price_mode, total, created_at")
      .order("created_at", { ascending: false })
      .limit(500)
      .returns<SecurityOrderRow[]>(),
    admin.from("invoices").select("id, customer_id").limit(500).returns<SecurityCountRow[]>(),
    admin.from("wholesale_codes").select("id, customer_id").limit(500).returns<SecurityCountRow[]>(),
    supabase
      .from("audit_logs")
      .select("id, user_id, actor_role, table_name, record_id, action, old_data, new_data, ip_address, user_agent, created_at, users(email, full_name)")
      .order("created_at", { ascending: false })
      .limit(250)
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
  if (customersError) {
    throw new Error(customersError.message);
  }
  if (ordersError) {
    throw new Error(ordersError.message);
  }
  if (invoicesError) {
    throw new Error(invoicesError.message);
  }
  if (wholesaleCodesError) {
    throw new Error(wholesaleCodesError.message);
  }

  if (auditError) {
    throw new Error(auditError.message);
  }

  if (backupError) {
    throw new Error(backupError.message);
  }

  const customersByUserId = new Map<string, CustomerProfileLinkRow>();
  const customersById = new Map<string, CustomerProfileLinkRow>();
  for (const customer of customers ?? []) {
    customersById.set(customer.id, customer);
    if (customer.user_id) {
      customersByUserId.set(customer.user_id, customer);
    }
  }

  const ordersByUserId = new Map<string, SecurityOrderRow[]>();
  const ordersByCustomerId = new Map<string, SecurityOrderRow[]>();
  for (const order of orders ?? []) {
    pushToMap(ordersByUserId, order.user_id, order);
    pushToMap(ordersByCustomerId, order.customer_id, order);
  }

  const invoiceCountByCustomerId = new Map<string, number>();
  for (const invoice of invoices ?? []) {
    if (invoice.customer_id) {
      invoiceCountByCustomerId.set(invoice.customer_id, (invoiceCountByCustomerId.get(invoice.customer_id) ?? 0) + 1);
    }
  }

  const wholesaleRequestCountByCustomerId = new Map<string, number>();
  for (const code of wholesaleCodes ?? []) {
    if (code.customer_id) {
      wholesaleRequestCountByCustomerId.set(code.customer_id, (wholesaleRequestCountByCustomerId.get(code.customer_id) ?? 0) + 1);
    }
  }

  const visibleRoles = ownerView
    ? (roles ?? []).filter((role) => businessOwnerVisibleRoles.has(role.name))
    : roles ?? [];
  const visibleAuditLogs = ownerView ? (auditLogs ?? []).map(normalizeAuditLog).filter(operationalAuditOnly) : (auditLogs ?? []).map(normalizeAuditLog);

  return {
    roles: visibleRoles.map((role) => ({
      role: role.name,
      permissions: effectivePermissions(role.name),
    })),
    users: (users ?? [])
      .filter((user) => !ownerView || isVisibleToBusinessOwner(user))
      .map((user): AdminUserSummary => {
      const authUser = authUsers.get(user.id);
      const userEmail = user.email ?? authUser?.email ?? null;
      const role = effectiveRole(user.roles?.name ?? "cliente", userEmail);
      const customerId = getCustomerId(user.customers);
      const customer = (customerId ? customersById.get(customerId) : null) ?? customersByUserId.get(user.id) ?? null;
      const relatedOrders = [
        ...(ordersByUserId.get(user.id) ?? []),
        ...(customer?.id ? ordersByCustomerId.get(customer.id) ?? [] : []),
      ];
      const dedupedOrders = Array.from(new Map(relatedOrders.map((order) => [order.id, order])).values()).sort(
        (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime(),
      );

      return {
        id: user.id,
        email: userEmail,
        username: user.username,
        full_name: user.full_name,
        phone: user.phone,
        role,
        profile_kind: isInternalRole(role) ? "internal" : "customer",
        profile_label: isInternalRole(role) ? internalRoleLabel(role) : "Cliente",
        active: user.active,
        created_at: user.created_at,
        updated_at: user.updated_at,
        last_sign_in_at: authUser?.last_sign_in_at ?? null,
        email_confirmed_at: authUser?.email_confirmed_at ?? authUser?.confirmed_at ?? null,
        customer_id: customer?.id ?? customerId,
        customer_status: customer?.status ?? null,
        customer_wholesale_status: customer?.wholesale_status ?? null,
        customer_business_name: customer?.business_name ?? customer?.contact_name ?? null,
        order_count: dedupedOrders.length,
        invoice_count: customer?.id ? invoiceCountByCustomerId.get(customer.id) ?? 0 : 0,
        wholesale_request_count: customer?.id ? wholesaleRequestCountByCustomerId.get(customer.id) ?? 0 : 0,
        recent_orders: dedupedOrders.slice(0, 5).map((order) => ({
          id: order.id,
          order_number: order.order_number,
          status: order.status,
          price_mode: order.price_mode,
          total: Number(order.total ?? 0),
          created_at: order.created_at,
        })),
      };
    }),
    auditLogs: visibleAuditLogs,
    backupLogs: ownerView ? [] : (backupLogs ?? []).map(normalizeBackupLog),
  };
}
