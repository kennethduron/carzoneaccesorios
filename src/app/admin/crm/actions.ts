"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { hasEffectivePermission, isTechnicalOwner } from "@/lib/auth/permissions";
import { requirePermission, requireSession } from "@/lib/auth/session";
import { writeErrorLog } from "@/lib/error-logging";
import { processCriticalEmailQueue } from "@/lib/notifications/email-queue";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getAdminCustomerProfile } from "@/services/supabase/admin-crm.service";
import type { AppRole, AuthProfile } from "@/types/auth";
import type { CrmCustomerIdentityInput, CrmCustomerProfile, CrmFollowupInput, CrmFollowupStatus, CrmLeadInput, CrmNoteInput } from "@/types/crm";
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
  code?: string;
  currentVersion?: number;
  commercialVersion?: number;
  firstPurchaseMinimum?: number;
  deletion_block?: DeletionBlock;
};

export type CustomerIdentityMutationResult = CrmMutationResult & {
  status?: string;
  fieldErrors?: Partial<Record<keyof CrmCustomerIdentityInput, string>>;
  profile?: CrmCustomerProfile | null;
};

export type PortalLinkEvidence = {
  source: "authenticated_wholesale_request" | "authenticated_portal_registration" | "manual_verified_identity";
  reference: string;
  label: string;
  exact: boolean;
};

export type PortalAccountCandidate = {
  id: string;
  email: string | null;
  phone: string | null;
  fullName: string | null;
  username: string | null;
  role: AppRole | null;
  active: boolean;
  authExists: boolean;
  linkedToThisCustomer: boolean;
  linkedToAnotherCustomer: boolean;
  createdAt: string;
  emailConfirmedAt: string | null;
  evidence: PortalLinkEvidence[];
};

