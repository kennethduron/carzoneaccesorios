"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { CrmFollowupInput, CrmFollowupStatus, CrmLeadInput, CrmNoteInput } from "@/types/crm";
import { hondurasPhone, nonNegativeNumber, optionalDateTime, optionalText, requireText, uuidLike } from "@/utils/validation";

type CrmMutationResult = {
  ok: boolean;
  message: string;
};

export async function saveCrmLeadAction(input: CrmLeadInput): Promise<CrmMutationResult> {
  await requirePermission("crm:manage");

  const contactName = requireText(input.contact_name, "Cliente");
  const phone = hondurasPhone(input.phone);
  const estimatedValue = nonNegativeNumber(input.estimated_value, "Valor estimado");
  const monthlyAmount = nonNegativeNumber(input.monthly_amount, "Mensualidad");

  for (const result of [contactName, phone, estimatedValue, monthlyAmount]) {
    if (!result.ok) {
      return { ok: false, message: result.message };
    }
  }

  const payload = {
    business_name: optionalText(input.business_name),
    contact_name: contactName.value,
    email: optionalText(input.email),
    phone: phone.value,
    tax_id: optionalText(input.tax_id),
    address: optionalText(input.address),
    city: optionalText(input.city),
    notes: optionalText(input.notes),
    lead_status: input.lead_status,
    estimated_value: estimatedValue.value,
    monthly_amount: monthlyAmount.value,
    active: true,
  };

  const supabase = await getSupabaseServerClient();
  const query = input.id
    ? supabase.from("customers").update(payload).eq("id", input.id).select("id").single<{ id: string }>()
    : supabase.from("customers").insert(payload).select("id").single<{ id: string }>();
  const { data, error } = await query;

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "customers",
    recordId: data.id,
    action: input.id ? "crm.lead.updated" : "crm.lead.created",
    newData: payload,
  });

  revalidatePath("/admin/crm");
  return { ok: true, message: input.id ? "Cliente actualizado." : "Cliente potencial creado." };
}

export async function saveCrmFollowupAction(input: CrmFollowupInput): Promise<CrmMutationResult> {
  const profile = await requirePermission("crm:manage");

  const customerId = uuidLike(input.customer_id, "Cliente");
  const title = requireText(input.title, "Titulo");
  const dueAt = optionalDateTime(input.due_at);
  const estimatedValue = nonNegativeNumber(input.estimated_value, "Valor estimado");
  const monthlyAmount = nonNegativeNumber(input.monthly_amount, "Mensualidad");
  const phone = input.phone.trim() ? hondurasPhone(input.phone) : { ok: true as const, value: null };

  for (const result of [customerId, title, dueAt, estimatedValue, monthlyAmount, phone]) {
    if (!result.ok) {
      return { ok: false, message: result.message };
    }
  }

  const payload = {
    customer_id: customerId.value,
    assigned_user_id: profile.id,
    title: title.value,
    interaction_type: input.interaction_type,
    next_action: optionalText(input.next_action),
    due_at: dueAt.value,
    priority: input.priority,
    phone: phone.value,
    notes: optionalText(input.notes),
    estimated_value: estimatedValue.value,
    monthly_amount: monthlyAmount.value,
    status: "pending",
  };

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.from("crm_followups").insert(payload).select("id").single<{ id: string }>();

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "crm_followups",
    recordId: data.id,
    action: "crm.followup.created",
    newData: payload,
  });

  revalidatePath("/admin/crm");
  return { ok: true, message: "Actividad CRM creada." };
}

export async function saveCrmNoteAction(input: CrmNoteInput): Promise<CrmMutationResult> {
  const profile = await requirePermission("crm:manage");

  const customerId = uuidLike(input.customer_id, "Cliente");
  const note = requireText(input.note, "Nota", 2000);

  for (const result of [customerId, note]) {
    if (!result.ok) {
      return { ok: false, message: result.message };
    }
  }

  const supabase = await getSupabaseServerClient();
  const payload = {
    customer_id: customerId.value,
    user_id: profile.id,
    note: note.value,
  };
  const { data, error } = await supabase.from("crm_notes").insert(payload).select("id").single<{ id: string }>();

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "crm_notes",
    recordId: data.id,
    action: "crm.note.created",
    newData: payload,
  });

  revalidatePath("/admin/crm");
  return { ok: true, message: "Nota guardada en el historial." };
}

export async function setCrmFollowupStatusAction(
  id: string,
  status: CrmFollowupStatus,
): Promise<CrmMutationResult> {
  await requirePermission("crm:manage");

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase
    .from("crm_followups")
    .update({
      status,
      completed_at: status === "completed" ? new Date().toISOString() : null,
    })
    .eq("id", id);

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "crm_followups",
    recordId: id,
    action: "crm.followup.status_changed",
    newData: { status },
  });

  revalidatePath("/admin/crm");
  return { ok: true, message: status === "completed" ? "Actividad completada." : "Actividad actualizada." };
}
