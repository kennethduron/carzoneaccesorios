"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { WholesaleCodeFormInput } from "@/types/wholesale";

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

export async function saveWholesaleCodeAction(input: WholesaleCodeFormInput): Promise<WholesaleCodeMutationResult> {
  await requirePermission("customers:manage");

  const code = normalizeCode(input.code);
  if (!code || !input.label.trim()) {
    return { ok: false, message: "Codigo y etiqueta son obligatorios." };
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
    ? supabase.from("wholesale_codes").update(payload).eq("id", input.id)
    : supabase.from("wholesale_codes").insert(payload);
  const { error } = await query;

  if (error) {
    return { ok: false, message: error.message };
  }

  revalidatePath("/admin/codigos-mayoristas");
  return { ok: true, message: input.id ? "Codigo mayorista actualizado." : "Codigo mayorista creado." };
}

export async function setWholesaleCodeActiveAction(id: string, active: boolean): Promise<WholesaleCodeMutationResult> {
  await requirePermission("customers:manage");

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase
    .from("wholesale_codes")
    .update({ active, status: active ? "active" : "inactive" })
    .eq("id", id);

  if (error) {
    return { ok: false, message: error.message };
  }

  revalidatePath("/admin/codigos-mayoristas");
  return { ok: true, message: active ? "Codigo activado." : "Codigo desactivado." };
}
