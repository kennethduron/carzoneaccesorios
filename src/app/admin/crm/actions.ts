"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { writeAuditLog } from "@/lib/audit";
import { hasEffectivePermission, isTechnicalOwner } from "@/lib/auth/permissions";
import { requirePermission, requireSession } from "@/lib/auth/session";
import { writeErrorLog } from "@/lib/error-logging";
import { processCriticalEmailQueue } from "@/lib/notifications/email-queue";
import { queueWholesaleApprovedEmail, queueWholesaleRejectedEmail } from "@/lib/notifications/customer-lifecycle-emails";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getAdminCustomerProfile } from "@/services/supabase/admin-crm.service";
import type { AppRole, AuthProfile } from "@/types/auth";
import type { CrmCustomerProfile, CrmFollowupInput, CrmFollowupStatus, CrmLeadInput, CrmNoteInput } from "@/types/crm";
import type { WholesaleCustomerType } from "@/types/wholesale";
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
  deletion_block?: DeletionBlock;
};

export type PortalAccountCandidate = {
  id: string;
  email: string | null;
  fullName: string | null;
  username: string | null;
  role: AppRole | null;
  active: boolean;
  authExists: boolean;
  linkedToThisCustomer: boolean;
  linkedToAnotherCustomer: boolean;
};

export type PortalLinkCustomerCandidate = {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  taxId: string | null;
  active: boolean;
  status: string;
  linked: boolean;
  linkedAccountEmail: string | null;
  orderCount: number;
  receivableCount: number;
  hasCreditAccount: boolean;
};

type CustomerProfileResult = {
  ok: boolean;
  message: string;
  profile: CrmCustomerProfile | null;
};

type TestAccountDeletionInput = {
  email: string;
  confirmation: string;
};

type PermanentAccountDeletionInput = {
  customerId: string;
  confirmation: string;
  reason?: string;
};

type MergeDuplicateCustomerInput = {
  sourceCustomerId: string;
  targetCustomerId: string;
};

type CustomerDeletionRow = {
  id: string;
  user_id: string | null;
  email: string | null;
  contact_name: string;
  phone: string | null;
  tax_id: string | null;
  active: boolean;
  status: string;
  is_wholesale: boolean;
  wholesale_status: string | null;
  created_at: string;
};

type DeletionUserRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  active: boolean;
  created_at: string;
  roles: { name: AppRole } | null;
};

type IdRow = { id: string };

type DeletionBlock = {
  table: string;
  condition: string;
  recordId: string | null;
  reason: string;
  record?: Record<string, unknown>;
};

const permanentDeletionRoles: AppRole[] = ["business_owner", "admin", "technical_owner"];
const protectedTechnicalEmail = "kennethduron.paz@gmail.com";
const commercialHistoryDeletionMessage = "No se puede eliminar esta cuenta porque tiene historial comercial o fiscal. Puedes suspenderla.";
const wholesaleManagementPermissionMessage = "Solo usuarios autorizados pueden cambiar el estado mayorista.";
const wholesaleManagementRoles: AppRole[] = ["technical_owner", "business_owner", "admin"];

function validateEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safePortalSearchValue(value: string) {
  const withoutFilterSyntax = ["%", "_", ",", ".", "(", ")"].reduce(
    (current, token) => current.replaceAll(token, " "),
    value.trim(),
  );
  return withoutFilterSyntax.split(" ").filter(Boolean).join(" ").slice(0, 80);
}

export async function searchPortalAccountCandidatesAction(
  customerId: string,
  query: string,
): Promise<{ ok: boolean; message: string; candidates: PortalAccountCandidate[] }> {
  await requirePermission("customers:link_portal_account");
  const customer = uuidLike(customerId, "Cliente");
  const search = safePortalSearchValue(query);

  if (!customer.ok) {
    return { ok: false, message: customer.message, candidates: [] };
  }

  if (search.length < 3) {
    return { ok: false, message: "Escribe al menos 3 caracteres para buscar una cuenta web.", candidates: [] };
  }

  const admin = getSupabaseAdminClient();
  const pattern = "%" + search + "%";
  const columns = "id, email, full_name, username, active, roles(name)";
  const [byEmail, byName, byUsername] = await Promise.all([
    admin.from("users").select(columns).ilike("email", pattern).limit(10),
    admin.from("users").select(columns).ilike("full_name", pattern).limit(10),
    admin.from("users").select(columns).ilike("username", pattern).limit(10),
  ]);

  const firstError = byEmail.error ?? byName.error ?? byUsername.error;
  if (firstError) {
    return { ok: false, message: "No fue posible buscar cuentas web.", candidates: [] };
  }

  type PortalUserRow = {
    id: string;
    email: string | null;
    full_name: string | null;
    username: string | null;
    active: boolean;
    roles: Array<{ name: AppRole }> | { name: AppRole } | null;
  };

  const candidatesById = new Map<string, PortalUserRow>();
  for (const row of [...(byEmail.data ?? []), ...(byName.data ?? []), ...(byUsername.data ?? [])] as unknown as PortalUserRow[]) {
    candidatesById.set(row.id, row);
  }

  const rows = [...candidatesById.values()].slice(0, 10);
  if (rows.length === 0) {
    return { ok: true, message: "No se encontraron cuentas web.", candidates: [] };
  }

  const ids = rows.map((row) => row.id);
  const [{ data: linkedCustomers, error: linkedError }, authChecks] = await Promise.all([
    admin.from("customers").select("id, user_id").in("user_id", ids),
    Promise.all(rows.map((row) => admin.auth.admin.getUserById(row.id))),
  ]);

  if (linkedError) {
    return { ok: false, message: "No fue posible validar el estado de vinculación.", candidates: [] };
  }

  const links = new Map(
    ((linkedCustomers ?? []) as Array<{ id: string; user_id: string | null }>)
      .filter((row) => row.user_id)
      .map((row) => [row.user_id as string, row.id]),
  );

  return {
    ok: true,
    message: rows.length === 1 ? "Se encontró 1 cuenta web." : "Se encontraron cuentas web.",
    candidates: rows.map((row, index) => ({
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      username: row.username,
      role: (Array.isArray(row.roles) ? row.roles[0]?.name : row.roles?.name) ?? null,
      active: row.active,
      authExists: !authChecks[index].error && Boolean(authChecks[index].data.user),
      linkedToThisCustomer: links.get(row.id) === customer.value,
      linkedToAnotherCustomer: Boolean(links.get(row.id) && links.get(row.id) !== customer.value),
    })),
  };
}

