import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  AdminCrmData,
  CrmCustomerOption,
  CrmCustomerProfile,
  CrmDuplicateGroup,
  CrmFollowupRow,
  CrmNoteRow,
} from "@/types/crm";
import { isSafeTestAccountEmail, normalizeAccountEmail } from "@/utils/test-accounts";

export type AdminCrmPageFilters = {
  customerPage?: number;
  followupPage?: number;
  pageSize?: number;
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
  payments: Array<{ payment_status: string | null; status: string | null }> | null;
  price_mode: "retail" | "wholesale";
  total: unknown;
  invoices: Array<{ invoice_number: string | null }> | { invoice_number: string | null } | null;
};

type CustomerProfileInvoiceRow = {
  id: string;
  invoice_number: string;
  order_id: string;
  customer_id: string | null;
  status: string;
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

    if (email) {
      keys.add(`email:${normalizeAccountEmail(email)}`);
    }
    if (phoneKey) {
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
    addCustomer("email", customer.email ? normalizeAccountEmail(customer.email) : null, customer.email ?? "Correo repetido", customer);
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
}) {
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
    return "Correo confirmado" as const;
  }

  if (input.userId) {
    return "Correo pendiente de confirmar" as const;
  }

  return "Cuenta creada" as const;
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
  const normalizedEmail = accountEmail ? normalizeAccountEmail(accountEmail) : null;
  const relatedOrders = new Map<string, OrderActivityRow>();
  const byCustomer = ordersByCustomerId.get(row.id) ?? [];
  const byUser = row.user_id ? ordersByUserId.get(row.user_id) ?? [] : [];
  const byEmail = normalizedEmail ? ordersByEmail.get(normalizedEmail) ?? [] : [];

  for (const order of [...byCustomer, ...byUser, ...byEmail]) {
    relatedOrders.set(order.id, order);
  }

  const latestOrderAt = latestDate(...Array.from(relatedOrders.values()).map((order) => order.created_at));
  const totalSpent = Array.from(relatedOrders.values()).reduce((sum, order) => sum + toNumber(order.total), 0);
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
  const isOperationalWholesaleAccount = row.is_wholesale || wholesaleStatus === "approved" || wholesaleStatus === "suspended";
  const deleteBlockReason =
    relatedOrders.size > 0
      ? "No se puede eliminar porque tiene pedidos relacionados. Puedes suspender la cuenta."
      : (invoiceCountsByCustomerId.get(row.id) ?? 0) > 0
        ? "No se puede eliminar porque tiene facturas relacionadas. Puedes suspender la cuenta."
        : isOperationalWholesaleAccount
          ? "No se puede eliminar porque tiene historial mayorista operativo. Puedes suspender la cuenta."
          : (wholesaleCodeCountsByCustomerId.get(row.id) ?? 0) > 0
            ? "No se puede eliminar porque tiene códigos o acceso mayorista relacionado. Puedes suspender la cuenta."
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
    }),
    customer_type: wholesaleStatus === "approved" ? "Mayorista" : "Retail",
    has_wholesale_request: wholesaleStatus === "pending" || hasWholesaleRequest,
    is_test_account: accountEmail ? isSafeTestAccountEmail(accountEmail) : false,
    can_delete_permanently: !deleteBlockReason,
    delete_block_reason: deleteBlockReason,
  };
}

