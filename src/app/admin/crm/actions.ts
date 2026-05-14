"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { CrmFollowupInput, CrmFollowupStatus, CrmLeadInput, CrmNoteInput } from "@/types/crm";
import { isSafeTestAccountEmail, normalizeAccountEmail } from "@/utils/test-accounts";
import {
  nonNegativeNumber,
  optionalDateTime,
  optionalText,
  requireText,
  uuidLike,
  validateHondurasPhone,
} from "@/utils/validation";

type CrmMutationResult = {
  ok: boolean;
  message: string;
};

type TestAccountDeletionInput = {
  email: string;
  confirmation: string;
};

type MergeDuplicateCustomerInput = {
  sourceCustomerId: string;
  targetCustomerId: string;
};

function validateEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function localPhoneCandidate(normalizedPhone: string) {
  return normalizedPhone.startsWith("+504") ? normalizedPhone.slice(4) : normalizedPhone;
}

async function findAuthUsersByEmail(email: string) {
  const admin = getSupabaseAdminClient();
  const matches: Array<{ id: string; email: string | undefined }> = [];
  const maxPages = 20;

  for (let page = 1; page <= maxPages; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });

    if (error) {
      throw new Error(error.message);
    }

    const users = data.users ?? [];
    matches.push(
      ...users
        .filter((user) => normalizeAccountEmail(user.email ?? "") === email)
        .map((user) => ({ id: user.id, email: user.email })),
    );

    if (users.length < 100) {
      break;
    }
  }

  return matches;
}

