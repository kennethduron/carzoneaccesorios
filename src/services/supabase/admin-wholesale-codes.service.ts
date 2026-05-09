import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { WholesaleCodeAdminRow, WholesaleCustomerOption } from "@/types/wholesale";

type WholesaleCodeQueryRow = Omit<WholesaleCodeAdminRow, "customer_name" | "business_name"> & {
  customers: {
    contact_name: string;
    business_name: string | null;
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

export async function getAdminWholesaleCodes() {
  const supabase = await getSupabaseServerClient();

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
        customers(contact_name, business_name)
      `,
      )
      .order("updated_at", { ascending: false })
      .returns<WholesaleCodeQueryRow[]>(),
    supabase
      .from("customers")
      .select("id, business_name, contact_name")
      .eq("is_wholesale", true)
      .order("business_name", { ascending: true })
      .returns<WholesaleCustomerOption[]>(),
  ]);

  if (codesError) {
    throw new Error(codesError.message);
  }

  if (customersError) {
    throw new Error(customersError.message);
  }

  return {
    codes: (codes ?? []).map(normalizeCode),
    customers: customers ?? [],
  };
}