function normalizeFollowup(row: FollowupQueryRow): CrmFollowupRow {
  return {
    ...row,
    customer_name: row.customers?.contact_name ?? null,
    business_name: row.customers?.business_name ?? null,
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

export async function getAdminCrm(filters: AdminCrmPageFilters = {}): Promise<AdminCrmPageData> {
  const supabase = await getSupabaseServerClient();
  const admin = getSupabaseAdminClient();
  const customerPage = normalizePage(filters.customerPage);
  const followupPage = normalizePage(filters.followupPage);
  const pageSize = normalizePageSize(filters.pageSize);
  const customerFrom = (customerPage - 1) * pageSize;
  const followupFrom = (followupPage - 1) * pageSize;

  const [
    { data: customers, error: customersError, count: customersTotal },
    { data: followups, error: followupsError, count: followupsTotal },
    { data: notes, error: notesError },
    { data: duplicateCustomers, error: duplicateCustomersError },
  ] = await Promise.all([
    supabase
      .from("customers")
      .select(
        "id, user_id, business_name, company_name, contact_name, email, phone, tax_id, city, notes, is_wholesale, wholesale_status, status, active, lead_status, estimated_value, monthly_amount, created_at, updated_at, users(id, email, full_name, phone, active, created_at, updated_at)",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(customerFrom, customerFrom + pageSize - 1)
      .returns<CustomerQueryRow[]>(),
    supabase
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
        customers(contact_name, business_name)
      `,
        { count: "exact" },
      )
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
      admin.from("orders").select("id, customer_id, user_id, email, created_at, total").in("customer_id", customerIds).returns<OrderActivityRow[]>(),
    );
  }
  if (userIds.length > 0) {
    orderQueries.push(async () =>
      admin.from("orders").select("id, customer_id, user_id, email, created_at, total").in("user_id", userIds).returns<OrderActivityRow[]>(),
    );
  }
  if (emails.length > 0) {
    orderQueries.push(async () =>
      admin.from("orders").select("id, customer_id, user_id, email, created_at, total").in("email", emails).returns<OrderActivityRow[]>(),
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
      if (order.email) {
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
        admin.from("wholesale_codes").select("id, customer_id").in("customer_id", customerIds).returns<CustomerReferenceRow[]>(),
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
      if (code.customer_id) {
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

  return {
    customers: uniqueCustomers(normalizedCustomers),
    followups: (followups ?? []).map(normalizeFollowup),
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
      "id, user_id, business_name, company_name, contact_name, email, phone, tax_id, city, notes, is_wholesale, wholesale_status, status, active, lead_status, estimated_value, monthly_amount, created_at, updated_at, users(id, email, full_name, phone, active, created_at, updated_at)",
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
        .select("id, order_number, tracking_code, customer_id, user_id, email, created_at, status, payment_method, price_mode, total, invoices(invoice_number), payments(payment_status, status)")
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
          .select("id, order_number, tracking_code, customer_id, user_id, email, created_at, status, payment_method, price_mode, total, invoices(invoice_number), payments(payment_status, status)")
          .eq("user_id", customerRow.user_id)
          .order("created_at", { ascending: false })
          .limit(30)
          .returns<CustomerProfileOrderRow[]>(),
    );
  }

  if (normalizedEmail) {
    orderQueries.push(
      async () =>
        admin
          .from("orders")
          .select("id, order_number, tracking_code, customer_id, user_id, email, created_at, status, payment_method, price_mode, total, invoices(invoice_number), payments(payment_status, status)")
          .ilike("email", normalizedEmail)
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
  ] = await Promise.all([
    Promise.all(orderQueries.map((query) => query())),
    admin
      .from("invoices")
      .select("id, invoice_number, order_id, customer_id, status, total, issued_at, created_at, orders(order_number)")
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
        "id, customer_id, order_id, assigned_user_id, title, interaction_type, next_action, due_at, priority, phone, notes, estimated_value, monthly_amount, status, completed_at, created_at, customers(contact_name, business_name)",
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
  const ordersByCustomerId = new Map([[customerId, orders]]);
  const ordersByUserId = customerRow.user_id ? new Map([[customerRow.user_id, orders]]) : new Map<string, CustomerProfileOrderRow[]>();
  const ordersByEmail = normalizedEmail ? new Map([[normalizedEmail, orders]]) : new Map<string, CustomerProfileOrderRow[]>();
  const invoiceCountsByCustomerId = new Map([[customerId, invoices?.length ?? 0]]);
  const wholesaleCodeCountsByCustomerId = new Map([[customerId, wholesaleCodes?.length ?? 0]]);
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
        payment_status: payment?.payment_status ?? payment?.status ?? null,
        price_mode: order.price_mode,
        total: toNumber(order.total),
        invoice_number: invoice?.invoice_number ?? null,
      };
    }),
    invoices: (invoices ?? []).map((invoice) => ({
      id: invoice.id,
      invoice_number: invoice.invoice_number,
      order_id: invoice.order_id,
      order_number: invoice.orders?.order_number ?? null,
      status: invoice.status,
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
  };
}