export type PortalLinkCustomerCandidate = {
  id: string;
  displayName: string;
  email: string | null;
  contactName: string;
  phone: string | null;
  taxId: string | null;
  active: boolean;
  city: string | null;
  status: string;
  linked: boolean;
  linkedAccountEmail: string | null;
  orderCount: number;
  receivableCount: number;
  invoiceCount: number;
  hasCreditAccount: boolean;
  commercialVersion: number;
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

const customerIdentityRoles: AppRole[] = ["technical_owner", "business_owner", "admin"];
const portalLinkRoles: AppRole[] = ["technical_owner", "business_owner", "admin"];
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
  const profile = await requireSession();
  if (
    !portalLinkRoles.includes(profile.role) ||
    !hasEffectivePermission(profile.role, profile.permissions, "customers:link_portal_account", profile.email)
  ) {
    return { ok: false, message: "No tienes permiso para vincular cuentas del portal.", candidates: [] };
  }

  const customer = uuidLike(customerId, "Cliente");
  const search = safePortalSearchValue(query);
  if (!customer.ok) return { ok: false, message: customer.message, candidates: [] };
  if (search.length < 3) {
    return { ok: false, message: "Escribe al menos 3 caracteres para buscar una cuenta web.", candidates: [] };
  }

  const admin = getSupabaseAdminClient();
  const pattern = `%${search}%`;
  const columns = "id, email, full_name, username, phone, active, created_at, roles(name)";
  const [byEmail, byName, byUsername, byPhone] = await Promise.all([
    admin.from("users").select(columns).eq("active", true).eq("roles.name", "cliente").ilike("email", pattern).limit(10),
    admin.from("users").select(columns).eq("active", true).eq("roles.name", "cliente").ilike("full_name", pattern).limit(10),
    admin.from("users").select(columns).eq("active", true).eq("roles.name", "cliente").ilike("username", pattern).limit(10),
    admin.from("users").select(columns).eq("active", true).eq("roles.name", "cliente").ilike("phone", pattern).limit(10),
  ]);

  const firstError = byEmail.error ?? byName.error ?? byUsername.error ?? byPhone.error;
  if (firstError) return { ok: false, message: "No fue posible buscar cuentas web.", candidates: [] };

  type PortalUserRow = {
    id: string;
    email: string | null;
    full_name: string | null;
    username: string | null;
    phone: string | null;
    active: boolean;
    created_at: string;
    roles: Array<{ name: AppRole }> | { name: AppRole } | null;
  };

  const rowsById = new Map<string, PortalUserRow>();
  for (const row of [
    ...(byEmail.data ?? []),
    ...(byName.data ?? []),
    ...(byUsername.data ?? []),
    ...(byPhone.data ?? []),
  ] as unknown as PortalUserRow[]) {
    const role = (Array.isArray(row.roles) ? row.roles[0]?.name : row.roles?.name) ?? null;
    if (row.active && role === "cliente") rowsById.set(row.id, row);
  }

  const rows = [...rowsById.values()].slice(0, 10);
  if (rows.length === 0) return { ok: true, message: "No se encontraron cuentas web elegibles.", candidates: [] };

  const ids = rows.map((row) => row.id);
  const [{ data: linkedCustomers, error: linkedError }, authChecks, { data: auditEvidence, error: auditEvidenceError }] = await Promise.all([
    admin.from("customers").select("id, user_id").in("user_id", ids),
    Promise.all(rows.map((row) => admin.auth.admin.getUserById(row.id))),
    admin
      .from("audit_logs")
      .select("id, user_id, action, created_at")
      .eq("table_name", "customers")
      .eq("record_id", customer.value)
      .in("user_id", ids)
      .in("action", ["wholesale_request.created_from_account", "customer_portal_registration.created", "auth.registration.customer_evidence"])
      .order("created_at", { ascending: false }),
  ]);
  if (linkedError || auditEvidenceError) return { ok: false, message: "No fue posible validar el estado de vinculación.", candidates: [] };

  const links = new Map(
    ((linkedCustomers ?? []) as Array<{ id: string; user_id: string | null }>)
      .filter((row) => row.user_id)
      .map((row) => [row.user_id as string, row.id]),
  );
  const exactEvidenceByUser = new Map<string, PortalLinkEvidence>();
  for (const evidence of auditEvidence ?? []) {
    if (!evidence.user_id || exactEvidenceByUser.has(evidence.user_id)) continue;
    const wholesaleRequest = evidence.action === "wholesale_request.created_from_account";
    exactEvidenceByUser.set(evidence.user_id, {
      source: wholesaleRequest ? "authenticated_wholesale_request" : "authenticated_portal_registration",
      reference: `audit:${evidence.id}`,
      label: wholesaleRequest ? "Solicitud mayorista autenticada" : "Registro autenticado del portal",
      exact: true,
    });
  }

  const candidates = rows.flatMap((row, index): PortalAccountCandidate[] => {
    const authUser = authChecks[index].data.user;
    const linkedCustomerId = links.get(row.id) ?? null;
    const exactEvidence = exactEvidenceByUser.get(row.id);
    const evidence: PortalLinkEvidence[] = exactEvidence ? [exactEvidence] : [];
    evidence.push({
      source: "manual_verified_identity",
      reference: `manual:${customer.value}:${row.id}`,
      label: "Identidad verificada manualmente",
      exact: false,
    });
    if (authChecks[index].error || !authUser || (linkedCustomerId && linkedCustomerId !== customer.value)) return [];
    return [{
      id: row.id,
      email: row.email,
      phone: row.phone,
      fullName: row.full_name,
      username: row.username,
      role: (Array.isArray(row.roles) ? row.roles[0]?.name : row.roles?.name) ?? null,
      active: row.active,
      authExists: true,
      linkedToThisCustomer: linkedCustomerId === customer.value,
      linkedToAnotherCustomer: false,
      createdAt: row.created_at,
      evidence,
      emailConfirmedAt: authUser.email_confirmed_at ?? null,
    }];
  });

  return {
    ok: true,
    message: candidates.length === 1 ? "Se encontró 1 cuenta web elegible." : `Se encontraron ${candidates.length} cuentas web elegibles.`,
    candidates,
  };
}

