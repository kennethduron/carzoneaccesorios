import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { internalRoleLabel, isInternalRole } from "@/lib/auth/roles";
import { getCustomerCreditAccount, getCustomerReceivables } from "@/services/supabase/credit.service";
import type { AppRole } from "@/types/auth";
import type {
  AdminCrmData,
  CrmCustomerOption,
  CrmCustomerProfile,
  CrmDuplicateGroup,
  CrmFollowupRow,
  CrmNoteRow,
} from "@/types/crm";
import { additionalFeesTotal } from "@/utils/financial-summary";
import { isSafeTestAccountEmail, normalizeAccountEmail } from "@/utils/test-accounts";

export type AdminCrmPageFilters = {
  customerPage?: number;
  followupPage?: number;
  pageSize?: number;
  followupTask?: "overdue" | null;
  wholesaleStatus?: "pending" | null;
  viewerRole?: AppRole;
};

export type AdminCrmPageData = AdminCrmData & {
  customersTotal: number;
  followupsTotal: number;
  customerPage: number;
  followupPage: number;
  pageSize: number;
};

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

type FollowupQueryRow = Omit<
  CrmFollowupRow,
  "customer_name" | "business_name" | "estimated_value" | "monthly_amount"
> & {
  estimated_value: unknown;
  monthly_amount: unknown;
  customers: {
    contact_name: string;
    business_name: string | null;
    user_id: string | null;
    users: { roles: { name: AppRole } | null } | null;
  } | null;
};

type NoteQueryRow = Omit<CrmNoteRow, "customer_name" | "business_name"> & {
  customers: {
    contact_name: string;
    business_name: string | null;
  } | null;
};

type CustomerQueryRow = Omit<
  CrmCustomerOption,
  | "estimated_value"
  | "monthly_amount"
  | "account_email"
  | "account_full_name"
  | "account_phone"
  | "account_active"
  | "account_created_at"
  | "account_role"
  | "profile_kind"
  | "profile_label"
  | "primary_badges"
  | "email_confirmed_at"
  | "confirmed_at"
  | "order_count"
  | "invoice_count"
  | "wholesale_code_count"
  | "total_spent"
  | "last_activity_at"
  | "account_state"
  | "customer_type"
  | "has_wholesale_request"
  | "is_test_account"
> & {
  estimated_value: unknown;
  monthly_amount: unknown;
  wholesale_status: CrmCustomerOption["wholesale_status"] | null;
  users: {
    id: string;
    email: string | null;
    full_name: string | null;
    phone: string | null;
    active: boolean;
    created_at: string;
    updated_at: string;
    roles: {
      name: AppRole;
    } | null;
  } | null;
};

type CustomerAuthMeta = {
  email_confirmed_at: string | null;
  confirmed_at: string | null;
};

type OrderActivityRow = {
  id: string;
  customer_id: string | null;
  user_id: string | null;
  email: string | null;
  created_at: string;
  total: unknown;
  subtotal: unknown;
  tax: unknown;
  shipping_fee: unknown;
  cash_on_delivery_fee: unknown;
  small_order_fee: unknown;
  discount_total: unknown;
  additional_fees: unknown;
  status: string | null;
  price_mode: "retail" | "wholesale" | null;
  payment_method?: string | null;
  payment_timing?: "before_delivery" | "on_delivery" | null;
};

type DuplicateCustomerQueryRow = {
  id: string;
  user_id: string | null;
  business_name: string | null;
  contact_name: string;
  email: string | null;
  phone: string | null;
  created_at: string;
};

type CustomerReferenceRow = {
  id: string;
  customer_id: string | null;
};

type CustomerProfileOrderRow = {
  id: string;
  order_number: string;
  tracking_code: string | null;
  customer_id: string | null;
  user_id: string | null;
  email: string | null;
  created_at: string;
  status: string;
  payment_method: string;
  payment_timing: "before_delivery" | "on_delivery";
  payments: Array<{
    payment_status: string | null;
    status: string | null;
    bank_reference_number: string | null;
    reference: string | null;
    transfer_receipt_url: string | null;
    transfer_receipt_public_id: string | null;
  }> | null;
  price_mode: "retail" | "wholesale";
  subtotal: unknown;
  tax: unknown;
  shipping_fee: unknown;
  cash_on_delivery_fee: unknown;
  small_order_fee: unknown;
  discount_total: unknown;
  additional_fees: unknown;
  total: unknown;
  invoices: Array<{ invoice_number: string | null; status: string | null }> | { invoice_number: string | null; status: string | null } | null;
};

type CustomerProfileInvoiceRow = {
  id: string;
  invoice_number: string;
  order_id: string;
  customer_id: string | null;
  status: string;
  subtotal: unknown;
  tax: unknown;
  shipping_fee: unknown;
  cash_on_delivery_fee: unknown;
  small_order_fee: unknown;
  discount_total: unknown;
  additional_fees: unknown;
  total: unknown;
  issued_at: string | null;
  created_at: string;
  orders: { order_number: string | null } | null;
};

