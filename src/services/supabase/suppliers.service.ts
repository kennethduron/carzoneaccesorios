import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import type { Supplier, SupplierOption, SupplierSummary } from "@/types/purchases";

export async function getAdminSuppliers(): Promise<{ suppliers: Supplier[]; summary: SupplierSummary }> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("suppliers")
    .select("id, name, contact_name, phone, email, tax_id, address, notes, is_active, created_by, created_at, updated_at")
    .order("name", { ascending: true })
    .returns<Supplier[]>();

  if (error) {
    throw new Error(error.message);
  }

  const suppliers = data ?? [];
  return {
    suppliers,
    summary: {
      total: suppliers.length,
      active: suppliers.filter((supplier) => supplier.is_active).length,
      inactive: suppliers.filter((supplier) => !supplier.is_active).length,
    },
  };
}

export async function getSupplierOptions(includeInactive = false): Promise<SupplierOption[]> {
  const admin = getSupabaseAdminClient();
  let query = admin
    .from("suppliers")
    .select("id, name, is_active, tax_id")
    .order("name", { ascending: true });

  if (!includeInactive) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query.returns<SupplierOption[]>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

export async function getSupplierById(supplierId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("suppliers")
    .select("id, name, contact_name, phone, email, tax_id, address, notes, is_active, created_by, created_at, updated_at")
    .eq("id", supplierId)
    .maybeSingle<Supplier>();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}
