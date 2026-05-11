import { getSupabaseAdminClient } from "@/lib/supabase";
import type { WholesaleCodeAdminRow, WholesaleCustomerOption } from "@/types/wholesale";

type WholesaleCodeQueryRow = Omit<WholesaleCodeAdminRow, "customer_name" | "business_name"> & {
  customers: {
    contact_name: string;
    business_name: string | null;
    email: string | null;
    user_id: string | null;
    status: "active" | "inactive" | "disabled" | "pending_account";
    active: boolean;
    users: {
      email: string | null;
      active: boolean;
    } | null;
  } | null;
};

type WholesaleCustomerQueryRow = WholesaleCustomerOption & {
  users: {
    email: string | null;
    active: boolean;
  } | null;
};

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

function normalizeCode(row: WholesaleCodeQueryRow): WholesaleCodeAdminRow {
  return {
    id: row.id,
    customer_id: row.customer_id,
    customer_name: row.customers?.contact_name ?? null,
    business_name: row.customers?.business_name ?? null,
    customer_email: row.customers?.email ?? null,
    customer_user_id: row.customers?.user_id ?? null,
    customer_status: row.customers?.status ?? null,
    customer_active: row.customers?.active ?? null,
    account_email: row.customers?.users?.email ?? null,
    account_active: row.customers?.users?.active ?? null,
    code: row.code,
    label: row.label,
    minimum_order: toNumber(row.minimum_order),
    max_uses: row.max_uses,
    used_count: toNumber(row.used_count),
    status: row.status,
    active: row.active,
    starts_at: row.starts_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeCustomer(row: WholesaleCustomerQueryRow): WholesaleCustomerOption {
  return {
    id: row.id,
    business_name: row.business_name,
    contact_name: row.contact_name,
    email: row.email,
    phone: row.phone,
    user_id: row.user_id,
    status: row.status,
    active: row.active,
    account_email: row.users?.email ?? null,
    account_active: row.users?.active ?? null,
  };
}

export async function getAdminWholesaleCodes() {
  const supabase = getSupabaseAdminClient();

  const [{ data: codes, error: codesError }, { data: customers, error: customersError }] = await Promise.all([
    supabase
      .from("wholesale_codes")
      .select(
        `
        id,
        customer_id,
        code,
        label,
        minimum_order,
        max_uses,
        used_count,
        status,
        active,
        starts_at,
        expires_at,
        last_used_at,
        created_at,
        updated_at,
        customers(
          contact_name,
          business_name,
          email,
          user_id,
          status,
          active,
          users(email, active)
        )
      `,
      )
      .order("updated_at", { ascending: false })
      .returns<WholesaleCodeQueryRow[]>(),
    supabase
      .from("customers")
      .select("id, business_name, contact_name, email, phone, user_id, status, active, users(email, active)")
      .eq("is_wholesale", true)
      .order("business_name", { ascending: true })
      .returns<WholesaleCustomerQueryRow[]>(),
  ]);

  if (codesError) {
    throw new Error(codesError.message);
  }

  if (customersError) {
    throw new Error(customersError.message);
  }

  return {
    codes: (codes ?? []).map(normalizeCode),
    customers: (customers ?? []).map(normalizeCustomer),
  };
}
