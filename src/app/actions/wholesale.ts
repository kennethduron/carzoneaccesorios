"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { writeErrorLog } from "@/lib/error-logging";
import {
  ensureRegisteredWholesaleFollowup,
  getPublicRequestContext,
  notifyPublicFormSubmission,
  writeRegisteredWholesaleAudit,
} from "@/lib/public-form-support";
import { checkRateLimit, getRateLimitMessage } from "@/lib/rate-limit";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";
import type {
  WholesaleAccessState,
  WholesaleAccount,
  WholesaleAccountStatus,
  WholesaleFirstPurchaseRequirement,
} from "@/types/wholesale";

type CustomerAccessRow = {
  id: string;
  business_name: string | null;
  company_name: string | null;
  contact_name: string;
  email: string | null;
  phone: string | null;
  tax_id: string | null;
  city: string | null;
  notes: string | null;
  is_wholesale: boolean;
  wholesale_status: WholesaleAccountStatus | "none" | null;
  wholesale_requested_at: string | null;
  wholesale_request_source: string | null;
  wholesale_approved_notice_seen: boolean | null;
  status: "active" | "inactive" | "disabled" | "pending_account";
  active: boolean;
};

export type WholesaleRequestActionResult = {
  ok: boolean;
  message: string;
  state?: WholesaleAccessState;
};

type WholesaleOrderHistoryRow = {
  subtotal: unknown;
  total: unknown;
  status: string | null;
};

function isCancelledOrder(status: string | null) {
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized === "cancelado" || normalized === "cancelled";
}

async function getFirstPurchaseRequirement(customerId: string): Promise<WholesaleFirstPurchaseRequirement> {
  const admin = getSupabaseAdminClient();
  const [settings, historyResult, ordersResult] = await Promise.all([
    getPublicCompanySettings(),
    admin.rpc("has_completed_wholesale_order", { target_customer_id: customerId }),
    admin
      .from("orders")
      .select("subtotal, total, status")
      .eq("customer_id", customerId)
      .eq("price_mode", "wholesale")
      .returns<WholesaleOrderHistoryRow[]>(),
  ]);
  const minimum = Math.max(0, Number(settings.first_wholesale_minimum ?? 0));
  const accumulated = (ordersResult.data ?? [])
    .filter((order) => !isCancelledOrder(order.status))
    .reduce((sum, order) => sum + Number(order.total ?? order.subtotal ?? 0), 0);
  const completed = Boolean(historyResult.data);

  return {
    minimum,
    accumulated,
    missing: completed ? 0 : Math.max(0, minimum - accumulated),
    completed,
  };
}

function toAccount(customer: CustomerAccessRow, requirement: WholesaleFirstPurchaseRequirement | null = null): WholesaleAccount {
  const businessName = customer.business_name || customer.company_name || customer.contact_name || "Cuenta mayorista";

  return {
    id: customer.id,
    customerId: customer.id,
    customerName: customer.contact_name,
    businessName,
    status: "approved",
    firstPurchaseRequirement: requirement,
  };
}

function getWholesaleStatus(customer: CustomerAccessRow): WholesaleAccountStatus | "none" {
  if (customer.wholesale_status) {
    return customer.wholesale_status;
  }

  if (customer.is_wholesale && customer.active && customer.status === "active") {
    return "approved";
  }

  if (customer.is_wholesale && (!customer.active || customer.status === "disabled")) {
    return "suspended";
  }

  if (customer.status === "pending_account" || Boolean(customer.notes?.includes("[SOLICITUD_MAYOREO]"))) {
    return "pending";
  }

  if (customer.is_wholesale && customer.status === "inactive") {
    return "rejected";
  }

  return "none";
}

function guestWholesaleState(): WholesaleAccessState {
  return {
    kind: "guest",
    title: "Acceso mayorista",
    message: "Inicia sesión o solicita acceso mayorista para que el equipo apruebe tu cuenta.",
    canEnterCode: false,
    account: null,
    shouldShowApprovedNotice: false,
    firstPurchaseRequirement: null,
  };
}

function regularWholesaleState(): WholesaleAccessState {
  return {
    kind: "regular",
    title: "Solicitar acceso mayorista",
    message: "Usaremos los datos de tu cuenta para revisar tu solicitud.",
    canEnterCode: false,
    account: null,
    shouldShowApprovedNotice: false,
    firstPurchaseRequirement: null,
  };
}

function pendingWholesaleState(): WholesaleAccessState {
  return {
    kind: "pending",
    title: "Tu solicitud mayorista está en revisión.",
    message: "Te notificaremos cuando sea aprobada.",
    canEnterCode: false,
    account: null,
    shouldShowApprovedNotice: false,
    firstPurchaseRequirement: null,
  };
}