export async function searchCustomersForPortalLinkAction(
  query: string,
): Promise<{ ok: boolean; message: string; customers: PortalLinkCustomerCandidate[] }> {
  const profile = await requireSession();
  if (
    !portalLinkRoles.includes(profile.role) ||
    !hasEffectivePermission(profile.role, profile.permissions, "customers:link_portal_account", profile.email)
  ) {
    return { ok: false, message: "No tienes permiso para vincular cuentas del portal.", customers: [] };
  }

  const search = safePortalSearchValue(query);
  if (search.length < 2) {
    return { ok: false, message: "Escribe al menos 2 caracteres para buscar un cliente.", customers: [] };
  }

  const admin = getSupabaseAdminClient();
  const pattern = `%${search}%`;
  const columns = "id, business_name, company_name, contact_name, email, phone, tax_id, city, active, status, user_id, commercial_version";
  const [byName, byBusiness, byEmail, byPhone] = await Promise.all([
    admin.from("customers").select(columns).ilike("contact_name", pattern).limit(10),
    admin.from("customers").select(columns).ilike("business_name", pattern).limit(10),
    admin.from("customers").select(columns).ilike("email", pattern).limit(10),
    admin.from("customers").select(columns).ilike("phone", pattern).limit(10),
  ]);
  const firstError = byName.error ?? byBusiness.error ?? byEmail.error ?? byPhone.error;
  if (firstError) return { ok: false, message: "No fue posible buscar clientes operativos.", customers: [] };

  type LinkCustomerRow = {
    id: string;
    business_name: string | null;
    company_name: string | null;
    contact_name: string;
    email: string | null;
    phone: string | null;
    tax_id: string | null;
    city: string | null;
    active: boolean;
    status: string;
    user_id: string | null;
    commercial_version: number;
  };

  const customersById = new Map<string, LinkCustomerRow>();
  for (const row of [
    ...(byName.data ?? []),
    ...(byBusiness.data ?? []),
    ...(byEmail.data ?? []),
    ...(byPhone.data ?? []),
  ] as LinkCustomerRow[]) customersById.set(row.id, row);

  const rows = [...customersById.values()].slice(0, 10);
  if (rows.length === 0) return { ok: true, message: "No se encontraron clientes operativos.", customers: [] };

  const customerIds = rows.map((row) => row.id);
  const linkedUserIds = rows.flatMap((row) => (row.user_id ? [row.user_id] : []));
  const [orders, invoices, receivables, creditAccounts, linkedUsers] = await Promise.all([
    admin.from("orders").select("customer_id").in("customer_id", customerIds),
    admin.from("invoices").select("customer_id").in("customer_id", customerIds),
    admin.from("accounts_receivable").select("customer_id").in("customer_id", customerIds),
    admin.from("customer_credit_accounts").select("customer_id").in("customer_id", customerIds),
    linkedUserIds.length
      ? admin.from("users").select("id, email").in("id", linkedUserIds)
      : Promise.resolve({ data: [] as Array<{ id: string; email: string | null }>, error: null }),
  ]);
  const aggregateError = orders.error ?? invoices.error ?? receivables.error ?? creditAccounts.error ?? linkedUsers.error;
  if (aggregateError) return { ok: false, message: "No fue posible validar el resumen operativo.", customers: [] };

  const countByCustomer = (values: Array<{ customer_id: string | null }>) =>
    values.reduce((counts, value) => {
      if (value.customer_id) counts.set(value.customer_id, (counts.get(value.customer_id) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
  const orderCounts = countByCustomer((orders.data ?? []) as Array<{ customer_id: string | null }>);
  const invoiceCounts = countByCustomer((invoices.data ?? []) as Array<{ customer_id: string | null }>);
  const receivableCounts = countByCustomer((receivables.data ?? []) as Array<{ customer_id: string | null }>);
  const creditCustomerIds = new Set((creditAccounts.data ?? []).map((row) => row.customer_id));
  const linkedEmails = new Map((linkedUsers.data ?? []).map((row) => [row.id, row.email]));

  return {
    ok: true,
    message: rows.length === 1 ? "Se encontró 1 cliente operativo." : "Se encontraron clientes operativos.",
    customers: rows.map((row) => ({
      id: row.id,
      displayName: row.business_name || row.company_name || row.contact_name,
      contactName: row.contact_name,
      email: row.email,
      phone: row.phone,
      taxId: row.tax_id,
      city: row.city,
      active: row.active,
      status: row.status,
      linked: Boolean(row.user_id),
      linkedAccountEmail: row.user_id ? linkedEmails.get(row.user_id) ?? null : null,
      orderCount: orderCounts.get(row.id) ?? 0,
      invoiceCount: invoiceCounts.get(row.id) ?? 0,
      receivableCount: receivableCounts.get(row.id) ?? 0,
      hasCreditAccount: creditCustomerIds.has(row.id),
      commercialVersion: row.commercial_version,
    })),
  };
}

export async function linkCustomerPortalAccountAction(input: {
  customerId: string;
  userId: string;
  requestKey: string;
  expectedCommercialVersion: number;
  evidenceSource: PortalLinkEvidence["source"];
  evidenceReference: string;
  reason: string;
  confirmed: boolean;
}): Promise<CrmMutationResult & { status?: string }> {
  const profile = await requireSession();
  if (
    !portalLinkRoles.includes(profile.role) ||
    !hasEffectivePermission(profile.role, profile.permissions, "customers:link_portal_account", profile.email)
  ) return { ok: false, message: "No tienes permiso para vincular cuentas del portal." };

  const customer = uuidLike(input.customerId, "Cliente");
  const user = uuidLike(input.userId, "Cuenta web");
  const requestKey = uuidLike(input.requestKey, "Solicitud");
  const reason = input.reason.trim();
  if (!customer.ok) return { ok: false, message: customer.message };
  if (!user.ok) return { ok: false, message: user.message };
  if (!requestKey.ok) return { ok: false, message: requestKey.message };
  if (!Number.isInteger(input.expectedCommercialVersion) || input.expectedCommercialVersion < 0) {
    return { ok: false, code: "PORTAL_LINK_VERSION_INVALID", message: "La versión comercial no es válida." };
  }
  if (!input.confirmed) return { ok: false, message: "Confirma explícitamente la vinculación." };
  const minimumReasonLength = input.evidenceSource === "manual_verified_identity" ? 20 : 10;
  if (reason.length < minimumReasonLength || reason.length > 500) {
    return { ok: false, message: `El motivo debe tener entre ${minimumReasonLength} y 500 caracteres.` };
  }
  if (
    !["authenticated_wholesale_request", "authenticated_portal_registration", "manual_verified_identity"].includes(input.evidenceSource) ||
    !/^[A-Za-z0-9:#._/-]{6,180}$/.test(input.evidenceReference)
  ) {
    return { ok: false, code: "PORTAL_LINK_EVIDENCE_INVALID", message: "Selecciona evidencia válida para la vinculación." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("link_customer_portal_account_v2", {
    p_request_key: requestKey.value,
    p_customer_id: customer.value,
    p_portal_user_id: user.value,
    p_expected_commercial_version: input.expectedCommercialVersion,
    p_evidence_source: input.evidenceSource,
    p_evidence_reference: input.evidenceReference,
    p_reason: reason,
  });
  if (error) {
    await writeErrorLog({
      route: "/admin/vincular-cuenta-cliente",
      action: "customer_portal_link.rpc_failed",
      errorMessage: error.message,
      metadata: { code: error.code ?? null },
    });
    const code = [
      "PORTAL_LINK_FORBIDDEN",
      "PORTAL_LINK_EVIDENCE_INVALID",
      "PORTAL_LINK_CUSTOMER_NOT_FOUND",
      "PORTAL_LINK_CUSTOMER_INACTIVE",
      "PORTAL_LINK_CUSTOMER_CONFLICT",
      "PORTAL_LINK_VERSION_CONFLICT",
      "PORTAL_LINK_ACCOUNT_INACTIVE",
      "PORTAL_LINK_ROLE_INVALID",
      "PORTAL_LINK_ACCOUNT_CONFLICT",
      "PORTAL_LINK_IDEMPOTENCY_CONFLICT",
    ].find((candidate) => error.message.includes(candidate)) ?? "PORTAL_LINK_FAILED";
    const currentVersion = code === "PORTAL_LINK_VERSION_CONFLICT"
      ? Number(error.message.split(":").at(-1))
      : undefined;
    const messages: Record<string, string> = {
      PORTAL_LINK_FORBIDDEN: "No tienes permiso para vincular cuentas del portal.",
      PORTAL_LINK_EVIDENCE_INVALID: "La evidencia ya no es válida. Actualiza la búsqueda y verifica nuevamente.",
      PORTAL_LINK_CUSTOMER_NOT_FOUND: "El cliente ya no existe.",
      PORTAL_LINK_CUSTOMER_INACTIVE: "El cliente no está activo.",
      PORTAL_LINK_CUSTOMER_CONFLICT: "El cliente ya está vinculado a otra cuenta.",
      PORTAL_LINK_VERSION_CONFLICT: "El cliente cambió desde que lo revisaste. Actualiza antes de vincular.",
      PORTAL_LINK_ACCOUNT_INACTIVE: "La cuenta del portal no está activa.",
      PORTAL_LINK_ROLE_INVALID: "La cuenta seleccionada no tiene rol Cliente.",
      PORTAL_LINK_ACCOUNT_CONFLICT: "La cuenta ya está vinculada a otro cliente.",
      PORTAL_LINK_IDEMPOTENCY_CONFLICT: "La solicitud ya fue usada con datos diferentes.",
    };
    return { ok: false, code, currentVersion: Number.isFinite(currentVersion) ? currentVersion : undefined, message: messages[code] ?? "No fue posible vincular la cuenta. Revisa el estado e intenta nuevamente." };
  }

  const result = data as { ok?: boolean; code?: string; commercialVersion?: number } | null;
  if (!result) return { ok: false, message: "La vinculación no devolvió un resultado válido." };
  if (result.ok) {
    revalidatePath("/admin/crm");
    revalidatePath("/admin/clientes");
    revalidatePath("/admin/vincular-cuenta-cliente");
    revalidatePath("/cuenta");
    revalidatePath("/catalogo");
    revalidatePath("/producto/[slug]", "page");
    revalidatePath("/carrito");
    revalidatePath("/checkout");
  }
  const message = result.code === "PORTAL_LINK_ALREADY_EXISTS"
    ? "La cuenta ya estaba vinculada de forma segura."
    : "Cuenta del portal vinculada correctamente.";
  return { ok: Boolean(result.ok), code: result.code, commercialVersion: result.commercialVersion, message };
}

export async function updateCustomerIdentityAction(
  input: CrmCustomerIdentityInput,
): Promise<CustomerIdentityMutationResult> {
  const profile = await requireSession();
  if (
    !customerIdentityRoles.includes(profile.role) ||
    !hasEffectivePermission(profile.role, profile.permissions, "customers:update_identity", profile.email)
  ) return { ok: false, status: "permission_denied", message: "No tienes permiso para editar la identidad comercial." };

  const customer = uuidLike(input.customer_id, "Cliente");
  if (!customer.ok) return { ok: false, message: customer.message, fieldErrors: { customer_id: customer.message } };

  const contactName = requireText(input.contact_name, "Nombre de contacto", 180);
  const businessName = optionalText(input.business_name);
  const email = optionalText(input.email)?.toLowerCase() ?? null;
  const rawPhone = optionalText(input.phone);
  const phone = rawPhone ? validateHondurasPhone(rawPhone) : { ok: true as const, value: null };
  const taxId = optionalText(input.tax_id);
  const city = optionalText(input.city);
  const expected = optionalDateTime(input.expected_updated_at);
  const fieldErrors: CustomerIdentityMutationResult["fieldErrors"] = {};

  if (!contactName.ok) fieldErrors.contact_name = contactName.message;
  if (businessName && businessName.length > 180) fieldErrors.business_name = "Nombre comercial no puede superar 180 caracteres.";
  if (email && (email.length > 320 || !validateEmail(email))) fieldErrors.email = "Ingresa un correo electrónico válido.";
  if (!phone.ok) fieldErrors.phone = phone.message;
  if (taxId && taxId.length > 80) fieldErrors.tax_id = "RTN no puede superar 80 caracteres.";
  if (city && city.length > 180) fieldErrors.city = "Ciudad no puede superar 180 caracteres.";
  if (!expected.ok) fieldErrors.expected_updated_at = expected.message;
  if (Object.keys(fieldErrors).length > 0 || !contactName.ok || !phone.ok || !expected.ok) {
    return { ok: false, status: "invalid_input", message: "Revisa los campos indicados.", fieldErrors };
  }

  const requestHeaders = await headers();
  const actorIp = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || requestHeaders.get("x-real-ip") || null;
  const userAgent = requestHeaders.get("user-agent") || null;
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_customer_identity_manual", {
    p_customer_id: customer.value,
    p_business_name: businessName,
    p_contact_name: contactName.value,
    p_email: email,
    p_phone: phone.value,
    p_tax_id: taxId,
    p_city: city,
    p_expected_updated_at: expected.value,
    p_actor_ip: actorIp,
    p_actor_user_agent: userAgent,
  });
  if (error) {
    await writeErrorLog({
      route: "/admin/clientes",
      action: "customer_identity.update_rpc_failed",
      errorMessage: error.message,
      metadata: { code: error.code ?? null, customerId: customer.value },
    });
    return { ok: false, message: "No fue posible guardar la información del cliente." };
  }

  const result = (data as Array<{
    ok: boolean;
    status: string;
    message: string;
    field_name: string | null;
    customer_id: string;
    updated_at: string;
  }> | null)?.[0];
  if (!result) return { ok: false, message: "La actualización no devolvió un resultado válido." };
  if (!result.ok) {
    const rpcFieldErrors = result.field_name
      ? { [result.field_name]: result.message } as CustomerIdentityMutationResult["fieldErrors"]
      : undefined;
    return { ok: false, status: result.status, message: result.message, fieldErrors: rpcFieldErrors };
  }

  revalidatePath("/admin/clientes");
  revalidatePath("/admin/crm");
  return {
    ok: true,
    status: result.status,
    message: result.message,
    profile: await getAdminCustomerProfile(customer.value),
  };
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
  if (!input.id) {
    const { data: matchData, error: matchError } = await supabase.rpc("find_customer_match_candidates_v1", {
      p_email: optionalText(input.email),
      p_phone: normalizedPhone,
      p_tax_id: optionalText(input.tax_id),
      p_business_name: optionalText(input.business_name),
      p_contact_name: contactName.value,
      p_excluded_customer_id: null,
      p_limit: 10,
    });
    if (matchError) {
      return { ok: false, code: "CUSTOMER_MATCH_FAILED", message: "No se pudo verificar si el cliente ya existe." };
    }
    const candidates = ((matchData as { candidates?: Array<{ id: string; displayName: string; score: number }> } | null)?.candidates ?? []);
    const reviewCandidate = candidates.find((candidate) => Number(candidate.score) >= 30);
    if (reviewCandidate) {
      return {
        ok: false,
        code: "CUSTOMER_MATCH_REVIEW_REQUIRED",
        message: "Posible cliente existente: " + reviewCandidate.displayName + ". Revisa su perfil antes de crear otro registro.",
      };
    }
  }

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

const wholesaleGrantActionSchema = z.object({
  requestKey: z.string().uuid(),
  customerId: z.string().uuid(),
  wholesaleCustomerType: z.enum(["new", "existing"]),
  expectedCommercialVersion: z.number().int().nonnegative(),
  expectedWholesaleStatus: z.enum(["none", "pending", "rejected"]),
  expectedRequestedAt: z.string().datetime({ offset: true }).nullable(),
  reason: z.string().trim().min(5).max(500).optional(),
});

const wholesaleTransitionActionSchema = z.object({
  requestKey: z.string().uuid(),
  customerId: z.string().uuid(),
  operation: z.enum(["change_type", "reject", "suspend", "reactivate"]),
  expectedCommercialVersion: z.number().int().nonnegative(),
  expectedWholesaleStatus: z.enum(["none", "pending", "approved", "rejected", "suspended"]),
  wholesaleCustomerType: z.enum(["new", "existing"]).nullable().optional(),
  reason: z.string().trim().max(500).optional(),
});

export type WholesaleGrantActionInput = z.input<typeof wholesaleGrantActionSchema>;
export type WholesaleTransitionActionInput = z.input<typeof wholesaleTransitionActionSchema>;

type WholesaleRpcResult = {
  ok: boolean;
  code: string;
  commercialVersion: number;
  wholesaleCustomerType: WholesaleCustomerType;
  wholesaleStatus: string;
  firstPurchaseMinimum?: number;
  idempotentReplay?: boolean;
};

const wholesaleErrorMessages: Record<string, string> = {
  UNAUTHORIZED: "Inicia sesión nuevamente para continuar.",
  FORBIDDEN: wholesaleManagementPermissionMessage,
  CUSTOMER_NOT_FOUND: "No pudimos encontrar el cliente.",
  INVALID_TYPE: "Selecciona un tipo mayorista válido.",
  INVALID_SOURCE: "El origen de la operación no es válido.",
  INVALID_REASON: "Escribe un motivo administrativo de 5 a 500 caracteres.",
  VERSION_CONFLICT: "Las condiciones comerciales cambiaron. Recarga el cliente e intenta nuevamente.",
  STATUS_CONFLICT: "El estado mayorista cambió. Recarga el cliente antes de continuar.",
  REQUEST_CHANGED: "La solicitud mayorista cambió. Recarga el cliente antes de continuar.",
  ALREADY_APPROVED: "El cliente ya tiene ese acceso mayorista.",
  CUSTOMER_SUSPENDED: "El acceso está suspendido. Utiliza la acción separada de reactivación.",
  CUSTOMER_INACTIVE: "No se puede otorgar mayoreo a un cliente inactivo.",
  IDEMPOTENCY_CONFLICT: "La solicitud ya fue utilizada con datos diferentes. Vuelve a intentarlo.",
};

function parseWholesaleRpcError(message: string) {
  const match = message.match(/WHOLESALE_([A-Z_]+)(?::(\d+))?/);
  const code = match?.[1] ?? "INTERNAL_ERROR";
  const currentVersion = match?.[2] ? Number(match[2]) : undefined;
  return {
    code,
    currentVersion,
    message: wholesaleErrorMessages[code] ?? "No pudimos completar la operación mayorista.",
  };
}

function revalidateWholesaleViews() {
  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");
  revalidatePath("/admin/clientes-mayoristas");
  revalidatePath("/cuenta");
  revalidatePath("/catalogo");
  revalidatePath("/producto/[slug]", "page");
  revalidatePath("/carrito");
  revalidatePath("/checkout");
}

async function runWholesaleGrant(
  rawInput: WholesaleGrantActionInput,
  source: "customer_request" | "admin_direct_grant",
): Promise<CrmMutationResult> {
  const profile = await requireSession();
  if (!canManageWholesale(profile)) {
    await auditDeniedWholesaleMutation(profile, String(rawInput.customerId ?? ""), source);
    return { ok: false, code: "FORBIDDEN", message: wholesaleManagementPermissionMessage };
  }

  const parsed = wholesaleGrantActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    const reasonIssue = parsed.error.issues.some((issue) => issue.path[0] === "reason");
    return {
      ok: false,
      code: reasonIssue ? "INVALID_REASON" : "INVALID_INPUT",
      message: reasonIssue
        ? wholesaleErrorMessages.INVALID_REASON
        : "Revisa los datos de la operación mayorista.",
    };
  }
  if (source === "admin_direct_grant" && !parsed.data.reason) {
    return { ok: false, code: "INVALID_REASON", message: wholesaleErrorMessages.INVALID_REASON };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("grant_customer_wholesale_access_v1", {
    p_request_key: parsed.data.requestKey,
    p_customer_id: parsed.data.customerId,
    p_wholesale_customer_type: parsed.data.wholesaleCustomerType,
    p_source: source,
    p_expected_commercial_version: parsed.data.expectedCommercialVersion,
    p_expected_wholesale_status: parsed.data.expectedWholesaleStatus,
    p_expected_requested_at: parsed.data.expectedRequestedAt,
    p_reason: parsed.data.reason ?? null,
  });

  if (error) {
    const mapped = parseWholesaleRpcError(error.message);
    await writeErrorLog({
      route: "/admin/clientes",
      action: `wholesale.${source}.failed`,
      errorMessage: mapped.code,
      metadata: {
        customer_id_suffix: parsed.data.customerId.slice(-8),
        source,
        wholesale_customer_type: parsed.data.wholesaleCustomerType,
        current_version: mapped.currentVersion ?? null,
      },
    });
    return { ok: false, ...mapped };
  }

  const result = data as unknown as WholesaleRpcResult;
  const typeLabel = result.wholesaleCustomerType === "existing" ? "mayorista existente" : "mayorista nuevo";
  const detail = result.wholesaleCustomerType === "existing"
    ? "El cliente fue aprobado sin requisito de primera compra mínima."
    : `El cliente deberá completar la primera compra mayorista mínima de L ${Number(result.firstPurchaseMinimum ?? 0).toLocaleString("es-HN", { minimumFractionDigits: 2 })}.`;
  revalidateWholesaleViews();
  return {
    ok: true,
    code: result.code,
    commercialVersion: result.commercialVersion,
    firstPurchaseMinimum: result.firstPurchaseMinimum,
    message: `${source === "customer_request" ? "Solicitud mayorista aprobada correctamente" : "Acceso mayorista otorgado correctamente"} como ${typeLabel}. ${detail}`,
  };
}

export async function approveWholesaleRequestAction(input: WholesaleGrantActionInput): Promise<CrmMutationResult> {
  return runWholesaleGrant(input, "customer_request");
}

export async function grantWholesaleAccessDirectlyAction(input: WholesaleGrantActionInput): Promise<CrmMutationResult> {
  return runWholesaleGrant(input, "admin_direct_grant");
}

async function runWholesaleTransition(rawInput: WholesaleTransitionActionInput): Promise<CrmMutationResult> {
  const profile = await requireSession();
  if (!canManageWholesale(profile)) {
    await auditDeniedWholesaleMutation(profile, String(rawInput.customerId ?? ""), String(rawInput.operation ?? "transition"));
    return { ok: false, code: "FORBIDDEN", message: wholesaleManagementPermissionMessage };
  }

  const parsed = wholesaleTransitionActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_INPUT", message: "Revisa los datos de la operación mayorista." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("transition_customer_wholesale_access_v1", {
    p_request_key: parsed.data.requestKey,
    p_customer_id: parsed.data.customerId,
    p_operation: parsed.data.operation,
    p_expected_commercial_version: parsed.data.expectedCommercialVersion,
    p_expected_wholesale_status: parsed.data.expectedWholesaleStatus,
    p_wholesale_customer_type: parsed.data.wholesaleCustomerType ?? null,
    p_reason: parsed.data.reason ?? null,
  });
  if (error) {
    const mapped = parseWholesaleRpcError(error.message);
    await writeErrorLog({
      route: "/admin/clientes",
      action: `wholesale.${parsed.data.operation}.failed`,
      errorMessage: mapped.code,
      metadata: {
        customer_id_suffix: parsed.data.customerId.slice(-8),
        current_version: mapped.currentVersion ?? null,
      },
    });
    return { ok: false, ...mapped };
  }

  const result = data as unknown as WholesaleRpcResult;
  const messages: Record<typeof parsed.data.operation, string> = {
    change_type: `Tipo actualizado a mayorista ${result.wholesaleCustomerType === "existing" ? "existente" : "nuevo"}.`,
    reject: "Solicitud mayorista rechazada.",
    suspend: "Acceso mayorista suspendido.",
    reactivate: "Acceso mayorista reactivado.",
  };
  revalidateWholesaleViews();
  return {
    ok: true,
    code: result.code,
    commercialVersion: result.commercialVersion,
    message: messages[parsed.data.operation],
  };
}

export async function changeWholesaleCustomerTypeAction(
  input: Omit<WholesaleTransitionActionInput, "operation">,
): Promise<CrmMutationResult> {
  return runWholesaleTransition({ ...input, operation: "change_type" });
}

export async function rejectWholesaleRequestAction(
  input: Omit<WholesaleTransitionActionInput, "operation" | "wholesaleCustomerType">,
): Promise<CrmMutationResult> {
  return runWholesaleTransition({ ...input, operation: "reject", wholesaleCustomerType: null });
}

export async function suspendWholesaleAccessAction(
  input: Omit<WholesaleTransitionActionInput, "operation" | "wholesaleCustomerType">,
): Promise<CrmMutationResult> {
  return runWholesaleTransition({ ...input, operation: "suspend", wholesaleCustomerType: null });
}

export async function reactivateWholesaleAccessAction(
  input: Omit<WholesaleTransitionActionInput, "operation" | "wholesaleCustomerType">,
): Promise<CrmMutationResult> {
  return runWholesaleTransition({ ...input, operation: "reactivate", wholesaleCustomerType: null });
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
  void input;
  return {
    ok: false,
    code: "CUSTOMER_LEGACY_MERGE_DISABLED",
    message: "La unión anterior fue desactivada. Utiliza la vista previa y el wizard de unificación canónica.",
  };
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

