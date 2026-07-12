"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

type ActionResult = { ok: true; message: string } | { ok: false; message: string };

export type SupplierFormInput = {
  id?: string;
  name: string;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  tax_id?: string | null;
  address?: string | null;
  notes?: string | null;
  is_active?: boolean;
};

function cleanText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

function supplierErrorMessage(message: string) {
  if (message.includes("suppliers_name_normalized_key") || message.includes("suppliers_name_key")) {
    return "Ya existe un proveedor con ese nombre.";
  }

  if (message.includes("suppliers_tax_id_key")) {
    return "Ya existe un proveedor con ese RTN o identificacion fiscal.";
  }

  return "No se pudo guardar el proveedor.";
}

export async function saveSupplierAction(input: SupplierFormInput): Promise<ActionResult> {
  const profile = await requirePermission("suppliers:manage");
  const name = cleanText(input.name);

  if (!name) {
    return { ok: false, message: "El nombre del proveedor es obligatorio." };
  }

  const payload = {
    name,
    contact_name: cleanText(input.contact_name),
    phone: cleanText(input.phone),
    email: cleanText(input.email),
    tax_id: cleanText(input.tax_id),
    address: cleanText(input.address),
    notes: cleanText(input.notes),
    is_active: input.is_active ?? true,
  };

  const admin = getSupabaseAdminClient();

  if (input.id) {
    const { data, error } = await admin
      .from("suppliers")
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq("id", input.id)
      .select("id, name, is_active")
      .single();

    if (error) {
      return { ok: false, message: supplierErrorMessage(error.message) };
    }

    await writeAuditLog({
      tableName: "suppliers",
      recordId: data.id,
      action: "suppliers.update",
      newData: { name: data.name, is_active: data.is_active },
    });
    revalidatePath("/admin/proveedores");
    return { ok: true, message: "Proveedor actualizado." };
  }

  const { data, error } = await admin
    .from("suppliers")
    .insert({ ...payload, created_by: profile.id })
    .select("id, name, is_active")
    .single();

  if (error) {
    return { ok: false, message: supplierErrorMessage(error.message) };
  }

  await writeAuditLog({
    tableName: "suppliers",
    recordId: data.id,
    action: "suppliers.create",
    newData: { name: data.name, is_active: data.is_active },
  });
  revalidatePath("/admin/proveedores");
  return { ok: true, message: "Proveedor registrado." };
}

export async function setSupplierActiveAction(supplierId: string, isActive: boolean): Promise<ActionResult> {
  await requirePermission("suppliers:manage");

  if (!supplierId) {
    return { ok: false, message: "Selecciona un proveedor valido." };
  }

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("suppliers")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", supplierId)
    .select("id, name, is_active")
    .single();

  if (error) {
    return { ok: false, message: "No se pudo cambiar el estado del proveedor." };
  }

  await writeAuditLog({
    tableName: "suppliers",
    recordId: data.id,
    action: isActive ? "suppliers.activate" : "suppliers.deactivate",
    newData: { name: data.name, is_active: data.is_active },
  });
  revalidatePath("/admin/proveedores");
  return { ok: true, message: isActive ? "Proveedor activado." : "Proveedor desactivado." };
}
