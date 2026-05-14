"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { WholesaleCodeFormInput, WholesaleCustomerFormInput } from "@/types/wholesale";
import { requireText, validateHondurasPhone } from "@/utils/validation";

type WholesaleCodeMutationResult = {
  ok: boolean;
  message: string;
};

function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

async function sha256Hex(value: string) {
  const crypto = await import("node:crypto");
  return crypto.createHash("sha256").update(value).digest("hex");
}

function dateOrNull(value: string | null) {
  return value && value.trim() ? value : null;
}

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function humanWholesaleError(error: { message?: string; code?: string; details?: string | null }) {
  const message = error.message?.toLowerCase() ?? "";

  if (error.code === "23505" || message.includes("duplicate key") || message.includes("unique constraint")) {
    return "Este código ya está registrado. Usa otro.";
  }

  if (error.code === "42501" || message.includes("permission denied") || message.includes("row-level security")) {
    return "No tienes permisos para administrar códigos mayoristas.";
  }

  if (message.includes("fetch failed") || message.includes("failed to fetch")) {
    return "No pudimos conectar con la base de datos.";
  }

  return "No pudimos guardar el código mayorista. Intenta nuevamente.";
}

export async function saveWholesaleCodeAction(input: WholesaleCodeFormInput): Promise<WholesaleCodeMutationResult> {
  await requirePermission("customers:manage");

  const code = normalizeCode(input.code);
  if (!code || !input.label.trim() || !input.customer_id) {
    return { ok: false, message: "Código, etiqueta y cliente mayorista son obligatorios." };
  }

  const payload = {
    customer_id: input.customer_id || null,
    code,
    code_hash: await sha256Hex(code),
    label: input.label.trim(),
    minimum_order: positiveNumber(input.minimum_order),
    max_uses: input.max_uses && input.max_uses > 0 ? Math.floor(input.max_uses) : null,
    used_count: Math.floor(positiveNumber(input.used_count)),
    status: input.active ? input.status : "inactive",
    active: input.active,
    starts_at: dateOrNull(input.starts_at),
    expires_at: dateOrNull(input.expires_at),
  };

  const supabase = await getSupabaseServerClient();
  const query = input.id
    ? supabase.from("wholesale_codes").update(payload).eq("id", input.id).select("id").single<{ id: string }>()
    : supabase.from("wholesale_codes").insert(payload).select("id").single<{ id: string }>();
  const { data, error } = await query;

  if (error) {
    return { ok: false, message: humanWholesaleError(error) };
  }

  await writeAuditLog({
    tableName: "wholesale_codes",
    recordId: data.id,
    action: input.id ? "wholesale_code.updated" : "wholesale_code.created",
    newData: { ...payload, code_hash: "[redacted]" },
  });

  revalidatePath("/admin/codigos-mayoristas");
  return { ok: true, message: input.id ? "Código mayorista actualizado." : "Código mayorista creado." };
}

export async function createWholesaleCustomerAction(
  input: WholesaleCustomerFormInput,
): Promise<WholesaleCodeMutationResult> {
  await requirePermission("customers:manage");

  const businessName = requireText(input.business_name, "Empresa");
  const contactName = requireText(input.contact_name, "Contacto");
  const phone = validateHondurasPhone(input.phone);
  const email = input.email.trim().toLowerCase();

  for (const result of [businessName, contactName, phone]) {
    if (!result.ok) {
      return { ok: false, message: result.message };
    }
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: "Ingresa un correo válido para asociar la cuenta mayorista." };
  }

  const admin = getSupabaseAdminClient();
  const { data: userProfile, error: userError } = await admin
    .from("users")
    .select("id, email, active")
    .ilike("email", email)
    .maybeSingle<{ id: string; email: string | null; active: boolean }>();

  if (userError) {
    return { ok: false, message: humanWholesaleError(userError) };
  }

  const hasAccount = Boolean(userProfile?.id);
  const normalizedStatus = hasAccount ? input.status : "pending_account";
  const payload = {
    user_id: userProfile?.id ?? null,
    business_name: businessName.value,
    company_name: businessName.value,
    contact_name: contactName.value,
    email,
    phone: phone.value,
    is_wholesale: true,
    status: normalizedStatus,
    active: normalizedStatus === "active",
    notes: hasAccount
      ? `Cliente mayorista asociado a ${userProfile?.email ?? email}.`
      : "Cuenta mayorista pendiente de crear.",
  };

  const { data, error } = await admin.from("customers").insert(payload).select("id").single<{ id: string }>();

  if (error) {
    return { ok: false, message: humanWholesaleError(error) };
  }

  await writeAuditLog({
    tableName: "customers",
    recordId: data.id,
    action: "wholesale_customer.created",
    newData: payload,
  });

  revalidatePath("/admin/codigos-mayoristas");
  revalidatePath("/admin/clientes");
  return {
    ok: true,
    message: hasAccount
      ? "Cliente mayorista creado y asociado a la cuenta."
      : "Cliente mayorista creado. Cuenta mayorista pendiente de crear.",
  };
}

export async function setWholesaleCodeActiveAction(id: string, active: boolean): Promise<WholesaleCodeMutationResult> {
  await requirePermission("customers:manage");

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase
    .from("wholesale_codes")
    .update({ active, status: active ? "active" : "inactive" })
    .eq("id", id);

  if (error) {
    return { ok: false, message: humanWholesaleError(error) };
  }

  await writeAuditLog({
    tableName: "wholesale_codes",
    recordId: id,
    action: active ? "wholesale_code.activated" : "wholesale_code.deactivated",
    newData: { active },
  });

  revalidatePath("/admin/codigos-mayoristas");
  return { ok: true, message: active ? "Código activado." : "Código desactivado." };
}

