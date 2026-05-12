import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AdminCrmData, CrmCustomerOption, CrmFollowupRow, CrmNoteRow } from "@/types/crm";
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
  | "last_activity_at"
  | "account_state"
  | "customer_type"
  | "has_wholesale_request"
  | "is_test_account"
> & {
  estimated_value: unknown;
  monthly_amount: unknown;
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
};

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

function getAccountState(input: {
  active: boolean;
  status: CrmCustomerOption["status"];
  accountActive: boolean | null;
  userId: string | null;
  emailConfirmedAt: string | null;
  isWholesale: boolean;
  hasWholesaleRequest: boolean;
}) {
  if (!input.active || input.status === "disabled" || input.accountActive === false) {
    return "Cuenta suspendida" as const;
  }

  if (input.isWholesale && input.status === "active") {
    return "Mayorista aprobado" as const;
  }

  if (input.hasWholesaleRequest || (input.isWholesale && input.status === "pending_account")) {
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
  const authMeta = row.user_id ? authByUserId.get(row.user_id) : null;
  const emailConfirmedAt = authMeta?.email_confirmed_at ?? null;
  const confirmedAt = authMeta?.confirmed_at ?? null;
  const hasWholesaleRequest = Boolean(row.notes?.includes("[SOLICITUD_MAYOREO]")) && !row.is_wholesale;

  return {
    ...row,
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
    last_activity_at: latestDate(latestOrderAt, row.updated_at, row.users?.updated_at),
    account_state: getAccountState({
      active: row.active,
      status: row.status,
      accountActive: row.users?.active ?? null,
      userId: row.user_id,
      emailConfirmedAt,
      isWholesale: row.is_wholesale,
      hasWholesaleRequest,
    }),
    customer_type: row.is_wholesale ? "Mayorista" : "Retail",
    has_wholesale_request: hasWholesaleRequest,
    is_test_account: accountEmail ? isSafeTestAccountEmail(accountEmail) : false,
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
  ] = await Promise.all([
    supabase
      .from("customers")
      .select(
        "id, user_id, business_name, company_name, contact_name, email, phone, tax_id, city, notes, is_wholesale, status, active, lead_status, estimated_value, monthly_amount, created_at, updated_at, users(id, email, full_name, phone, active, created_at, updated_at)",
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
      .select("id, customer_id, user_id, note, created_at, customers(contact_name, business_name)")
      .order("created_at", { ascending: false })
      .limit(200)
      .returns<NoteQueryRow[]>(),
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
      admin.from("orders").select("id, customer_id, user_id, email, created_at").in("customer_id", customerIds).returns<OrderActivityRow[]>(),
    );
  }
  if (userIds.length > 0) {
    orderQueries.push(async () =>
      admin.from("orders").select("id, customer_id, user_id, email, created_at").in("user_id", userIds).returns<OrderActivityRow[]>(),
    );
  }
  if (emails.length > 0) {
    orderQueries.push(async () =>
      admin.from("orders").select("id, customer_id, user_id, email, created_at").in("email", emails).returns<OrderActivityRow[]>(),
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

  return {
    customers: customerRows.map((customer) =>
      normalizeCustomer(customer, authByUserId, ordersByCustomerId, ordersByUserId, ordersByEmail),
    ),
    followups: (followups ?? []).map(normalizeFollowup),
    notes: (notes ?? []).map(normalizeNote),
    customersTotal: customersTotal ?? 0,
    followupsTotal: followupsTotal ?? 0,
    customerPage,
    followupPage,
    pageSize,
  };
}