type CustomerProfileWholesaleCodeRow = {
  id: string;
  code: string;
  label: string;
  minimum_order: unknown;
  max_uses: number | null;
  used_count: unknown;
  status: string;
  active: boolean;
  expires_at: string | null;
  last_used_at: string | null;
};

type CustomerWholesaleHistoryRow = {
  id: string;
  note: string;
  created_at: string;
  users: {
    full_name: string | null;
    email: string | null;
  } | null;
};

function normalizePhoneKey(value: string | null | undefined) {
  const digits = String(value ?? "").replace(/\D/g, "");

  if (!digits) {
    return null;
  }

  if (digits.length === 8) {
    return `+504${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("504")) {
    return `+${digits}`;
  }

  return `+${digits}`;
}

function latestDate(...values: Array<string | null | undefined>) {
  const dates = values
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);

  if (dates.length === 0) {
    return null;
  }

  return new Date(Math.max(...dates)).toISOString();
}

function customerUniqueKey(customer: CrmCustomerOption) {
  const email = customer.account_email ?? customer.email;
  const phone = customer.account_phone ?? customer.phone;

  if (customer.user_id) {
    return `user:${customer.user_id}`;
  }

  if (email) {
    return `email:${normalizeAccountEmail(email)}`;
  }

  const phoneKey = normalizePhoneKey(phone);
  if (phoneKey) {
    return `phone:${phoneKey}`;
  }

  return `id:${customer.id}`;
}

function preferCustomer(current: CrmCustomerOption, candidate: CrmCustomerOption) {
  if (candidate.is_wholesale !== current.is_wholesale) {
    return candidate.is_wholesale ? candidate : current;
  }

  if (candidate.order_count !== current.order_count) {
    return candidate.order_count > current.order_count ? candidate : current;
  }

  return new Date(candidate.created_at).getTime() < new Date(current.created_at).getTime() ? candidate : current;
}

function uniqueCustomers(customers: CrmCustomerOption[]) {
  const byKey = new Map<string, CrmCustomerOption>();

  for (const customer of customers) {
    const keys = new Set<string>([customerUniqueKey(customer)]);
    const email = customer.account_email ?? customer.email;
    const phoneKey = normalizePhoneKey(customer.account_phone ?? customer.phone);

    if (!customer.user_id && email) {
      keys.add(`email:${normalizeAccountEmail(email)}`);
    }
    if (!customer.user_id && phoneKey) {
      keys.add(`phone:${phoneKey}`);
    }

    const existing = Array.from(keys)
      .map((key) => byKey.get(key))
      .find(Boolean);
    const selected = existing ? preferCustomer(existing, customer) : customer;

    for (const key of keys) {
      byKey.set(key, selected);
    }
  }

  return Array.from(new Map(Array.from(byKey.values()).map((customer) => [customer.id, customer])).values());
}

function buildDuplicateGroups(
  customers: DuplicateCustomerQueryRow[],
  orderCounts: Map<string, number>,
  invoiceCounts: Map<string, number>,
): CrmDuplicateGroup[] {
  const groups = new Map<string, CrmDuplicateGroup>();

  function addCustomer(matchType: "email" | "phone", key: string | null, label: string, customer: DuplicateCustomerQueryRow) {
    if (!key) {
      return;
    }

    const groupKey = `${matchType}:${key}`;
    const group =
      groups.get(groupKey) ??
      ({
        key: groupKey,
        match_type: matchType,
        label,
        customers: [],
      } satisfies CrmDuplicateGroup);

    const email = customer.email ? normalizeAccountEmail(customer.email) : null;
    const orderCount = orderCounts.get(customer.id) ?? 0;
    const invoiceCount = invoiceCounts.get(customer.id) ?? 0;
    const isTestAccount = email ? isSafeTestAccountEmail(email) : false;

    group.customers.push({
      id: customer.id,
      display_name: customer.business_name ?? customer.contact_name,
      email: customer.email,
      phone: customer.phone,
      created_at: customer.created_at,
      order_count: orderCount,
      invoice_count: invoiceCount,
      is_test_account: isTestAccount,
      can_merge: invoiceCount === 0 || isTestAccount,
    });
    groups.set(groupKey, group);
  }

  for (const customer of customers) {
    addCustomer("email", customer.email ? normalizeAccountEmail(customer.email) : null, customer.email ?? "Correo electrónico repetido", customer);
    addCustomer("phone", normalizePhoneKey(customer.phone), normalizePhoneKey(customer.phone) ?? "Teléfono repetido", customer);
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      customers: group.customers.sort((a, b) => {
        if (a.invoice_count !== b.invoice_count) {
          return b.invoice_count - a.invoice_count;
        }
        if (a.order_count !== b.order_count) {
          return b.order_count - a.order_count;
        }
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      }),
    }))
    .filter((group) => group.customers.length > 1)
    .slice(0, 12);
}

function getAccountState(input: {
  active: boolean;
  status: CrmCustomerOption["status"];
  wholesaleStatus: CrmCustomerOption["wholesale_status"];
  accountActive: boolean | null;
  userId: string | null;
  emailConfirmedAt: string | null;
  isWholesale: boolean;
  hasWholesaleRequest: boolean;
  hasOrders: boolean;
  leadStatus: CrmCustomerOption["lead_status"];
  role: AppRole | null;
}) {
  if (input.role === "business_owner") {
    return "Business Owner" as const;
  }

  if (input.role === "technical_owner") {
    return "Technical Owner" as const;
  }

  if (isInternalRole(input.role)) {
    return "Usuario interno" as const;
  }

  if (!input.active || input.status === "disabled" || input.accountActive === false) {
    return "Cuenta suspendida" as const;
  }

  if (input.wholesaleStatus === "suspended") {
    return "Cuenta suspendida" as const;
  }

  if (input.wholesaleStatus === "approved" || (input.isWholesale && input.status === "active")) {
    return "Mayorista aprobado" as const;
  }

  if (input.wholesaleStatus === "pending" || input.hasWholesaleRequest || (input.isWholesale && input.status === "pending_account")) {
    return "Mayorista pendiente" as const;
  }

  if (input.userId && input.emailConfirmedAt && input.active) {
    return "Cliente activo" as const;
  }

  if (input.userId && input.emailConfirmedAt) {
    return "Correo electrónico confirmado" as const;
  }

  if (input.userId) {
    return "Correo electrónico pendiente de confirmar" as const;
  }

  if (input.hasOrders) {
    return "Compra sin cuenta" as const;
  }

  return input.leadStatus === "cliente" ? ("Cliente invitado" as const) : ("Prospecto" as const);
}

function normalizeCustomer(
  row: CustomerQueryRow,
  authByUserId: Map<string, CustomerAuthMeta>,
  ordersByCustomerId: Map<string, OrderActivityRow[]>,
  ordersByUserId: Map<string, OrderActivityRow[]>,
  ordersByEmail: Map<string, OrderActivityRow[]>,
  invoiceCountsByCustomerId: Map<string, number>,
  wholesaleCodeCountsByCustomerId: Map<string, number>,
): CrmCustomerOption {
  const accountEmail = row.users?.email ?? row.email;
  const accountRole = row.users?.roles?.name ?? null;
  const internal = isInternalRole(accountRole);
  const profileLabel = internal ? internalRoleLabel(accountRole) : row.is_wholesale ? "Cliente mayorista" : "Cliente al detalle";
  const normalizedEmail = accountEmail ? normalizeAccountEmail(accountEmail) : null;
  const relatedOrders = new Map<string, OrderActivityRow>();
  const byCustomer = ordersByCustomerId.get(row.id) ?? [];
  const byUser = row.user_id ? ordersByUserId.get(row.user_id) ?? [] : [];
  const byEmail = !row.user_id && normalizedEmail ? ordersByEmail.get(normalizedEmail) ?? [] : [];

  for (const order of [...byCustomer, ...byUser, ...byEmail]) {
    relatedOrders.set(order.id, order);
  }

  const latestOrderAt = latestDate(...Array.from(relatedOrders.values()).map((order) => order.created_at));
  const totalSpent = Array.from(relatedOrders.values()).reduce((sum, order) => sum + toNumber(order.total), 0);
  const hasWholesalePurchase =
    row.wholesale_first_purchase_completed ||
    Array.from(relatedOrders.values()).some((order) => {
    const status = String(order.status ?? "").trim().toLowerCase();
    return order.price_mode === "wholesale" && status !== "cancelado" && status !== "cancelled";
    });
  const authMeta = row.user_id ? authByUserId.get(row.user_id) : null;
  const emailConfirmedAt = authMeta?.email_confirmed_at ?? null;
  const confirmedAt = authMeta?.confirmed_at ?? null;
  const hasWholesaleRequest = Boolean(row.notes?.includes("[SOLICITUD_MAYOREO]")) && !row.is_wholesale;
  const wholesaleStatus =
    row.wholesale_status ??
    (row.is_wholesale && row.active && row.status === "active"
      ? "approved"
      : row.status === "pending_account" || hasWholesaleRequest
        ? "pending"
        : row.is_wholesale && (!row.active || row.status === "disabled")
          ? "suspended"
          : row.is_wholesale && row.status === "inactive"
            ? "rejected"
            : "none");
  const deleteBlockReason =
    relatedOrders.size > 0
      ? "No se puede eliminar esta cuenta porque tiene historial comercial o fiscal. Puedes suspenderla."
      : (invoiceCountsByCustomerId.get(row.id) ?? 0) > 0
        ? "No se puede eliminar esta cuenta porque tiene historial comercial o fiscal. Puedes suspenderla."
        : (wholesaleCodeCountsByCustomerId.get(row.id) ?? 0) > 0
            ? "No se puede eliminar esta cuenta porque tiene historial comercial o fiscal. Puedes suspenderla."
            : null;

  return {
    ...row,
    wholesale_status: wholesaleStatus,
    estimated_value: toNumber(row.estimated_value),
    monthly_amount: toNumber(row.monthly_amount),
    account_email: accountEmail ?? null,
    account_full_name: row.users?.full_name ?? null,
    account_phone: row.users?.phone ?? null,
    account_active: row.users?.active ?? null,
    account_created_at: row.users?.created_at ?? null,
    account_role: accountRole,
    profile_kind: internal ? "internal" : "customer",
    profile_label: profileLabel,
    primary_badges: internal
      ? accountRole === "business_owner"
        ? ["Business Owner", "Usuario interno"]
        : [profileLabel, "Usuario interno"]
      : row.is_wholesale
        ? ["Cliente mayorista"]
        : row.user_id
          ? ["Cliente al detalle"]
          : ["Prospecto"],
    email_confirmed_at: emailConfirmedAt,
    confirmed_at: confirmedAt,
    order_count: relatedOrders.size,
    invoice_count: invoiceCountsByCustomerId.get(row.id) ?? 0,
    wholesale_code_count: wholesaleCodeCountsByCustomerId.get(row.id) ?? 0,
    total_spent: totalSpent,
    last_activity_at: latestDate(latestOrderAt, row.updated_at, row.users?.updated_at),
    account_state: getAccountState({
      active: row.active,
      status: row.status,
      wholesaleStatus,
      accountActive: row.users?.active ?? null,
      userId: row.user_id,
      emailConfirmedAt,
      isWholesale: row.is_wholesale,
      hasWholesaleRequest,
      hasOrders: relatedOrders.size > 0,
      leadStatus: row.lead_status,
      role: accountRole,
    }),
    customer_type: !internal && wholesaleStatus === "approved" ? "Mayorista" : "Retail",
    has_wholesale_request: !internal && (wholesaleStatus === "pending" || hasWholesaleRequest),
    wholesale_first_purchase_completed: hasWholesalePurchase,
    wholesale_lifecycle_status:
      wholesaleStatus === "approved"
        ? row.wholesale_customer_type === "existing"
          ? "Mayorista activo"
          : hasWholesalePurchase
          ? "Mayorista activo"
          : "Pendiente de primera compra"
        : wholesaleStatus === "pending"
          ? "Sin acceso mayorista"
          : wholesaleStatus === "suspended" || wholesaleStatus === "rejected"
            ? "Sin acceso mayorista"
            : "Sin acceso mayorista",
    is_test_account: accountEmail ? isSafeTestAccountEmail(accountEmail) : false,
    can_delete_permanently: !deleteBlockReason,
    delete_block_reason: deleteBlockReason,
  };
}

function normalizeFollowup(row: FollowupQueryRow): CrmFollowupRow {
  const role = row.customers?.users?.roles?.name ?? null;
  const internal = isInternalRole(role);

  return {
    ...row,
    customer_name: row.customers?.contact_name ?? null,
    business_name: row.customers?.business_name ?? null,
    customer_account_role: role,
    customer_profile_kind: internal ? "internal" : "customer",
    customer_profile_label: internal ? internalRoleLabel(role) : "Cliente",
    estimated_value: toNumber(row.estimated_value),
    monthly_amount: toNumber(row.monthly_amount),
  };
}

function normalizeNote(row: NoteQueryRow): CrmNoteRow {
  return {
    ...row,
    customer_name: row.customers?.contact_name ?? null,
    business_name: row.customers?.business_name ?? null,
  };
}

function normalizePage(value: unknown) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizePageSize(value: unknown) {
  const pageSize = Number(value);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return 50;
  }

  return Math.min(Math.floor(pageSize), 100);
}

function canViewInternalProfiles(role: AppRole | undefined) {
  return role === "technical_owner" || role === "admin" || role === "business_owner";
}

export async function getAdminCrm(filters: AdminCrmPageFilters = {}): Promise<AdminCrmPageData> {
  const supabase = await getSupabaseServerClient();
  const admin = getSupabaseAdminClient();
  const customerPage = normalizePage(filters.customerPage);
  const followupPage = normalizePage(filters.followupPage);
  const pageSize = normalizePageSize(filters.pageSize);
  const customerFrom = (customerPage - 1) * pageSize;
  const followupFrom = (followupPage - 1) * pageSize;

  let customersQuery = supabase
    .from("customers")
    .select(
      "id, user_id, business_name, company_name, contact_name, email, phone, tax_id, city, notes, is_wholesale, wholesale_status, wholesale_requested_at, wholesale_request_source, wholesale_approved_at, wholesale_approved_notice_seen, wholesale_customer_type, wholesale_first_purchase_completed, wholesale_first_purchase_completed_at, status, active, lead_status, estimated_value, monthly_amount, created_at, updated_at, users(id, email, full_name, phone, active, created_at, updated_at, roles(name))",
      { count: "exact" },
    );

  if (filters.wholesaleStatus === "pending") {
    customersQuery = customersQuery.eq("wholesale_status", "pending");
  }

  let followupsQuery = supabase
    .from("crm_followups")
    .select(
      `
        id,
        customer_id,
        order_id,
        assigned_user_id,
        title,
        interaction_type,
        next_action,
        due_at,
        priority,
        phone,
        notes,
        estimated_value,
        monthly_amount,
        status,
        completed_at,
        created_at,
        customers(contact_name, business_name, user_id, users(roles(name)))
      `,
      { count: "exact" },
    );

  if (filters.followupTask === "overdue") {
    followupsQuery = followupsQuery.eq("status", "pending").not("due_at", "is", null).lt("due_at", new Date().toISOString());
  }

  const [
    { data: customers, error: customersError, count: customersTotal },
    { data: followups, error: followupsError, count: followupsTotal },
    { data: notes, error: notesError },
    { data: duplicateCustomers, error: duplicateCustomersError },
  ] = await Promise.all([
    customersQuery
      .order("created_at", { ascending: false })
      .range(customerFrom, customerFrom + pageSize - 1)
      .returns<CustomerQueryRow[]>(),
    followupsQuery
      .order("due_at", { ascending: true, nullsFirst: false })
      .range(followupFrom, followupFrom + pageSize - 1)
      .returns<FollowupQueryRow[]>(),
    supabase
      .from("crm_notes")
      .select("id, customer_id, user_id, note_type, note, archived_at, created_at, customers(contact_name, business_name)")
      .order("created_at", { ascending: false })
      .limit(50)
      .returns<NoteQueryRow[]>(),
    admin
      .from("customers")
      .select("id, user_id, business_name, contact_name, email, phone, created_at")
      .order("created_at", { ascending: false })
      .limit(1000)
      .returns<DuplicateCustomerQueryRow[]>(),
  ]);

  if (customersError) {
    throw new Error(customersError.message);
  }

  if (followupsError) {
    throw new Error(followupsError.message);
  }

  if (notesError) {
    throw new Error(notesError.message);
  }

  if (duplicateCustomersError) {
    throw new Error(duplicateCustomersError.message);
  }

  const customerRows = customers ?? [];
  const userIds = Array.from(new Set(customerRows.map((customer) => customer.user_id).filter((id): id is string => Boolean(id))));
  const customerIds = customerRows.map((customer) => customer.id);
  const emails = Array.from(
    new Set(
      customerRows
        .map((customer) => customer.users?.email ?? customer.email)
        .filter((email): email is string => Boolean(email))
        .map(normalizeAccountEmail),
    ),
  );

  const authByUserId = new Map<string, CustomerAuthMeta>();
  await Promise.all(
    userIds.map(async (userId) => {
      const { data } = await admin.auth.admin.getUserById(userId);
      if (data.user) {
        authByUserId.set(userId, {
          email_confirmed_at: data.user.email_confirmed_at ?? null,
          confirmed_at: data.user.confirmed_at ?? null,
        });
      }
    }),
  );

  const orderQueries: Array<() => Promise<{ data: OrderActivityRow[] | null; error: { message: string } | null }>> = [];
  if (customerIds.length > 0) {
    orderQueries.push(async () =>
      admin.from("orders").select("id, customer_id, user_id, email, created_at, subtotal, tax, shipping_fee, cash_on_delivery_fee, small_order_fee, discount_total, additional_fees, total, status, price_mode, payment_method, payment_timing").in("customer_id", customerIds).returns<OrderActivityRow[]>(),
    );
  }
  if (userIds.length > 0) {
    orderQueries.push(async () =>
      admin.from("orders").select("id, customer_id, user_id, email, created_at, subtotal, tax, shipping_fee, cash_on_delivery_fee, small_order_fee, discount_total, additional_fees, total, status, price_mode, payment_method, payment_timing").in("user_id", userIds).returns<OrderActivityRow[]>(),
    );
  }
  if (emails.length > 0) {
    orderQueries.push(async () =>
      admin.from("orders").select("id, customer_id, user_id, email, created_at, subtotal, tax, shipping_fee, cash_on_delivery_fee, small_order_fee, discount_total, additional_fees, total, status, price_mode, payment_method, payment_timing").in("email", emails).returns<OrderActivityRow[]>(),
    );
  }

  const ordersByCustomerId = new Map<string, OrderActivityRow[]>();
  const ordersByUserId = new Map<string, OrderActivityRow[]>();
  const ordersByEmail = new Map<string, OrderActivityRow[]>();
  const orderResults = await Promise.all(orderQueries.map((query) => query()));

  for (const result of orderResults) {
    if (result.error) {
      throw new Error(result.error.message);
    }

    for (const order of result.data ?? []) {
      if (order.customer_id) {
        ordersByCustomerId.set(order.customer_id, [...(ordersByCustomerId.get(order.customer_id) ?? []), order]);
      }
      if (order.user_id) {
        ordersByUserId.set(order.user_id, [...(ordersByUserId.get(order.user_id) ?? []), order]);
      }
      if (!order.user_id && order.email) {
        const normalizedEmail = normalizeAccountEmail(order.email);
        ordersByEmail.set(normalizedEmail, [...(ordersByEmail.get(normalizedEmail) ?? []), order]);
      }
    }
  }

  const invoiceCountsByCustomerId = new Map<string, number>();
  const wholesaleCodeCountsByCustomerId = new Map<string, number>();

  if (customerIds.length > 0) {
    const [{ data: customerInvoices, error: customerInvoicesError }, { data: customerWholesaleCodes, error: customerWholesaleCodesError }] =
      await Promise.all([
        admin.from("invoices").select("id, customer_id").in("customer_id", customerIds).returns<CustomerReferenceRow[]>(),
        admin
          .from("wholesale_codes")
          .select("id, customer_id, used_count, last_used_at")
          .in("customer_id", customerIds)
          .returns<Array<CustomerReferenceRow & { used_count: number | null; last_used_at: string | null }>>(),
      ]);

    if (customerInvoicesError) {
      throw new Error(customerInvoicesError.message);
    }

    if (customerWholesaleCodesError) {
      throw new Error(customerWholesaleCodesError.message);
    }

    for (const invoice of customerInvoices ?? []) {
      if (invoice.customer_id) {
        invoiceCountsByCustomerId.set(invoice.customer_id, (invoiceCountsByCustomerId.get(invoice.customer_id) ?? 0) + 1);
      }
    }

    for (const code of customerWholesaleCodes ?? []) {
      if (code.customer_id && (Number(code.used_count ?? 0) > 0 || code.last_used_at)) {
        wholesaleCodeCountsByCustomerId.set(code.customer_id, (wholesaleCodeCountsByCustomerId.get(code.customer_id) ?? 0) + 1);
      }
    }
  }

  const duplicateRows = duplicateCustomers ?? [];
  const duplicateIds = duplicateRows.map((customer) => customer.id);
  const duplicateOrderCounts = new Map<string, number>();
  const duplicateInvoiceCounts = new Map<string, number>();

  if (duplicateIds.length > 0) {
    const [{ data: duplicateOrders, error: duplicateOrdersError }, { data: duplicateInvoices, error: duplicateInvoicesError }] =
      await Promise.all([
        admin.from("orders").select("id, customer_id").in("customer_id", duplicateIds).returns<CustomerReferenceRow[]>(),
        admin.from("invoices").select("id, customer_id").in("customer_id", duplicateIds).returns<CustomerReferenceRow[]>(),
      ]);

    if (duplicateOrdersError) {
      throw new Error(duplicateOrdersError.message);
    }

    if (duplicateInvoicesError) {
      throw new Error(duplicateInvoicesError.message);
    }

    for (const order of duplicateOrders ?? []) {
      if (order.customer_id) {
        duplicateOrderCounts.set(order.customer_id, (duplicateOrderCounts.get(order.customer_id) ?? 0) + 1);
      }
    }

    for (const invoice of duplicateInvoices ?? []) {
      if (invoice.customer_id) {
        duplicateInvoiceCounts.set(invoice.customer_id, (duplicateInvoiceCounts.get(invoice.customer_id) ?? 0) + 1);
      }
    }
  }

  const normalizedCustomers = customerRows.map((customer) =>
    normalizeCustomer(
      customer,
      authByUserId,
      ordersByCustomerId,
      ordersByUserId,
      ordersByEmail,
      invoiceCountsByCustomerId,
      wholesaleCodeCountsByCustomerId,
    ),
  );
  const visibleCustomers = canViewInternalProfiles(filters.viewerRole)
    ? uniqueCustomers(normalizedCustomers)
    : uniqueCustomers(normalizedCustomers).filter((customer) => customer.profile_kind === "customer");
  const visibleCustomerIds = new Set(visibleCustomers.map((customer) => customer.id));
  const normalizedFollowups = (followups ?? []).map(normalizeFollowup);

  return {
    customers: visibleCustomers,
    followups: canViewInternalProfiles(filters.viewerRole)
      ? normalizedFollowups
      : normalizedFollowups.filter((followup) => followup.customer_profile_kind === "customer" || visibleCustomerIds.has(followup.customer_id)),
    notes: (notes ?? []).map(normalizeNote),
    duplicateGroups: buildDuplicateGroups(duplicateRows, duplicateOrderCounts, duplicateInvoiceCounts),
    customersTotal: customersTotal ?? 0,
    followupsTotal: followupsTotal ?? 0,
    customerPage,
    followupPage,
    pageSize,
  };
}

export async function getAdminCustomerProfile(customerId: string): Promise<CrmCustomerProfile | null> {
  const admin = getSupabaseAdminClient();
  const { data: customerRow, error: customerError } = await admin
    .from("customers")
    .select(
      "id, user_id, business_name, company_name, contact_name, email, phone, tax_id, city, notes, is_wholesale, wholesale_status, wholesale_requested_at, wholesale_request_source, wholesale_approved_at, wholesale_approved_notice_seen, wholesale_customer_type, wholesale_first_purchase_completed, wholesale_first_purchase_completed_at, status, active, lead_status, estimated_value, monthly_amount, created_at, updated_at, users(id, email, full_name, phone, active, created_at, updated_at, roles(name))",
    )
    .eq("id", customerId)
    .maybeSingle<CustomerQueryRow>();

  if (customerError) {
    throw new Error(customerError.message);
  }

  if (!customerRow) {
    return null;
  }

  const accountEmail = customerRow.users?.email ?? customerRow.email;
  const normalizedEmail = accountEmail ? normalizeAccountEmail(accountEmail) : null;
  const authByUserId = new Map<string, CustomerAuthMeta>();

  if (customerRow.user_id) {
    const { data } = await admin.auth.admin.getUserById(customerRow.user_id);
    if (data.user) {
      authByUserId.set(customerRow.user_id, {
        email_confirmed_at: data.user.email_confirmed_at ?? null,
        confirmed_at: data.user.confirmed_at ?? null,
      });
    }
  }

  const orderQueries: Array<() => Promise<{ data: CustomerProfileOrderRow[] | null; error: { message: string } | null }>> = [
    async () =>
      admin
        .from("orders")
        .select("id, order_number, tracking_code, customer_id, user_id, email, created_at, status, payment_method, payment_timing, price_mode, subtotal, tax, shipping_fee, cash_on_delivery_fee, small_order_fee, discount_total, additional_fees, total, invoices(invoice_number, status), payments(payment_status, status, bank_reference_number, reference, transfer_receipt_url, transfer_receipt_public_id)")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(30)
        .returns<CustomerProfileOrderRow[]>(),
  ];

  if (customerRow.user_id) {
    orderQueries.push(
      async () =>
        admin
          .from("orders")
          .select("id, order_number, tracking_code, customer_id, user_id, email, created_at, status, payment_method, payment_timing, price_mode, subtotal, tax, shipping_fee, cash_on_delivery_fee, small_order_fee, discount_total, additional_fees, total, invoices(invoice_number, status), payments(payment_status, status, bank_reference_number, reference, transfer_receipt_url, transfer_receipt_public_id)")
          .eq("user_id", customerRow.user_id)
          .order("created_at", { ascending: false })
          .limit(30)
          .returns<CustomerProfileOrderRow[]>(),
    );
  }

  if (!customerRow.user_id && normalizedEmail) {
    orderQueries.push(
      async () =>
        admin
          .from("orders")
          .select("id, order_number, tracking_code, customer_id, user_id, email, created_at, status, payment_method, payment_timing, price_mode, subtotal, tax, shipping_fee, cash_on_delivery_fee, small_order_fee, discount_total, additional_fees, total, invoices(invoice_number, status), payments(payment_status, status, bank_reference_number, reference, transfer_receipt_url, transfer_receipt_public_id)")
          .ilike("email", normalizedEmail)
          .is("user_id", null)
          .order("created_at", { ascending: false })
          .limit(30)
          .returns<CustomerProfileOrderRow[]>(),
    );
  }

  const [
    orderResults,
    { data: invoices, error: invoicesError },
    { data: notes, error: notesError },
    { data: followups, error: followupsError },
    { data: wholesaleCodes, error: wholesaleCodesError },
    { data: wholesaleHistory, error: wholesaleHistoryError },
    creditAccount,
    receivables,
  ] = await Promise.all([
    Promise.all(orderQueries.map((query) => query())),
    admin
      .from("invoices")
      .select("id, invoice_number, order_id, customer_id, status, subtotal, tax, shipping_fee, cash_on_delivery_fee, small_order_fee, discount_total, additional_fees, total, issued_at, created_at, orders(order_number)")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(30)
      .returns<CustomerProfileInvoiceRow[]>(),
    admin
      .from("crm_notes")
      .select("id, customer_id, user_id, note_type, note, archived_at, created_at, customers(contact_name, business_name)")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(30)
      .returns<NoteQueryRow[]>(),
    admin
      .from("crm_followups")
      .select(
        "id, customer_id, order_id, assigned_user_id, title, interaction_type, next_action, due_at, priority, phone, notes, estimated_value, monthly_amount, status, completed_at, created_at, customers(contact_name, business_name, user_id, users(roles(name)))",
      )
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(30)
      .returns<FollowupQueryRow[]>(),
    admin
      .from("wholesale_codes")
      .select("id, code, label, minimum_order, max_uses, used_count, status, active, expires_at, last_used_at")
      .eq("customer_id", customerId)
      .order("updated_at", { ascending: false })
      .limit(20)
      .returns<CustomerProfileWholesaleCodeRow[]>(),
    admin
      .from("crm_notes")
      .select("id, note, created_at, users(full_name, email)")
      .eq("customer_id", customerId)
      .eq("note_type", "wholesale_status")
      .order("created_at", { ascending: true })
      .returns<CustomerWholesaleHistoryRow[]>(),
    getCustomerCreditAccount(customerId),
    getCustomerReceivables(customerId, 50),
  ]);

  for (const result of orderResults) {
    if (result.error) {
      throw new Error(result.error.message);
    }
  }

  if (invoicesError) {
    throw new Error(invoicesError.message);
  }
  if (notesError) {
    throw new Error(notesError.message);
  }
  if (followupsError) {
    throw new Error(followupsError.message);
  }
  if (wholesaleCodesError) {
    throw new Error(wholesaleCodesError.message);
  }
  if (wholesaleHistoryError) {
    throw new Error(wholesaleHistoryError.message);
  }

  const ordersById = new Map<string, CustomerProfileOrderRow>();
  for (const result of orderResults) {
    for (const order of result.data ?? []) {
      ordersById.set(order.id, order);
    }
  }

  const orders = Array.from(ordersById.values()).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const activityOrders: OrderActivityRow[] = orders.map((order) => ({
    id: order.id,
    customer_id: order.customer_id,
    user_id: order.user_id,
    email: order.email,
    created_at: order.created_at,
    subtotal: order.subtotal,
    tax: order.tax,
    shipping_fee: order.shipping_fee,
    cash_on_delivery_fee: order.cash_on_delivery_fee,
    small_order_fee: order.small_order_fee,
    discount_total: order.discount_total,
    additional_fees: order.additional_fees,
    total: order.total,
    status: order.status,
    price_mode: order.price_mode,
    payment_method: order.payment_method,
    payment_timing: order.payment_timing,
  }));
  const ordersByCustomerId = new Map([[customerId, activityOrders]]);
  const ordersByUserId = customerRow.user_id ? new Map([[customerRow.user_id, activityOrders]]) : new Map<string, OrderActivityRow[]>();
  const ordersByEmail = normalizedEmail ? new Map([[normalizedEmail, activityOrders]]) : new Map<string, OrderActivityRow[]>();
  const invoiceCountsByCustomerId = new Map([[customerId, invoices?.length ?? 0]]);
  const wholesaleCodeCountsByCustomerId = new Map([
    [customerId, (wholesaleCodes ?? []).filter((code) => Number(code.used_count ?? 0) > 0 || code.last_used_at).length],
  ]);
  const customer = normalizeCustomer(
    customerRow,
    authByUserId,
    ordersByCustomerId,
    ordersByUserId,
    ordersByEmail,
    invoiceCountsByCustomerId,
    wholesaleCodeCountsByCustomerId,
  );

  return {
    customer,
    orders: orders.slice(0, 30).map((order) => {
      const invoice = Array.isArray(order.invoices) ? order.invoices[0] ?? null : order.invoices;
      const payment = order.payments?.[0] ?? null;
      return {
        id: order.id,
        order_number: order.order_number,
        tracking_code: order.tracking_code,
        created_at: order.created_at,
        status: order.status,
        payment_method: order.payment_method,
        payment_timing: order.payment_timing,
        payment_status: payment?.payment_status ?? payment?.status ?? null,
        bank_reference_number: payment?.bank_reference_number ?? payment?.reference ?? null,
        has_transfer_receipt: Boolean(payment?.transfer_receipt_public_id || payment?.transfer_receipt_url),
        price_mode: order.price_mode,
        subtotal: toNumber(order.subtotal),
        tax: toNumber(order.tax),
        shipping_fee: toNumber(order.shipping_fee),
        cash_on_delivery_fee: toNumber(order.cash_on_delivery_fee),
        small_order_fee: toNumber(order.small_order_fee),
        discount_total: toNumber(order.discount_total),
        additional_fees_total: additionalFeesTotal(order.additional_fees),
        total: toNumber(order.total),
        invoice_number: invoice?.invoice_number ?? null,
        invoice_status: invoice?.status ?? null,
      };
    }),
    invoices: (invoices ?? []).map((invoice) => ({
      id: invoice.id,
      invoice_number: invoice.invoice_number,
      order_id: invoice.order_id,
      order_number: invoice.orders?.order_number ?? null,
      status: invoice.status,
      subtotal: toNumber(invoice.subtotal),
      tax: toNumber(invoice.tax),
      shipping_fee: toNumber(invoice.shipping_fee),
      cash_on_delivery_fee: toNumber(invoice.cash_on_delivery_fee),
      small_order_fee: toNumber(invoice.small_order_fee),
      discount_total: toNumber(invoice.discount_total),
      additional_fees_total: additionalFeesTotal(invoice.additional_fees),
      total: toNumber(invoice.total),
      issued_at: invoice.issued_at,
      created_at: invoice.created_at,
    })),
    notes: (notes ?? []).map(normalizeNote),
    followups: (followups ?? []).map(normalizeFollowup),
    wholesaleCodes: (wholesaleCodes ?? []).map((code) => ({
      id: code.id,
      code: code.code,
      label: code.label,
      minimum_order: toNumber(code.minimum_order),
      max_uses: code.max_uses,
      used_count: toNumber(code.used_count),
      status: code.status,
      active: code.active,
      expires_at: code.expires_at,
      last_used_at: code.last_used_at,
    })),
    wholesaleHistory: (wholesaleHistory ?? []).map((item) => ({
      id: item.id,
      note: item.note,
      created_at: item.created_at,
      user_name: item.users?.full_name ?? null,
      user_email: item.users?.email ?? null,
    })),
    creditAccount,
    receivables,
  };
}