export async function searchCustomersForPortalLinkAction(
  query: string,
): Promise<{ ok: boolean; message: string; customers: PortalLinkCustomerCandidate[] }> {
  await requirePermission("customers:link_portal_account");
  const search = safePortalSearchValue(query);

  if (search.length < 2) {
    return { ok: false, message: "Escribe al menos 2 caracteres para buscar un cliente.", customers: [] };
  }

  const admin = getSupabaseAdminClient();
  const pattern = "%" + search + "%";
  const columns = "id, business_name, company_name, contact_name, email, phone, tax_id, active, status, user_id";
  const [byName, byBusiness, byEmail, byPhone] = await Promise.all([
    admin.from("customers").select(columns).ilike("contact_name", pattern).limit(10),
    admin.from("customers").select(columns).ilike("business_name", pattern).limit(10),
    admin.from("customers").select(columns).ilike("email", pattern).limit(10),
    admin.from("customers").select(columns).ilike("phone", pattern).limit(10),
  ]);

  const firstError = byName.error ?? byBusiness.error ?? byEmail.error ?? byPhone.error;
  if (firstError) {
    return { ok: false, message: "No fue posible buscar clientes operativos.", customers: [] };
  }

  type LinkCustomerRow = {
    id: string;
    business_name: string | null;
    company_name: string | null;
    contact_name: string;
    email: string | null;
    phone: string | null;
    tax_id: string | null;
    active: boolean;
    status: string;
    user_id: string | null;
  };

  const customersById = new Map<string, LinkCustomerRow>();
  for (const row of [
    ...(byName.data ?? []),
    ...(byBusiness.data ?? []),
    ...(byEmail.data ?? []),
    ...(byPhone.data ?? []),
  ] as LinkCustomerRow[]) {
    customersById.set(row.id, row);
  }

  const rows = [...customersById.values()].slice(0, 10);
  if (rows.length === 0) {
    return { ok: true, message: "No se encontraron clientes operativos.", customers: [] };
  }

  const customerIds = rows.map((row) => row.id);
  const linkedUserIds = rows.flatMap((row) => (row.user_id ? [row.user_id] : []));
  const [orders, receivables, creditAccounts, linkedUsers] = await Promise.all([
    admin.from("orders").select("customer_id").in("customer_id", customerIds),
    admin.from("accounts_receivable").select("customer_id").in("customer_id", customerIds),
    admin.from("customer_credit_accounts").select("customer_id").in("customer_id", customerIds),
    linkedUserIds.length
      ? admin.from("users").select("id, email").in("id", linkedUserIds)
      : Promise.resolve({ data: [] as Array<{ id: string; email: string | null }>, error: null }),
  ]);

  const aggregateError = orders.error ?? receivables.error ?? creditAccounts.error ?? linkedUsers.error;
  if (aggregateError) {
    return { ok: false, message: "No fue posible validar el resumen operativo.", customers: [] };
  }

  const countByCustomer = (values: Array<{ customer_id: string | null }>) =>
    values.reduce((counts, value) => {
      if (value.customer_id) counts.set(value.customer_id, (counts.get(value.customer_id) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
  const orderCounts = countByCustomer((orders.data ?? []) as Array<{ customer_id: string | null }>);
  const receivableCounts = countByCustomer((receivables.data ?? []) as Array<{ customer_id: string | null }>);
  const creditCustomerIds = new Set((creditAccounts.data ?? []).map((row) => row.customer_id));
  const linkedEmails = new Map((linkedUsers.data ?? []).map((row) => [row.id, row.email]));

  return {
    ok: true,
    message: rows.length === 1 ? "Se encontró 1 cliente operativo." : "Se encontraron clientes operativos.",
    customers: rows.map((row) => ({
      id: row.id,
      displayName: row.business_name || row.company_name || row.contact_name,
      email: row.email,
      phone: row.phone,
      taxId: row.tax_id,
      active: row.active,
      status: row.status,
      linked: Boolean(row.user_id),
      linkedAccountEmail: row.user_id ? linkedEmails.get(row.user_id) ?? null : null,
      orderCount: orderCounts.get(row.id) ?? 0,
      receivableCount: receivableCounts.get(row.id) ?? 0,
      hasCreditAccount: creditCustomerIds.has(row.id),
    })),
  };
}

export async function linkCustomerPortalAccountAction(input: {
  customerId: string;
  userId: string;
  reason: string;
  confirmed: boolean;
}): Promise<CrmMutationResult & { status?: string }> {
  await requirePermission("customers:link_portal_account");
  const customer = uuidLike(input.customerId, "Cliente");
  const user = uuidLike(input.userId, "Cuenta web");
  const reason = input.reason.trim();

  if (!customer.ok) return { ok: false, message: customer.message };
  if (!user.ok) return { ok: false, message: user.message };
  if (!input.confirmed) return { ok: false, message: "Confirma explícitamente la vinculación." };
  if (reason.length < 10 || reason.length > 500) {
    return { ok: false, message: "El motivo debe tener entre 10 y 500 caracteres." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("link_customer_portal_account_manual", {
    p_customer_id: customer.value,
    p_user_id: user.value,
    p_reason: reason,
    p_confirmed: true,
  });

  if (error) {
    await writeErrorLog({
      route: "/admin/vincular-cuenta-cliente",
      action: "customer_portal_link.rpc_failed",
      errorMessage: error.message,
      metadata: { code: error.code ?? null },
    });
    return { ok: false, message: "No fue posible vincular la cuenta. Revisa el estado e intenta nuevamente." };
  }

  const result = (data as Array<{ ok: boolean; status: string; message: string }> | null)?.[0];
  if (!result) {
    return { ok: false, message: "La vinculación no devolvió un resultado válido." };
  }

  if (result.ok) {
    revalidatePath("/admin/crm");
    revalidatePath("/admin/clientes");
    revalidatePath("/admin/vincular-cuenta-cliente");
    revalidatePath("/cuenta");
  }

  return { ok: result.ok, status: result.status, message: result.message };
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

function uniqueValues(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function isInternalRole(role: AppRole | null | undefined) {
  return Boolean(role && role !== "cliente");
}

function hasProtectedEmail(email: string | null | undefined) {
  return normalizeAccountEmail(email ?? "") === protectedTechnicalEmail;
}

function canManageWholesale(profile: AuthProfile) {
  return (
    wholesaleManagementRoles.includes(profile.role) &&
    hasEffectivePermission(profile.role, profile.permissions, "wholesale:manage", profile.email)
  );
}

async function auditDeniedWholesaleMutation(profile: AuthProfile, customerId: string, operation: string) {
  await writeAuditLog({
    tableName: "customers",
    recordId: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(customerId)
      ? customerId
      : null,
    action: "wholesale_management.denied",
    oldData: {
      actor_id: profile.id,
      actor_role: profile.role,
    },
    newData: {
      attempted_operation: operation,
      result: "denied",
    },
  });
}

async function getWholesaleAuditContext(profile: AuthProfile, reason: string) {
  const headerStore = await headers();
  return {
    actor_user_id: profile.id,
    actor_role: profile.role,
    changed_at: new Date().toISOString(),
    ipAddress: headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    reason,
    result: "success",
    userAgent: headerStore.get("user-agent"),
  };
}

function isAutomaticRegistrationFollowup(row: { title: string | null; interaction_type?: string | null; notes?: string | null }) {
  return (
    row.title === "Nuevo cliente registrado" ||
    (row.title === "Solicitud de cuenta mayorista" && row.interaction_type === "solicitud_mayorista") ||
    Boolean(row.notes?.includes("Cuenta creada desde registro publico"))
  );
}

function isAutomaticRegistrationNote(row: { note_type?: string | null; note?: string | null }) {
  return (
    row.note_type === "wholesale_status" ||
    Boolean(row.note?.includes("Cuenta creada desde registro publico")) ||
    Boolean(row.note?.includes("[SOLICITUD_MAYOREO]"))
  );
}

async function blockedCustomerDeletion(input: {
  profileId: string;
  customerId?: string | null;
  email?: string | null;
  block: DeletionBlock;
}): Promise<CrmMutationResult> {
  await writeAuditLog({
    tableName: "customers",
    recordId: input.customerId ?? null,
    action: "user.account_delete_blocked",
    oldData: {
      actor_id: input.profileId,
      email: input.email ?? null,
    },
    newData: {
      block: input.block,
    },
  });

  return { ok: false, message: input.block.reason, deletion_block: input.block };
}

async function addWholesaleHistoryNote(input: {
  customerId: string;
  userId: string;
  note: string;
}) {
  const admin = getSupabaseAdminClient();
  await admin.from("crm_notes").insert({
    customer_id: input.customerId,
    user_id: input.userId,
    note_type: "wholesale_status",
    note: input.note,
  });
}

async function completePendingWholesaleFollowups(customerId: string) {
  const admin = getSupabaseAdminClient();
  const completedAt = new Date().toISOString();
  const { error } = await admin
    .from("crm_followups")
    .update({
      status: "completed",
      completed_at: completedAt,
      updated_at: completedAt,
    })
    .eq("customer_id", customerId)
    .eq("interaction_type", "solicitud_mayorista")
    .eq("status", "pending");

  if (error) {
    await writeErrorLog({
      route: "/admin/crm",
      action: "crm.wholesale_followup_complete_failed",
      errorMessage: error.message,
      metadata: { customer_id: customerId },
    });
  }
}

export async function saveCrmLeadAction(input: CrmLeadInput): Promise<CrmMutationResult> {
  await requirePermission("crm:manage");

  const contactName = requireText(input.contact_name, "Cliente");
  const phone = validateHondurasPhone(input.phone);
  const estimatedValue = nonNegativeNumber(input.estimated_value, "Valor estimado");
  const monthlyAmount = nonNegativeNumber(input.monthly_amount, "Valor interno");

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

export async function getCustomerProfileAction(customerId: string): Promise<CustomerProfileResult> {
  const viewer = await requirePermission("crm:manage");

  const customer = uuidLike(customerId, "Cliente");
  if (!customer.ok) {
    return { ok: false, message: customer.message, profile: null };
  }

  try {
    const profile = await getAdminCustomerProfile(customer.value);
    if (!profile) {
      return { ok: false, message: "No encontramos el perfil del cliente.", profile: null };
    }

    if (
      profile.customer.profile_kind === "internal" &&
      !["technical_owner", "admin", "business_owner"].includes(viewer.role)
    ) {
      return { ok: false, message: "No tienes autorización para ver perfiles internos completos.", profile: null };
    }

    const canReadCredit =
      ["technical_owner", "business_owner", "admin"].includes(viewer.role) &&
      (hasEffectivePermission(viewer.role, viewer.permissions, "credit:read", viewer.email) ||
        hasEffectivePermission(viewer.role, viewer.permissions, "credit:manage", viewer.email));

    if (!canReadCredit) {
      profile.creditAccount = null;
      profile.receivables = [];
    }

    return { ok: true, message: "Perfil cargado.", profile };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "No se pudo cargar el perfil del cliente.",
      profile: null,
    };
  }
}

export async function saveCustomerCommercialCreditAction(input: {
  customerId: string;
  isCreditEnabled: boolean;
  creditLimit: number;
  termsDays: number;
  status: "active" | "suspended";
  notes?: string;
}) {
  const viewer = await requirePermission("admin:access");
  const customerId = uuidLike(input.customerId, "Cliente");
  const canManage =
    ["technical_owner", "business_owner", "admin"].includes(viewer.role) &&
    hasEffectivePermission(viewer.role, viewer.permissions, "credit:manage", viewer.email);

  if (!customerId.ok) {
    return { ok: false, message: customerId.message };
  }

  if (!canManage) {
    await writeAuditLog({
      tableName: "customer_credit_accounts",
      recordId: customerId.value,
      action: "commercial_credit.permission_denied",
      newData: {
        attempted_action: "update_credit",
        role: viewer.role,
      },
    });
    return { ok: false, message: "Solo usuarios autorizados pueden modificar crédito comercial." };
  }

  const creditLimit = Math.round(Number(input.creditLimit) * 100) / 100;
  const termsDays = Number(input.termsDays);
  const notes = (input.notes ?? "").trim();

  if (!Number.isFinite(creditLimit) || creditLimit < 0) {
    return { ok: false, message: "El límite de crédito no puede ser negativo." };
  }
  if (input.isCreditEnabled && input.status === "active" && creditLimit <= 0) {
    return { ok: false, message: "El límite de crédito debe ser mayor a cero." };
  }
  if (!Number.isInteger(termsDays) || termsDays < 1 || termsDays > 365) {
    return { ok: false, message: "El plazo de crédito debe estar entre 1 y 365 días." };
  }
  if (!["active", "suspended"].includes(input.status)) {
    return { ok: false, message: "Estado de crédito inválido." };
  }
  if (notes.length > 2000) {
    return { ok: false, message: "Las observaciones internas no pueden exceder 2000 caracteres." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_customer_commercial_credit", {
    target_customer_id: customerId.value,
    credit_enabled: input.isCreditEnabled,
    target_credit_limit: creditLimit,
    target_terms_days: termsDays,
    target_status: input.isCreditEnabled ? input.status : "suspended",
    internal_notes: notes || null,
  });

  if (error || !Array.isArray(data) || data.length === 0) {
    return { ok: false, message: error?.message || "No se pudo actualizar el crédito comercial." };
  }

  if (input.isCreditEnabled) {
    const admin = getSupabaseAdminClient();
    const { data: creditEmail } = await admin
      .from("email_queue")
      .select("id")
      .eq("idempotency_key", `credit.enabled:${customerId.value}`)
      .in("status", ["pending", "retrying"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();

    if (creditEmail?.id) {
      await processCriticalEmailQueue({
        queueIds: [creditEmail.id],
        limit: 1,
        route: "/admin/crm",
        action: "notifications.commercial_credit_enabled_immediate_send_failed",
        metadata: {
          customer_id: customerId.value,
          queue_id: creditEmail.id,
        },
      });
    }
  }

  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");
  revalidatePath("/admin/cuentas-por-cobrar");
  revalidatePath("/checkout");
  revalidatePath("/cuenta");

  return {
    ok: true,
    message: input.isCreditEnabled ? "Crédito comercial activado correctamente." : "Crédito comercial desactivado correctamente.",
  };
}

export async function saveCrmFollowupAction(input: CrmFollowupInput): Promise<CrmMutationResult> {
  const profile = await requirePermission("crm:manage");

  const followupId = input.id ? uuidLike(input.id, "Seguimiento") : null;
  const customerId = uuidLike(input.customer_id, "Cliente");
  const title = requireText(input.title, "Título");
  const dueAt = optionalDateTime(input.due_at);
  const estimatedValue = nonNegativeNumber(input.estimated_value, "Valor estimado");
  const monthlyAmount = nonNegativeNumber(input.monthly_amount, "Valor interno");
  const phone = input.phone.trim() ? validateHondurasPhone(input.phone) : { ok: true as const, value: null };

  if (followupId && !followupId.ok) {
    return { ok: false, message: followupId.message };
  }

  for (const result of [customerId, title, dueAt, estimatedValue, monthlyAmount, phone]) {
    if (!result.ok) {
      return { ok: false, message: "message" in result ? result.message : "No pudimos validar el seguimiento." };
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
    status: input.status ?? "pending",
  };

  const supabase = await getSupabaseServerClient();
  const query = followupId
    ? supabase.from("crm_followups").update(payload).eq("id", followupId.value).select("id").single<{ id: string }>()
    : supabase.from("crm_followups").insert(payload).select("id").single<{ id: string }>();
  const { data, error } = await query;

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "crm_followups",
    recordId: data.id,
    action: followupId ? "crm.followup.updated" : "crm.followup.created",
    newData: payload,
  });

  revalidatePath("/admin/crm");
  return { ok: true, message: followupId ? "Seguimiento actualizado." : "Seguimiento creado." };
}

export async function saveCrmNoteAction(input: CrmNoteInput): Promise<CrmMutationResult> {
  const profile = await requirePermission("crm:manage");

  const noteId = input.id ? uuidLike(input.id, "Nota") : null;
  const customerId = uuidLike(input.customer_id, "Cliente");
  const note = requireText(input.note, "Nota", 2000);

  if (noteId && !noteId.ok) {
    return { ok: false, message: noteId.message };
  }

  for (const result of [customerId, note]) {
    if (!result.ok) {
      return { ok: false, message: result.message };
    }
  }

  const supabase = await getSupabaseServerClient();
  const payload = {
    customer_id: customerId.value,
    user_id: profile.id,
    note_type: optionalText(input.note_type) ?? "nota",
    note: note.value,
    archived_at: null,
  };
  const query = noteId
    ? supabase.from("crm_notes").update(payload).eq("id", noteId.value).select("id").single<{ id: string }>()
    : supabase.from("crm_notes").insert(payload).select("id").single<{ id: string }>();
  const { data, error } = await query;

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "crm_notes",
    recordId: data.id,
    action: noteId ? "crm.note.updated" : "crm.note.created",
    newData: payload,
  });

  revalidatePath("/admin/crm");
  return { ok: true, message: noteId ? "Nota actualizada." : "Nota guardada en el historial." };
}

export async function archiveCrmNoteAction(id: string): Promise<CrmMutationResult> {
  await requirePermission("crm:manage");

  const noteId = uuidLike(id, "Nota");
  if (!noteId.ok) {
    return { ok: false, message: noteId.message };
  }

  const supabase = await getSupabaseServerClient();
  const archivedAt = new Date().toISOString();
  const { error } = await supabase.from("crm_notes").update({ archived_at: archivedAt }).eq("id", noteId.value);

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "crm_notes",
    recordId: noteId.value,
    action: "crm.note.archived",
    newData: { archived_at: archivedAt },
  });

  revalidatePath("/admin/crm");
  return { ok: true, message: "Nota archivada correctamente." };
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

export async function approveWholesaleRequestAction(
  customerId: string,
  wholesaleCustomerType: WholesaleCustomerType,
): Promise<CrmMutationResult> {
  const profile = await requireSession();

  if (!canManageWholesale(profile)) {
    await auditDeniedWholesaleMutation(profile, customerId, "approve");
    return { ok: false, message: wholesaleManagementPermissionMessage };
  }

  if (!["new", "existing"].includes(wholesaleCustomerType)) {
    return { ok: false, message: "Selecciona un tipo mayorista válido." };
  }

  const customer = uuidLike(customerId, "Cliente");
  if (!customer.ok) {
    return { ok: false, message: customer.message };
  }

  const admin = getSupabaseAdminClient();
  const { data: customerRow, error: customerError } = await admin
    .from("customers")
    .select(
      "id, email, business_name, company_name, contact_name, phone, notes, wholesale_status, wholesale_customer_type, wholesale_first_purchase_completed, is_wholesale, status, active",
    )
    .eq("id", customer.value)
    .maybeSingle<{
      id: string;
      email: string | null;
      business_name: string | null;
      company_name: string | null;
      contact_name: string;
      phone: string | null;
      notes: string | null;
      wholesale_status: string | null;
      wholesale_customer_type: WholesaleCustomerType;
      wholesale_first_purchase_completed: boolean;
      is_wholesale: boolean;
      status: string;
      active: boolean;
    }>();

  if (customerError || !customerRow) {
    return { ok: false, message: "No pudimos encontrar la solicitud mayorista." };
  }

  const email = customerRow.email?.trim().toLowerCase() ?? "";
  const nextWholesaleStatus = "approved";
  const approvedAt = new Date().toISOString();

  const { error: updateError } = await admin
    .from("customers")
    .update({
      business_name: customerRow.business_name ?? customerRow.company_name ?? customerRow.contact_name,
      company_name: customerRow.company_name ?? customerRow.business_name ?? customerRow.contact_name,
      is_wholesale: true,
      wholesale_status: nextWholesaleStatus,
      wholesale_customer_type: wholesaleCustomerType,
      wholesale_approved_at: approvedAt,
      wholesale_approved_notice_seen: false,
      status: "active",
      active: true,
      lead_status: "cliente",
      notes: customerRow.notes,
    })
    .eq("id", customer.value);

  if (updateError) {
    return { ok: false, message: "No pudimos aprobar la solicitud mayorista." };
  }

  const auditContext = await getWholesaleAuditContext(profile, "Solicitud mayorista aprobada.");
  await writeAuditLog({
    tableName: "customers",
    recordId: customer.value,
    action: `wholesale_request.approved_${wholesaleCustomerType}`,
    oldData: {
      is_wholesale: customerRow.is_wholesale,
      wholesale_status: customerRow.wholesale_status,
      wholesale_customer_type: customerRow.wholesale_customer_type,
      wholesale_first_purchase_completed: customerRow.wholesale_first_purchase_completed,
      status: customerRow.status,
      active: customerRow.active,
    },
    newData: {
      is_wholesale: true,
      wholesale_status: nextWholesaleStatus,
      wholesale_customer_type: wholesaleCustomerType,
      wholesale_approved_at: approvedAt,
      wholesale_approved_notice_seen: false,
      status: "active",
      active: true,
      audit_context: auditContext,
    },
    ipAddress: auditContext.ipAddress,
    userAgent: auditContext.userAgent,
  });

  await addWholesaleHistoryNote({
    customerId: customer.value,
    userId: profile.id,
    note: `Solicitud aprobada como mayorista ${wholesaleCustomerType === "existing" ? "existente" : "nuevo"}.`,
  });

  await completePendingWholesaleFollowups(customer.value);
  if (email) {
    await queueWholesaleApprovedEmail({
      customerId: customer.value,
      email,
      name: customerRow.contact_name,
      wholesaleCustomerType,
    });
  }

  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");
  revalidatePath("/admin/clientes-mayoristas");

  return {
    ok: true,
    message: `Mayorista ${wholesaleCustomerType === "existing" ? "existente" : "nuevo"} aprobado. La vinculación con una cuenta web permanece manual y separada.`,
  };
}

export async function changeWholesaleCustomerTypeAction(
  customerId: string,
  wholesaleCustomerType: WholesaleCustomerType,
): Promise<CrmMutationResult> {
  const profile = await requireSession();

  if (!canManageWholesale(profile)) {
    await auditDeniedWholesaleMutation(profile, customerId, "change_type");
    return { ok: false, message: wholesaleManagementPermissionMessage };
  }

  if (!["new", "existing"].includes(wholesaleCustomerType)) {
    return { ok: false, message: "Selecciona un tipo mayorista válido." };
  }

  const customer = uuidLike(customerId, "Cliente");
  if (!customer.ok) {
    return { ok: false, message: customer.message };
  }

  const admin = getSupabaseAdminClient();
  const { data: customerRow, error: customerError } = await admin
    .from("customers")
    .select(
      "id, wholesale_status, wholesale_customer_type, wholesale_first_purchase_completed, wholesale_first_purchase_completed_at",
    )
    .eq("id", customer.value)
    .maybeSingle<{
      id: string;
      wholesale_status: string | null;
      wholesale_customer_type: WholesaleCustomerType;
      wholesale_first_purchase_completed: boolean;
      wholesale_first_purchase_completed_at: string | null;
    }>();

  if (customerError || !customerRow) {
    return { ok: false, message: "No pudimos encontrar el cliente mayorista." };
  }

  if (customerRow.wholesale_status !== "approved" && customerRow.wholesale_status !== "suspended") {
    return { ok: false, message: "Solo puedes cambiar el tipo de una cuenta mayorista aprobada o suspendida." };
  }

  if (customerRow.wholesale_customer_type === wholesaleCustomerType) {
    return { ok: true, message: "El cliente ya tiene ese tipo mayorista." };
  }

  let completed = customerRow.wholesale_first_purchase_completed;
  let completedAt = customerRow.wholesale_first_purchase_completed_at;

  if (wholesaleCustomerType === "new" && !completed) {
    const { data: settingsRow } = await admin
      .from("company_settings")
      .select("first_wholesale_minimum")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle<{ first_wholesale_minimum: number | null }>();
    const firstWholesaleMinimum = Math.max(0, Number(settingsRow?.first_wholesale_minimum ?? 10000));
    const { data: previousOrders } = await admin
      .from("orders")
      .select("created_at, subtotal, total")
      .eq("customer_id", customer.value)
      .eq("price_mode", "wholesale")
      .not("status", "in", '("cancelado","cancelled")')
      .order("created_at", { ascending: true })
      .returns<Array<{ created_at: string; subtotal: number | null; total: number | null }>>();
    const firstValidOrder = (previousOrders ?? []).find(
      (order) => firstWholesaleMinimum <= 0 || Number(order.total ?? order.subtotal ?? 0) >= firstWholesaleMinimum,
    );
    completed = Boolean(firstValidOrder);
    completedAt = firstValidOrder?.created_at ?? null;
  }

  const { error: updateError } = await admin
    .from("customers")
    .update({
      wholesale_customer_type: wholesaleCustomerType,
      wholesale_first_purchase_completed: completed,
      wholesale_first_purchase_completed_at: completedAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", customer.value);

  if (updateError) {
    return { ok: false, message: "No pudimos cambiar el tipo mayorista." };
  }

  const note = `Tipo mayorista cambiado de ${customerRow.wholesale_customer_type === "existing" ? "existente" : "nuevo"} a ${
    wholesaleCustomerType === "existing" ? "existente" : "nuevo"
  }.`;
  const auditContext = await getWholesaleAuditContext(profile, note);
  await writeAuditLog({
    tableName: "customers",
    recordId: customer.value,
    action: `wholesale.type_changed_${customerRow.wholesale_customer_type}_to_${wholesaleCustomerType}`,
    oldData: {
      wholesale_customer_type: customerRow.wholesale_customer_type,
      wholesale_first_purchase_completed: customerRow.wholesale_first_purchase_completed,
      wholesale_first_purchase_completed_at: customerRow.wholesale_first_purchase_completed_at,
    },
    newData: {
      wholesale_customer_type: wholesaleCustomerType,
      wholesale_first_purchase_completed: completed,
      wholesale_first_purchase_completed_at: completedAt,
      audit_context: auditContext,
    },
    ipAddress: auditContext.ipAddress,
    userAgent: auditContext.userAgent,
  });
  await addWholesaleHistoryNote({ customerId: customer.value, userId: profile.id, note });

  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");
  revalidatePath("/admin/clientes-mayoristas");
  revalidatePath("/cuenta");
  revalidatePath("/catalogo");

  return {
    ok: true,
    message:
      wholesaleCustomerType === "existing"
        ? "Tipo actualizado a mayorista existente. Ya no se exige la primera compra mínima."
        : completed
          ? "Tipo actualizado a mayorista nuevo. La primera compra ya consta como completada."
          : "Tipo actualizado a mayorista nuevo. Se aplicará la primera compra mínima de L 10,000.",
  };
}

async function setWholesaleStatusAction(input: {
  customerId: string;
  status: "rejected" | "suspended" | "approved";
  action: string;
  note: string;
  successMessage: string;
}): Promise<CrmMutationResult> {
  const profile = await requireSession();
  const customer = uuidLike(input.customerId, "Cliente");

  if (!canManageWholesale(profile)) {
    await auditDeniedWholesaleMutation(profile, input.customerId, input.action);
    return { ok: false, message: wholesaleManagementPermissionMessage };
  }

  if (!customer.ok) {
    return { ok: false, message: customer.message };
  }

  const admin = getSupabaseAdminClient();
  const { data: customerRow, error: customerError } = await admin
    .from("customers")
    .select("id, email, contact_name, is_wholesale, wholesale_status, status, active")
    .eq("id", customer.value)
    .maybeSingle<{
      id: string;
      email: string | null;
      contact_name: string;
      is_wholesale: boolean;
      wholesale_status: string | null;
      status: string;
      active: boolean;
    }>();

  if (customerError || !customerRow) {
    return { ok: false, message: "No pudimos encontrar el cliente mayorista." };
  }

  const isApproved = input.status === "approved";
  const nextCustomerStatus = "active";
  const changedAt = new Date().toISOString();
  const { error: updateError } = await admin
    .from("customers")
    .update({
      is_wholesale: isApproved,
      wholesale_status: input.status,
      wholesale_approved_at: isApproved ? changedAt : null,
      wholesale_approved_notice_seen: isApproved ? false : true,
      status: nextCustomerStatus,
      active: true,
      updated_at: changedAt,
    })
    .eq("id", customer.value);

  if (updateError) {
    return { ok: false, message: "No pudimos actualizar el estado mayorista." };
  }

  const auditContext = await getWholesaleAuditContext(profile, input.note);
  await writeAuditLog({
    tableName: "customers",
    recordId: customer.value,
    action: input.action,
    oldData: {
      is_wholesale: customerRow.is_wholesale,
      wholesale_status: customerRow.wholesale_status,
      status: customerRow.status,
      active: customerRow.active,
    },
    newData: {
      is_wholesale: isApproved,
      wholesale_status: input.status,
      wholesale_approved_at: isApproved ? changedAt : null,
      wholesale_approved_notice_seen: isApproved ? false : true,
      status: nextCustomerStatus,
      active: true,
      audit_context: auditContext,
    },
    ipAddress: auditContext.ipAddress,
    userAgent: auditContext.userAgent,
  });

  await addWholesaleHistoryNote({
    customerId: customer.value,
    userId: profile.id,
    note: input.note,
  });

  if (input.action === "wholesale_request.rejected") {
    await completePendingWholesaleFollowups(customer.value);
    await queueWholesaleRejectedEmail({
      customerId: customer.value,
      email: customerRow.email,
      name: customerRow.contact_name,
    });
  }

  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");
  revalidatePath("/admin/clientes-mayoristas");

  return { ok: true, message: input.successMessage };
}

export async function rejectWholesaleRequestAction(customerId: string): Promise<CrmMutationResult> {
  return setWholesaleStatusAction({
    customerId,
    status: "rejected",
    action: "wholesale_request.rejected",
    note: "Solicitud mayorista rechazada.",
    successMessage: "Solicitud mayorista rechazada.",
  });
}

export async function suspendWholesaleAccessAction(customerId: string): Promise<CrmMutationResult> {
  return setWholesaleStatusAction({
    customerId,
    status: "suspended",
    action: "wholesale_access.suspended",
    note: "Acceso mayorista suspendido.",
    successMessage: "Acceso mayorista suspendido.",
  });
}

export async function reactivateWholesaleAccessAction(customerId: string): Promise<CrmMutationResult> {
  return setWholesaleStatusAction({
    customerId,
    status: "approved",
    action: "wholesale_access.reactivated",
    note: "Acceso mayorista reactivado.",
    successMessage: "Acceso mayorista reactivado.",
  });
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

export async function reactivateCustomerAccountAction(customerId: string): Promise<CrmMutationResult> {
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
      active: true,
      status: "active",
      notes: [customerRow.notes, customerRow.contact_name ? `Cuenta reactivada desde admin para ${customerRow.contact_name}.` : null]
        .filter(Boolean)
        .join("\n"),
    })
    .eq("id", customer.value);

  if (updateCustomerError) {
    return { ok: false, message: "No pudimos reactivar la cuenta del cliente." };
  }

  if (customerRow.user_id) {
    await admin.from("users").update({ active: true }).eq("id", customerRow.user_id);
  }

  await writeAuditLog({
    tableName: "customers",
    recordId: customer.value,
    action: "customer_account.reactivated",
    oldData: {
      active: customerRow.active,
      status: customerRow.status,
    },
    newData: {
      active: true,
      status: "active",
      email: customerRow.email,
      user_id: customerRow.user_id,
    },
  });

  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");

  return { ok: true, message: "Cuenta reactivada correctamente." };
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

export async function deleteCustomerAccountPermanentlyAction(input: PermanentAccountDeletionInput): Promise<CrmMutationResult> {
  const profile = await requireSession();

  if (!permanentDeletionRoles.includes(profile.role)) {
    return { ok: false, message: "No tienes autorización para eliminar cuentas de cliente." };
  }

  if (!profile.permissions.includes("customers:manage") && profile.role !== "admin" && profile.role !== "technical_owner") {
    return { ok: false, message: "No tienes autorización para eliminar cuentas de cliente." };
  }

  const customer = uuidLike(input.customerId, "Cliente");
  if (!customer.ok) {
    return { ok: false, message: customer.message };
  }

  if (input.confirmation.trim() !== "ELIMINAR CUENTA") {
    return { ok: false, message: "Escribe ELIMINAR CUENTA para confirmar esta acción." };
  }

  const admin = getSupabaseAdminClient();
  const { data: targetCustomer, error: targetCustomerError } = await admin
    .from("customers")
    .select("id, user_id, email, contact_name, phone, tax_id, active, status, is_wholesale, wholesale_status, created_at")
    .eq("id", customer.value)
    .maybeSingle<CustomerDeletionRow>();

  if (targetCustomerError || !targetCustomer) {
    return { ok: false, message: "No pudimos encontrar la cuenta del cliente." };
  }

  const email = normalizeAccountEmail(targetCustomer.email ?? "");
  if (!email || !validateEmail(email)) {
    return { ok: false, message: "Esta cuenta no tiene un correo válido para liberar." };
  }

  if (hasProtectedEmail(email)) {
    return blockedCustomerDeletion({
      profileId: profile.id,
      customerId: targetCustomer.id,
      email,
      block: {
        table: "customers",
        condition: "email is protected technical owner account",
        recordId: targetCustomer.id,
        reason: "No se puede eliminar la cuenta técnica protegida.",
        record: { email },
      },
    });
  }

  let authUsers: Array<{ id: string; email: string | undefined }>;
  try {
    authUsers = await findAuthUsersByEmail(email);
  } catch {
    return { ok: false, message: "No pudimos revisar Supabase Auth para esta cuenta." };
  }

  const initialUserIds = uniqueValues([targetCustomer.user_id, ...authUsers.map((user) => user.id)]);
  const userByIdQuery =
    initialUserIds.length > 0
      ? admin
          .from("users")
          .select("id, email, full_name, phone, active, created_at, roles(name)")
          .in("id", initialUserIds)
          .returns<DeletionUserRow[]>()
      : Promise.resolve({ data: [], error: null });
  const userByEmailQuery = admin
    .from("users")
    .select("id, email, full_name, phone, active, created_at, roles(name)")
    .ilike("email", email)
    .returns<DeletionUserRow[]>();

  const [{ data: usersById, error: usersByIdError }, { data: usersByEmail, error: usersByEmailError }] = await Promise.all([
    userByIdQuery,
    userByEmailQuery,
  ]);

  if (usersByIdError || usersByEmailError) {
    return { ok: false, message: "No pudimos revisar el perfil de usuario relacionado." };
  }

  const usersByMap = new Map<string, DeletionUserRow>();
  for (const user of [...(usersById ?? []), ...(usersByEmail ?? [])]) {
    usersByMap.set(user.id, user);
  }

  const candidateUserIds = uniqueValues([...initialUserIds, ...Array.from(usersByMap.keys())]);
  const customerByUserQuery =
    candidateUserIds.length > 0
      ? admin
          .from("customers")
          .select("id, user_id, email, contact_name, phone, tax_id, active, status, is_wholesale, wholesale_status, created_at")
          .in("user_id", candidateUserIds)
          .returns<CustomerDeletionRow[]>()
      : Promise.resolve({ data: [], error: null });
  const customerByEmailQuery = admin
    .from("customers")
    .select("id, user_id, email, contact_name, phone, tax_id, active, status, is_wholesale, wholesale_status, created_at")
    .ilike("email", email)
    .returns<CustomerDeletionRow[]>();

  const [{ data: customersByUser, error: customersByUserError }, { data: customersByEmail, error: customersByEmailError }] =
    await Promise.all([customerByUserQuery, customerByEmailQuery]);

  if (customersByUserError || customersByEmailError) {
    return { ok: false, message: "No pudimos revisar los clientes relacionados." };
  }

  const customersByMap = new Map<string, CustomerDeletionRow>();
  for (const row of [targetCustomer, ...(customersByUser ?? []), ...(customersByEmail ?? [])]) {
    customersByMap.set(row.id, row);
  }

  const customerRows = Array.from(customersByMap.values());
  const customerIds = customerRows.map((row) => row.id);
  const userIds = uniqueValues([...candidateUserIds, ...customerRows.map((row) => row.user_id)]);

  const finalUserQuery =
    userIds.length > 0
      ? admin
          .from("users")
          .select("id, email, full_name, phone, active, created_at, roles(name)")
          .in("id", userIds)
          .returns<DeletionUserRow[]>()
      : Promise.resolve({ data: [], error: null });
  const { data: finalUsers, error: finalUsersError } = await finalUserQuery;

  if (finalUsersError) {
    return { ok: false, message: "No pudimos revisar roles relacionados." };
  }

  for (const user of finalUsers ?? []) {
    usersByMap.set(user.id, user);
  }

  if (userIds.includes(profile.id)) {
    return blockedCustomerDeletion({
      profileId: profile.id,
      customerId: targetCustomer.id,
      email,
      block: {
        table: "users",
        condition: "target user id matches current admin session",
        recordId: profile.id,
        reason: "No puedes eliminar la cuenta con la que estás administrando el sistema.",
      },
    });
  }

  const protectedUser = Array.from(usersByMap.values()).find((user) => hasProtectedEmail(user.email));
  if (protectedUser || authUsers.some((user) => hasProtectedEmail(user.email))) {
    const protectedRecord = protectedUser ?? authUsers.find((user) => hasProtectedEmail(user.email));
    return blockedCustomerDeletion({
      profileId: profile.id,
      customerId: targetCustomer.id,
      email,
      block: {
        table: protectedUser ? "users" : "auth.users",
        condition: "email is protected technical owner account",
        recordId: protectedRecord?.id ?? null,
        reason: "No se puede eliminar la cuenta técnica protegida.",
        record: { email: protectedRecord?.email ?? email },
      },
    });
  }

  const internalUser = Array.from(usersByMap.values()).find((user) => isInternalRole(user.roles?.name));
  if (internalUser) {
    return blockedCustomerDeletion({
      profileId: profile.id,
      customerId: targetCustomer.id,
      email,
      block: {
        table: "users",
        condition: "roles.name is internal",
        recordId: internalUser.id,
        reason: "No se pueden eliminar usuarios internos desde esta acción. Usa suspensión o gestión de roles.",
        record: { email: internalUser.email, role: internalUser.roles?.name ?? null },
      },
    });
  }

  if (customerIds.length > 0) {
    const { data: orderByCustomer, error: orderByCustomerError } = await admin
      .from("orders")
      .select("id, customer_id, user_id, email, order_number, status")
      .in("customer_id", customerIds)
      .limit(1)
      .returns<Array<IdRow & Record<string, unknown>>>();
    if (orderByCustomerError) {
      return { ok: false, message: "No pudimos revisar pedidos relacionados." };
    }
    if (orderByCustomer?.[0]) {
      return blockedCustomerDeletion({
        profileId: profile.id,
        customerId: targetCustomer.id,
        email,
        block: {
          table: "orders",
          condition: "orders.customer_id in related customer ids",
          recordId: orderByCustomer[0].id,
          reason: commercialHistoryDeletionMessage,
          record: orderByCustomer[0],
        },
      });
    }
  }

  if (userIds.length > 0) {
    const { data: orderByUser, error: orderByUserError } = await admin
      .from("orders")
      .select("id, customer_id, user_id, email, order_number, status")
      .in("user_id", userIds)
      .limit(1)
      .returns<Array<IdRow & Record<string, unknown>>>();
    if (orderByUserError) {
      return { ok: false, message: "No pudimos revisar pedidos relacionados." };
    }
    if (orderByUser?.[0]) {
      return blockedCustomerDeletion({
        profileId: profile.id,
        customerId: targetCustomer.id,
        email,
        block: {
          table: "orders",
          condition: "orders.user_id in related user ids",
          recordId: orderByUser[0].id,
          reason: commercialHistoryDeletionMessage,
          record: orderByUser[0],
        },
      });
    }
  }

  const { data: orderByEmail, error: orderByEmailError } = await admin
    .from("orders")
    .select("id, customer_id, user_id, email, order_number, status")
    .ilike("email", email)
    .limit(1)
    .returns<Array<IdRow & Record<string, unknown>>>();
  if (orderByEmailError) {
    return { ok: false, message: "No pudimos revisar pedidos relacionados." };
  }
  if (orderByEmail?.[0]) {
    return blockedCustomerDeletion({
      profileId: profile.id,
      customerId: targetCustomer.id,
      email,
      block: {
        table: "orders",
        condition: "orders.email matches account email",
        recordId: orderByEmail[0].id,
        reason: commercialHistoryDeletionMessage,
        record: orderByEmail[0],
      },
    });
  }

  if (customerIds.length > 0) {
    const [
      { data: paymentRows, error: paymentRowsError },
      { data: invoiceRows, error: invoiceRowsError },
      { data: noteRows, error: noteRowsError },
      { data: followupRows, error: followupRowsError },
      { data: wholesaleCodeRows, error: wholesaleCodeRowsError },
    ] = await Promise.all([
      admin
        .from("payments")
        .select("id, customer_id, order_id, status, amount, transfer_receipt_url, transfer_receipt_public_id")
        .in("customer_id", customerIds)
        .limit(1)
        .returns<Array<IdRow & Record<string, unknown>>>(),
      admin
        .from("invoices")
        .select("id, customer_id, order_id, invoice_number, status, customer_rtn")
        .in("customer_id", customerIds)
        .limit(1)
        .returns<Array<IdRow & Record<string, unknown>>>(),
      admin
        .from("crm_notes")
        .select("id, customer_id, order_id, note_type, note")
        .in("customer_id", customerIds)
        .returns<Array<IdRow & { order_id: string | null; note_type: string | null; note: string | null }>>(),
      admin
        .from("crm_followups")
        .select("id, customer_id, order_id, title, interaction_type, notes")
        .in("customer_id", customerIds)
        .returns<Array<IdRow & { order_id: string | null; title: string | null; interaction_type: string | null; notes: string | null }>>(),
      admin
        .from("wholesale_codes")
        .select("id, customer_id, used_count, status, active, last_used_at")
        .in("customer_id", customerIds)
        .returns<Array<IdRow & { used_count: number | null; last_used_at: string | null; status: string | null; active: boolean | null }>>(),
    ]);

    if (paymentRowsError || invoiceRowsError || noteRowsError || followupRowsError || wholesaleCodeRowsError) {
      return { ok: false, message: "No pudimos validar historial crítico antes de eliminar." };
    }

    if (paymentRows?.[0]) {
      return blockedCustomerDeletion({
        profileId: profile.id,
        customerId: targetCustomer.id,
        email,
        block: {
          table: "payments",
          condition: "payments.customer_id in related customer ids",
          recordId: paymentRows[0].id,
          reason: commercialHistoryDeletionMessage,
          record: paymentRows[0],
        },
      });
    }

    if (invoiceRows?.[0]) {
      return blockedCustomerDeletion({
        profileId: profile.id,
        customerId: targetCustomer.id,
        email,
        block: {
          table: "invoices",
          condition: "invoices.customer_id in related customer ids",
          recordId: invoiceRows[0].id,
          reason: commercialHistoryDeletionMessage,
          record: invoiceRows[0],
        },
      });
    }

    const criticalNote = (noteRows ?? []).find((row) => row.order_id || !isAutomaticRegistrationNote(row));
    if (criticalNote) {
      return blockedCustomerDeletion({
        profileId: profile.id,
        customerId: targetCustomer.id,
        email,
        block: {
          table: "crm_notes",
          condition: criticalNote.order_id ? "crm_notes.order_id is not null" : "crm_notes is not automatic registration CRM",
          recordId: criticalNote.id,
          reason: commercialHistoryDeletionMessage,
          record: criticalNote,
        },
      });
    }

    const criticalFollowup = (followupRows ?? []).find((row) => row.order_id || !isAutomaticRegistrationFollowup(row));
    if (criticalFollowup) {
      return blockedCustomerDeletion({
        profileId: profile.id,
        customerId: targetCustomer.id,
        email,
        block: {
          table: "crm_followups",
          condition: criticalFollowup.order_id ? "crm_followups.order_id is not null" : "crm_followups is not automatic registration CRM",
          recordId: criticalFollowup.id,
          reason: commercialHistoryDeletionMessage,
          record: criticalFollowup,
        },
      });
    }

    const usedWholesaleCode = (wholesaleCodeRows ?? []).find((row) => Number(row.used_count ?? 0) > 0 || Boolean(row.last_used_at));
    if (usedWholesaleCode) {
      return blockedCustomerDeletion({
        profileId: profile.id,
        customerId: targetCustomer.id,
        email,
        block: {
          table: "wholesale_codes",
          condition: "used_count > 0 or last_used_at is not null",
          recordId: usedWholesaleCode.id,
          reason: commercialHistoryDeletionMessage,
          record: usedWholesaleCode,
        },
      });
    }
  }

  const { data: relatedAuditLogs } =
    [...customerIds, ...userIds].length > 0
      ? await admin.from("audit_logs").select("id").in("record_id", uniqueValues([...customerIds, ...userIds])).returns<IdRow[]>()
      : { data: [] as IdRow[] };

  if (customerIds.length > 0) {
    await admin.from("wholesale_codes").delete().in("customer_id", customerIds);
    await admin.from("crm_notes").delete().in("customer_id", customerIds);
    await admin.from("crm_followups").delete().in("customer_id", customerIds);
  }

  const authUserIds = uniqueValues([...authUsers.map((user) => user.id), ...userIds]);
  for (const authUserId of authUserIds) {
    const { error } = await admin.auth.admin.deleteUser(authUserId);
    if (error && !error.message.toLowerCase().includes("not found")) {
      return { ok: false, message: "No pudimos eliminar la cuenta de Supabase Auth." };
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
    action: "user.account_deleted",
    oldData: {
      deleted_user_ids: userIds,
      deleted_customer_ids: customerIds,
      email,
      customer_name: targetCustomer.contact_name,
      actor_id: profile.id,
      reason: input.reason?.trim() || "Eliminación permanente solicitada desde admin.",
    },
    newData: {
      auth_users_deleted: authUserIds.length,
      customers_deleted: customerIds.length,
      validation: {
        orders: 0,
        payments: 0,
        invoices: 0,
        critical_crm_items: 0,
        used_wholesale_codes: 0,
        approved_or_suspended_wholesale: 0,
        tax_id_only_blocked: false,
        related_audit_logs_preserved: relatedAuditLogs?.length ?? 0,
      },
    },
  });

  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");
  revalidatePath("/admin/clientes-mayoristas");
  revalidatePath("/admin/seguridad");

  return { ok: true, message: "Cuenta eliminada permanentemente. El correo puede registrarse nuevamente." };
}

export async function deleteTestAccountAction(input: TestAccountDeletionInput): Promise<CrmMutationResult> {
  const profile = await requirePermission("technical:tools");

  if (!isTechnicalOwner(profile.role, profile.email)) {
    return { ok: false, message: "Solo el administrador técnico puede eliminar cuentas TEST." };
  }

  const email = normalizeAccountEmail(input.email);
  if (!validateEmail(email)) {
    return { ok: false, message: "Ingresa un correo válido para eliminar la cuenta TEST." };
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
  revalidatePath("/admin/clientes-mayoristas");

  return { ok: true, message: "Cuenta TEST eliminada correctamente." };
}