function rejectedWholesaleState(): WholesaleAccessState {
  return {
    kind: "rejected",
    title: "Tu solicitud mayorista fue revisada.",
    message: "Puedes contactar al equipo para más información.",
    canEnterCode: false,
    account: null,
    shouldShowApprovedNotice: false,
    firstPurchaseRequirement: null,
  };
}

function suspendedWholesaleState(): WholesaleAccessState {
  return {
    kind: "suspended",
    title: "Tu acceso mayorista está suspendido.",
    message: "Contacta al equipo para más información.",
    canEnterCode: false,
    account: null,
    shouldShowApprovedNotice: false,
    firstPurchaseRequirement: null,
  };
}

export async function getWholesaleAccessStateAction(): Promise<WholesaleAccessState> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return guestWholesaleState();
  }

  const admin = getSupabaseAdminClient();
  const { data: customers, error } = await admin
    .from("customers")
    .select(
      "id, business_name, company_name, contact_name, email, phone, tax_id, city, notes, is_wholesale, wholesale_status, wholesale_requested_at, wholesale_request_source, wholesale_approved_notice_seen, status, active",
    )
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .returns<CustomerAccessRow[]>();

  if (error) {
    await writeErrorLog({
      route: "/",
      action: "wholesale.access_state_failed",
      errorMessage: error.message,
      metadata: { user_id: user.id },
    });
    return {
      kind: "regular",
      title: "Acceso mayorista",
      message: "Tu cuenta aún no tiene acceso mayorista. Puedes solicitarlo para revisión.",
      canEnterCode: false,
      account: null,
      shouldShowApprovedNotice: false,
      firstPurchaseRequirement: null,
    };
  }

  const customerRows = customers ?? [];
  const approvedCustomer = customerRows.find((customer) => getWholesaleStatus(customer) === "approved" && customer.active);

  if (approvedCustomer) {
    const requirement = await getFirstPurchaseRequirement(approvedCustomer.id);
    return {
      kind: "approved",
      title: "Mayorista aprobado",
      message: "Ya tienes acceso mayorista. Los precios mayoristas se aplicarán automáticamente cuando inicies sesión.",
      canEnterCode: false,
      account: toAccount(approvedCustomer, requirement),
      shouldShowApprovedNotice: approvedCustomer.wholesale_approved_notice_seen === false,
      firstPurchaseRequirement: requirement,
    };
  }

  if (customerRows.some((customer) => getWholesaleStatus(customer) === "suspended")) {
    return suspendedWholesaleState();
  }

  if (customerRows.some((customer) => getWholesaleStatus(customer) === "rejected")) {
    return rejectedWholesaleState();
  }

  if (customerRows.some((customer) => getWholesaleStatus(customer) === "pending")) {
    return pendingWholesaleState();
  }

  return regularWholesaleState();
}

