import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AdminCrmData, CrmCustomerOption, CrmFollowupRow, CrmNoteRow } from "@/types/crm";

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

type CustomerQueryRow = Omit<CrmCustomerOption, "estimated_value" | "monthly_amount"> & {
  estimated_value: unknown;
  monthly_amount: unknown;
};

function normalizeCustomer(row: CustomerQueryRow): CrmCustomerOption {
  return {
    ...row,
    estimated_value: toNumber(row.estimated_value),
    monthly_amount: toNumber(row.monthly_amount),
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
      .select("id, business_name, contact_name, email, phone, lead_status, estimated_value, monthly_amount", { count: "exact" })
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

  return {
    customers: (customers ?? []).map(normalizeCustomer),
    followups: (followups ?? []).map(normalizeFollowup),
    notes: (notes ?? []).map(normalizeNote),
    customersTotal: customersTotal ?? 0,
    followupsTotal: followupsTotal ?? 0,
    customerPage,
    followupPage,
    pageSize,
  };
}