export async function saveCrmLeadAction(input: CrmLeadInput): Promise<CrmMutationResult> {
  await requirePermission("crm:manage");

  const contactName = requireText(input.contact_name, "Cliente");
  const phone = validateHondurasPhone(input.phone);
  const estimatedValue = nonNegativeNumber(input.estimated_value, "Valor estimado");
  const monthlyAmount = nonNegativeNumber(input.monthly_amount, "Mensualidad");

  for (const result of [contactName, phone, estimatedValue, monthlyAmount]) {
    if (!result.ok) {
      return { ok: false, message: result.message };
    }
  }

  const normalizedPhone = phone.ok ? phone.value : "";
  const payload = {
    business_name: optionalText(input.business_name),
    contact_name: contactName.value,
    email: optionalText(input.email),
    phone: normalizedPhone,
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
  let existingCustomerId: string | null = null;
  const normalizedEmail = optionalText(input.email)?.toLowerCase() ?? null;

  if (!input.id) {
    if (normalizedEmail) {
      const { data: emailMatch } = await supabase
        .from("customers")
        .select("id")
        .ilike("email", normalizedEmail)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle<{ id: string }>();
      existingCustomerId = emailMatch?.id ?? null;
    }

    if (!existingCustomerId) {
      const localPhone = localPhoneCandidate(normalizedPhone);
      const { data: phoneMatch } = await supabase
        .from("customers")
        .select("id")
        .in("phone", Array.from(new Set([normalizedPhone, localPhone, `504${localPhone}`])))
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle<{ id: string }>();
      existingCustomerId = phoneMatch?.id ?? null;
    }
  }

  const query = input.id || existingCustomerId
    ? supabase.from("customers").update(payload).eq("id", input.id ?? existingCustomerId).select("id").single<{ id: string }>()
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
  return { ok: true, message: input.id || existingCustomerId ? "Cliente actualizado." : "Cliente potencial creado." };
}

export async function saveCrmFollowupAction(input: CrmFollowupInput): Promise<CrmMutationResult> {
  const profile = await requirePermission("crm:manage");

  const customerId = uuidLike(input.customer_id, "Cliente");
  const title = requireText(input.title, "Titulo");
  const dueAt = optionalDateTime(input.due_at);
  const estimatedValue = nonNegativeNumber(input.estimated_value, "Valor estimado");
  const monthlyAmount = nonNegativeNumber(input.monthly_amount, "Mensualidad");
  const phone = input.phone.trim() ? validateHondurasPhone(input.phone) : { ok: true as const, value: null };

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

export async function approveWholesaleRequestAction(customerId: string): Promise<CrmMutationResult> {
  await requirePermission("customers:manage");

  const customer = uuidLike(customerId, "Cliente");
  if (!customer.ok) {
    return { ok: false, message: customer.message };
  }

  const admin = getSupabaseAdminClient();
  const { data: customerRow, error: customerError } = await admin
    .from("customers")
    .select("id, email, business_name, company_name, contact_name, phone, notes")
    .eq("id", customer.value)
    .maybeSingle<{
      id: string;
      email: string | null;
      business_name: string | null;
      company_name: string | null;
      contact_name: string;
      phone: string;
      notes: string | null;
    }>();

  if (customerError || !customerRow) {
    return { ok: false, message: "No pudimos encontrar la solicitud mayorista." };
  }

  const email = customerRow.email?.trim().toLowerCase() ?? "";
  if (!email) {
    return { ok: false, message: "La solicitud no tiene correo para vincular cuenta." };
  }

  const { data: userProfile } = await admin
    .from("users")
    .select("id, email, active")
    .ilike("email", email)
    .maybeSingle<{ id: string; email: string | null; active: boolean }>();

  const hasAccount = Boolean(userProfile?.id);
  const nextStatus = hasAccount && userProfile?.active !== false ? "active" : "pending_account";
  const nextNotes = [
    customerRow.notes,
    hasAccount
      ? `Mayorista aprobado y vinculado a la cuenta ${userProfile?.email ?? email}.`
      : "Mayorista aprobado. Cuenta mayorista pendiente de crear o vincular.",
  ]
    .filter(Boolean)
    .join("\n");

  const { error: updateError } = await admin
    .from("customers")
    .update({
      user_id: userProfile?.id ?? null,
      business_name: customerRow.business_name ?? customerRow.company_name ?? customerRow.contact_name,
      company_name: customerRow.company_name ?? customerRow.business_name ?? customerRow.contact_name,
      is_wholesale: true,
      status: nextStatus,
      active: nextStatus === "active",
      lead_status: "cliente",
      notes: nextNotes,
    })
    .eq("id", customer.value);

  if (updateError) {
    return { ok: false, message: "No pudimos aprobar la solicitud mayorista." };
  }

  await writeAuditLog({
    tableName: "customers",
    recordId: customer.value,
    action: "wholesale_request.approved",
    newData: {
      user_id: userProfile?.id ?? null,
      is_wholesale: true,
      status: nextStatus,
      active: nextStatus === "active",
    },
  });

  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");
  revalidatePath("/admin/codigos-mayoristas");

  return {
    ok: true,
    message: hasAccount
      ? "Mayorista aprobado y vinculado a su cuenta. Ahora puedes generar su código."
      : "Mayorista aprobado. Cuenta mayorista pendiente de crear; cuando se registre con ese correo quedará listo para vincular.",
  };
}

export async function suspendCustomerAccountAction(customerId: string): Promise<CrmMutationResult> {
  await requirePermission("customers:manage");

  const customer = uuidLike(customerId, "Cliente");
  if (!customer.ok) {
    return { ok: false, message: customer.message };
  }

  const admin = getSupabaseAdminClient();
  const { data: customerRow, error: customerError } = await admin
    .from("customers")
    .select("id, user_id, email, contact_name, active, status, notes")
    .eq("id", customer.value)
    .maybeSingle<{
      id: string;
      user_id: string | null;
      email: string | null;
      contact_name: string;
      active: boolean;
      status: string;
      notes: string | null;
    }>();

  if (customerError || !customerRow) {
    return { ok: false, message: "No pudimos encontrar la cuenta del cliente." };
  }

  const { error: updateCustomerError } = await admin
    .from("customers")
    .update({
      active: false,
      status: "disabled",
      notes: [customerRow.notes, customerRow.contact_name ? `Cuenta suspendida desde admin para ${customerRow.contact_name}.` : null]
        .filter(Boolean)
        .join("\n"),
    })
    .eq("id", customer.value);

  if (updateCustomerError) {
    return { ok: false, message: "No pudimos suspender la cuenta del cliente." };
  }

  if (customerRow.user_id) {
    await admin.from("users").update({ active: false }).eq("id", customerRow.user_id);
  }

  await writeAuditLog({
    tableName: "customers",
    recordId: customer.value,
    action: "customer_account.suspended",
    oldData: {
      active: customerRow.active,
      status: customerRow.status,
    },
    newData: {
      active: false,
      status: "disabled",
      email: customerRow.email,
      user_id: customerRow.user_id,
    },
  });

  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");

  return { ok: true, message: "Cuenta suspendida correctamente." };
}

export async function mergeDuplicateCustomerAction(input: MergeDuplicateCustomerInput): Promise<CrmMutationResult> {
  await requirePermission("customers:manage");

  const source = uuidLike(input.sourceCustomerId, "Cliente duplicado");
  const target = uuidLike(input.targetCustomerId, "Cliente principal");

  for (const result of [source, target]) {
    if (!result.ok) {
      return { ok: false, message: result.message };
    }
  }

  if (source.value === target.value) {
    return { ok: false, message: "Selecciona dos clientes diferentes para unificar." };
  }

  const admin = getSupabaseAdminClient();
  const [{ data: sourceCustomer, error: sourceError }, { data: targetCustomer, error: targetError }] = await Promise.all([
    admin
      .from("customers")
      .select("id, contact_name, business_name, email, phone, notes")
      .eq("id", source.value)
      .single<{ id: string; contact_name: string; business_name: string | null; email: string | null; phone: string | null; notes: string | null }>(),
    admin
      .from("customers")
      .select("id, contact_name, business_name, email, phone, notes")
      .eq("id", target.value)
      .single<{ id: string; contact_name: string; business_name: string | null; email: string | null; phone: string | null; notes: string | null }>(),
  ]);

  if (sourceError || !sourceCustomer) {
    return { ok: false, message: "No pudimos encontrar el cliente duplicado." };
  }

  if (targetError || !targetCustomer) {
    return { ok: false, message: "No pudimos encontrar el cliente principal." };
  }

  const { count: sourceInvoices, error: invoiceError } = await admin
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", source.value);

  if (invoiceError) {
    return { ok: false, message: invoiceError.message };
  }

  if ((sourceInvoices ?? 0) > 0) {
    return {
      ok: false,
      message: "Este cliente tiene facturas. No se unifica automáticamente; revísalo manualmente para no romper historial fiscal.",
    };
  }

  const updates = [
    admin.from("orders").update({ customer_id: target.value }).eq("customer_id", source.value),
    admin.from("payments").update({ customer_id: target.value }).eq("customer_id", source.value),
    admin.from("crm_notes").update({ customer_id: target.value }).eq("customer_id", source.value),
    admin.from("crm_followups").update({ customer_id: target.value }).eq("customer_id", source.value),
    admin.from("wholesale_codes").update({ customer_id: target.value }).eq("customer_id", source.value),
  ];

  const updateResults = await Promise.all(updates);
  const updateError = updateResults.find((result) => result.error)?.error;
  if (updateError) {
    return { ok: false, message: updateError.message };
  }

  const mergedNote = [
    targetCustomer.notes,
    `[UNIFICACION_DUPLICADO] Se unificó el cliente ${sourceCustomer.business_name ?? sourceCustomer.contact_name} (${source.value}) en este registro.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { error: targetUpdateError } = await admin
    .from("customers")
    .update({
      email: targetCustomer.email ?? sourceCustomer.email,
      phone: targetCustomer.phone ?? sourceCustomer.phone,
      notes: mergedNote,
      updated_at: new Date().toISOString(),
    })
    .eq("id", target.value);

  if (targetUpdateError) {
    return { ok: false, message: targetUpdateError.message };
  }

  const { error: sourceUpdateError } = await admin
    .from("customers")
    .update({
      active: false,
      status: "inactive",
      notes: `[DUPLICADO_UNIFICADO] Unificado en cliente ${target.value}.`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", source.value);

  if (sourceUpdateError) {
    return { ok: false, message: sourceUpdateError.message };
  }

  await writeAuditLog({
    tableName: "customers",
    recordId: target.value,
    action: "customer.duplicate_merged",
    oldData: {
      sourceCustomer,
      targetCustomer,
    },
    newData: {
      source_customer_id: source.value,
      target_customer_id: target.value,
    },
  });

  revalidatePath("/admin/clientes");
  revalidatePath("/admin/crm");

  return { ok: true, message: "Cliente duplicado unificado correctamente. El historial fue movido al perfil principal." };
}

export async function deleteTestAccountAction(input: TestAccountDeletionInput): Promise<CrmMutationResult> {
  const profile = await requirePermission("settings:manage");

  if (profile.role !== "admin") {
    return { ok: false, message: "Solo un administrador principal puede eliminar cuentas TEST." };
  }

  const email = normalizeAccountEmail(input.email);
  if (!validateEmail(email)) {
    return { ok: false, message: "Ingresa un correo valido para eliminar la cuenta TEST." };
  }

  if (!isSafeTestAccountEmail(email)) {
    return {
      ok: false,
      message: "Por seguridad, este correo no parece de prueba. Para clientes reales usa suspender cuenta.",
    };
  }

  if (input.confirmation.trim() !== "ELIMINAR TEST") {
    return { ok: false, message: "Escribe ELIMINAR TEST para confirmar esta acción." };
  }

  const admin = getSupabaseAdminClient();
  const { data: userRows, error: usersError } = await admin
    .from("users")
    .select("id, email")
    .ilike("email", email)
    .returns<Array<{ id: string; email: string | null }>>();

  if (usersError) {
    return { ok: false, message: "No pudimos revisar la cuenta TEST." };
  }

  let authUsers: Array<{ id: string; email: string | undefined }>;
  try {
    authUsers = await findAuthUsersByEmail(email);
  } catch {
    return { ok: false, message: "No pudimos revisar Supabase Auth para esta cuenta TEST." };
  }

  const userIds = Array.from(new Set([...(userRows ?? []).map((user) => user.id), ...authUsers.map((user) => user.id)]));

  if (userIds.includes(profile.id)) {
    return { ok: false, message: "No puedes eliminar la cuenta con la que estás administrando el sistema." };
  }

  const customerQuery = admin
    .from("customers")
    .select("id, user_id, email, contact_name")
    .ilike("email", email)
    .returns<Array<{ id: string; user_id: string | null; email: string | null; contact_name: string }>>();

  const customerByUserQuery =
    userIds.length > 0
      ? admin
          .from("customers")
          .select("id, user_id, email, contact_name")
          .in("user_id", userIds)
          .returns<Array<{ id: string; user_id: string | null; email: string | null; contact_name: string }>>()
      : Promise.resolve({ data: [], error: null });

  const [{ data: emailCustomers, error: emailCustomersError }, { data: userCustomers, error: userCustomersError }] =
    await Promise.all([customerQuery, customerByUserQuery]);

  if (emailCustomersError || userCustomersError) {
    return { ok: false, message: "No pudimos revisar los datos relacionados de la cuenta TEST." };
  }

  const customersById = new Map<string, { id: string; user_id: string | null; email: string | null; contact_name: string }>();
  for (const customer of [...(emailCustomers ?? []), ...(userCustomers ?? [])]) {
    customersById.set(customer.id, customer);
  }

  const customerIds = Array.from(customersById.keys());

  if (userIds.length === 0 && customerIds.length === 0) {
    return { ok: false, message: "No encontramos una cuenta TEST con ese correo." };
  }

  if (customerIds.length > 0) {
    await admin.from("wholesale_codes").delete().in("customer_id", customerIds);
    await admin.from("crm_notes").delete().in("customer_id", customerIds);
    await admin.from("crm_followups").delete().in("customer_id", customerIds);
  }

  for (const authUser of authUsers) {
    const { error } = await admin.auth.admin.deleteUser(authUser.id);
    if (error) {
      return { ok: false, message: "No pudimos eliminar la cuenta TEST de Supabase Auth." };
    }
  }

  if (userIds.length > 0) {
    await admin.from("users").delete().in("id", userIds);
  }

  if (customerIds.length > 0) {
    await admin.from("customers").delete().in("id", customerIds);
  }

  await writeAuditLog({
    tableName: "users",
    recordId: userIds[0] ?? null,
    action: "test_account.deleted",
    oldData: {
      email,
      user_ids: userIds,
      customer_ids: customerIds,
      deleted_by: profile.id,
    },
    newData: {
      auth_users_deleted: authUsers.length,
      customers_deleted: customerIds.length,
    },
  });

  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");
  revalidatePath("/admin/codigos-mayoristas");

  return { ok: true, message: "Cuenta TEST eliminada correctamente." };
}