export async function submitRegisteredWholesaleRequestAction(): Promise<WholesaleRequestActionResult> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, message: "Inicia sesión para solicitar mayoreo con un solo clic.", state: guestWholesaleState() };
  }

  const requestLimit = await checkRateLimit({
    route: "/contacto/mayoreo/cuenta",
    limit: 4,
    windowSeconds: 15 * 60,
    key: user.id,
  });
  if (!requestLimit.ok) {
    return { ok: false, message: getRateLimitMessage(requestLimit.retryAfter) };
  }

  const requestContext = await getPublicRequestContext();
  const admin = getSupabaseAdminClient();
  const { data: userProfile, error: userProfileError } = await admin
    .from("users")
    .select("id, email, full_name, phone, active, roles(name)")
    .eq("id", user.id)
    .maybeSingle<{
      id: string;
      email: string | null;
      full_name: string | null;
      phone: string | null;
      active: boolean;
      roles: { name: string } | null;
    }>();

  if (userProfileError || !userProfile || userProfile.active === false) {
    return { ok: false, message: "No pudimos validar tu cuenta. Intenta iniciar sesión nuevamente." };
  }

  if (userProfile.roles?.name && userProfile.roles.name !== "cliente") {
    return { ok: false, message: "La solicitud mayorista debe hacerse desde una cuenta cliente." };
  }

  const email = (userProfile.email || user.email || "").trim().toLowerCase();
  const customerFilter = email ? `user_id.eq.${user.id},email.ilike.${email}` : `user_id.eq.${user.id}`;
  const { data: customerRows, error: customerError } = await admin
    .from("customers")
    .select(
      "id, user_id, business_name, company_name, contact_name, email, phone, tax_id, city, notes, is_wholesale, wholesale_status, wholesale_requested_at, wholesale_request_source, wholesale_approved_notice_seen, status, active",
    )
    .or(customerFilter)
    .order("updated_at", { ascending: false })
    .returns<(CustomerAccessRow & { user_id: string | null })[]>();

  if (customerError) {
    return { ok: false, message: "No pudimos revisar tu estado mayorista. Intenta nuevamente." };
  }

  const customers = customerRows ?? [];
  if (customers.some((customer) => getWholesaleStatus(customer) === "approved")) {
    const approvedCustomer = customers.find((customer) => getWholesaleStatus(customer) === "approved")!;
    const requirement = await getFirstPurchaseRequirement(approvedCustomer.id);
    await writeRegisteredWholesaleAudit({
      action: "public_form.wholesale.overwrite_blocked",
      customerId: approvedCustomer.id,
      email,
      phone: approvedCustomer.phone ?? userProfile.phone ?? "00000000",
      outcome: "approved",
      context: requestContext,
    });
    return {
      ok: false,
      message: "Tu cuenta mayorista ya esta aprobada. Inicia sesion para comprar con precio mayorista.",
      state: {
        kind: "approved",
        title: "Ya tienes acceso mayorista.",
        message: "Los precios mayoristas se aplicarán automáticamente cuando inicies sesión.",
        canEnterCode: false,
        account: toAccount(approvedCustomer, requirement),
        shouldShowApprovedNotice: false,
        firstPurchaseRequirement: requirement,
      },
    };
  }

  if (customers.some((customer) => getWholesaleStatus(customer) === "pending")) {
    const pendingCustomer = customers.find((customer) => getWholesaleStatus(customer) === "pending")!;
    await ensureRegisteredWholesaleFollowup({
      customerId: pendingCustomer.id,
      userId: user.id,
      phone: pendingCustomer.phone ?? userProfile.phone ?? "00000000",
      note: "Solicitud mayorista pendiente confirmada desde cuenta registrada.",
    });
    await writeRegisteredWholesaleAudit({
      action: "public_form.wholesale.duplicate_pending",
      customerId: pendingCustomer.id,
      email,
      phone: pendingCustomer.phone ?? userProfile.phone ?? "00000000",
      outcome: "pending",
      context: requestContext,
    });
    return { ok: false, message: "Tu solicitud ya esta pendiente de revision.", state: pendingWholesaleState() };
  }

  if (customers.some((customer) => getWholesaleStatus(customer) === "suspended")) {
    const suspendedCustomer = customers.find((customer) => getWholesaleStatus(customer) === "suspended")!;
    await writeRegisteredWholesaleAudit({
      action: "public_form.wholesale.overwrite_blocked",
      customerId: suspendedCustomer.id,
      email,
      phone: suspendedCustomer.phone ?? userProfile.phone ?? "00000000",
      outcome: "suspended",
      context: requestContext,
    });
    return { ok: false, message: "Tu acceso mayorista esta suspendido. Contacta a servicio al cliente.", state: suspendedWholesaleState() };
  }

  const rejectedCustomer = customers.find((customer) => getWholesaleStatus(customer) === "rejected");
  if (rejectedCustomer) {
    const rejectedName = rejectedCustomer.contact_name || userProfile.full_name || email || "Cliente registrado";
    const rejectedPhone = rejectedCustomer.phone || userProfile.phone || "00000000";
    const rejectedNote = [
      "[SOLICITUD_MAYOREO]",
      "Origen: Cuenta registrada",
      `Fecha: ${requestContext.submittedAt}`,
      "El cliente solicito revision manual despues de un rechazo.",
    ].join("\n");
    const followup = await ensureRegisteredWholesaleFollowup({
      customerId: rejectedCustomer.id,
      userId: user.id,
      phone: rejectedPhone,
      note: rejectedNote,
      rejectedReview: true,
    });

    await writeRegisteredWholesaleAudit({
      action: "public_form.wholesale.overwrite_blocked",
      customerId: rejectedCustomer.id,
      email,
      phone: rejectedPhone,
      outcome: "rejected_review",
      context: requestContext,
    });
    await notifyPublicFormSubmission({
      kind: "wholesale",
      customerId: rejectedCustomer.id,
      followupId: followup.followupId,
      name: rejectedName,
      email,
      phone: rejectedPhone,
      businessName: rejectedCustomer.business_name ?? rejectedCustomer.company_name,
      taxId: rejectedCustomer.tax_id,
      city: rejectedCustomer.city,
      comment: "El cliente solicito revision manual despues de un rechazo.",
      outcome: "rejected_review",
      context: requestContext,
    });

    revalidatePath("/admin");
    revalidatePath("/admin/crm");
    revalidatePath("/admin/clientes");
    revalidatePath("/admin/clientes-mayoristas");
    return { ok: true, message: "Recibimos tu mensaje. Nuestro equipo revisara tu caso.", state: rejectedWholesaleState() };
  }

  const now = requestContext.submittedAt;
  const targetCustomer = customers.find((customer) => customer.user_id === user.id) ?? customers[0] ?? null;
  const contactName = targetCustomer?.contact_name || userProfile.full_name || email || "Cliente registrado";
  const phone = targetCustomer?.phone || userProfile.phone || "00000000";
  const note = [
    "[SOLICITUD_MAYOREO]",
    "Origen: Cuenta registrada",
    `Fecha: ${now}`,
    targetCustomer?.city ? `Ciudad: ${targetCustomer.city}` : null,
    targetCustomer?.tax_id ? `RTN: ${targetCustomer.tax_id}` : null,
    "Solicitud creada con un clic desde la cuenta del cliente.",
  ]
    .filter(Boolean)
    .join("\n");

  const payload = {
    user_id: user.id,
    contact_name: contactName,
    email,
    phone,
    tax_id: targetCustomer?.tax_id ?? null,
    city: targetCustomer?.city ?? null,
    notes: [targetCustomer?.notes, note].filter(Boolean).join("\n"),
    is_wholesale: false,
    wholesale_status: "pending",
    wholesale_requested_at: now,
    wholesale_request_source: "cuenta_registrada",
    wholesale_approved_notice_seen: false,
    status: "active",
    active: true,
    updated_at: now,
  };

  const customerQuery = targetCustomer?.id
    ? admin.from("customers").update(payload).eq("id", targetCustomer.id).select("id").single<{ id: string }>()
    : admin
        .from("customers")
        .insert({
          ...payload,
          lead_status: "prospecto",
          estimated_value: 0,
          monthly_amount: 0,
        })
        .select("id")
        .single<{ id: string }>();

  const { data: customer, error: upsertError } = await customerQuery;

  if (upsertError || !customer) {
    return { ok: false, message: "No pudimos crear tu solicitud mayorista. Intenta nuevamente." };
  }

  const followup = await ensureRegisteredWholesaleFollowup({
    customerId: customer.id,
    userId: user.id,
    phone,
    note,
  });
  const { error: noteError } = await admin.from("crm_notes").insert({
    customer_id: customer.id,
    user_id: user.id,
    note_type: "wholesale_status",
    note: "Solicitud mayorista enviada desde cuenta registrada.",
  });
  if (noteError) {
    await writeErrorLog({
      route: "/contacto",
      action: "public_forms.registered_wholesale_note_failed",
      errorMessage: noteError.message,
      metadata: { customer_id: customer.id },
    });
  }

  await writeAuditLog({
    tableName: "customers",
    recordId: customer.id,
    action: "wholesale_request.created_from_account",
    newData: {
      user_id: user.id,
      email,
      wholesale_status: "pending",
      wholesale_request_source: "cuenta_registrada",
      wholesale_requested_at: now,
    },
  });
  await writeRegisteredWholesaleAudit({
    action: "public_form.wholesale.submitted",
    customerId: customer.id,
    email,
    phone,
    outcome: "created",
    context: requestContext,
  });
  await notifyPublicFormSubmission({
    kind: "wholesale",
    customerId: customer.id,
    followupId: followup.followupId,
    name: contactName,
    email,
    phone,
    businessName: targetCustomer?.business_name ?? targetCustomer?.company_name,
    taxId: targetCustomer?.tax_id,
    city: targetCustomer?.city,
    outcome: "created",
    context: requestContext,
  });

  revalidatePath("/admin");
  revalidatePath("/contacto");
  revalidatePath("/cuenta");
  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");
  revalidatePath("/admin/clientes-mayoristas");

  return {
    ok: true,
    message:
      "Recibimos tu solicitud. Nuestro equipo revisará tu cuenta y te notificaremos cuando tengas acceso a precios mayoristas.",
    state: pendingWholesaleState(),
  };
}

export async function markWholesaleApprovedNoticeSeenAction(): Promise<{ ok: boolean; message: string }> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, message: "Sesión no válida." };
  }

  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("customers")
    .update({ wholesale_approved_notice_seen: true, updated_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("wholesale_status", "approved")
    .eq("wholesale_approved_notice_seen", false);

  if (error) {
    return { ok: false, message: "No pudimos guardar el aviso como visto." };
  }

  revalidatePath("/cuenta");
  revalidatePath("/catalogo");

  return { ok: true, message: "Aviso confirmado." };
}
