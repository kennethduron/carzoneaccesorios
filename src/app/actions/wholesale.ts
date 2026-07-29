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
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";
import type {
  WholesaleAccessState,
  WholesaleAccount,
  WholesaleAccountStatus,
  WholesaleCustomerType,
  WholesaleFirstPurchaseRequirement,
} from "@/types/wholesale";

type CustomerAccessRow = {
  id: string;
  user_id: string | null;
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
  wholesale_customer_type: WholesaleCustomerType;
  wholesale_first_purchase_completed: boolean;
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

async function getFirstPurchaseRequirement(customer: CustomerAccessRow): Promise<WholesaleFirstPurchaseRequirement | null> {
  if (customer.wholesale_customer_type === "existing") {
    return null;
  }

  const admin = getSupabaseAdminClient();
  const [settings, historyResult, ordersResult] = await Promise.all([
    getPublicCompanySettings(),
    admin.rpc("has_completed_wholesale_order", { target_customer_id: customer.id }),
    admin
      .from("orders")
      .select("subtotal, total, status")
      .eq("customer_id", customer.id)
      .eq("price_mode", "wholesale")
      .returns<WholesaleOrderHistoryRow[]>(),
  ]);
  const minimum = Math.max(0, Number(settings.first_wholesale_minimum ?? 0));
  const accumulated = (ordersResult.data ?? [])
    .filter((order) => !isCancelledOrder(order.status))
    .reduce((sum, order) => sum + Number(order.total ?? order.subtotal ?? 0), 0);
  const completed = customer.wholesale_first_purchase_completed || Boolean(historyResult.data);

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
    customerType: customer.wholesale_customer_type,
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
    customerType: null,
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
    customerType: null,
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
    customerType: null,
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
    customerType: null,
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
    customerType: null,
    firstPurchaseRequirement: null,
  };
}

const customerAccessColumns =
  "id, user_id, business_name, company_name, contact_name, email, phone, tax_id, city, notes, is_wholesale, wholesale_status, wholesale_requested_at, wholesale_request_source, wholesale_approved_notice_seen, wholesale_customer_type, wholesale_first_purchase_completed, status, active";

async function getWholesaleCustomersForPortalUser(userId: string) {
  const admin = getSupabaseAdminClient();
  const [linkedResult, requestNotesResult] = await Promise.all([
    admin
      .from("customers")
      .select(customerAccessColumns)
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .returns<CustomerAccessRow[]>(),
    admin
      .from("crm_notes")
      .select("customer_id")
      .eq("user_id", userId)
      .eq("note_type", "wholesale_status")
      .eq("note", "Solicitud mayorista enviada desde cuenta registrada.")
      .order("created_at", { ascending: false })
      .limit(20)
      .returns<Array<{ customer_id: string }>>(),
  ]);

  if (linkedResult.error || requestNotesResult.error) {
    return {
      customers: [] as CustomerAccessRow[],
      error: linkedResult.error ?? requestNotesResult.error,
    };
  }

  const linkedCustomers = linkedResult.data ?? [];
  const linkedIds = new Set(linkedCustomers.map((customer) => customer.id));
  const requestCustomerIds = Array.from(
    new Set((requestNotesResult.data ?? []).map((note) => note.customer_id).filter((id) => !linkedIds.has(id))),
  );

  if (requestCustomerIds.length === 0) {
    return { customers: linkedCustomers, error: null };
  }

  const requestCustomersResult = await admin
    .from("customers")
    .select(customerAccessColumns)
    .in("id", requestCustomerIds)
    .order("updated_at", { ascending: false })
    .returns<CustomerAccessRow[]>();

  if (requestCustomersResult.error) {
    return { customers: [] as CustomerAccessRow[], error: requestCustomersResult.error };
  }

  const requestCustomers = (requestCustomersResult.data ?? []).filter(
    (customer) => customer.user_id === null || customer.user_id === userId,
  );
  return { customers: [...linkedCustomers, ...requestCustomers], error: null };
}

export async function getWholesaleAccessStateAction(): Promise<WholesaleAccessState> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return guestWholesaleState();
  }

  const { customers, error } = await getWholesaleCustomersForPortalUser(user.id);

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
      customerType: null,
      firstPurchaseRequirement: null,
    };
  }

  const customerRows = customers;
  const approvedCustomer = customerRows.find((customer) => getWholesaleStatus(customer) === "approved" && customer.active);

  if (approvedCustomer) {
    if (approvedCustomer.user_id !== user.id) {
      return {
        kind: "approved",
        title: "Solicitud comercial aprobada",
        message:
          "La aprobación mayorista está lista, pero tu cuenta web aún no está vinculada al cliente operativo. Un usuario autorizado debe confirmar la vinculación manual antes de habilitar precios privados.",
        canEnterCode: false,
        account: null,
        shouldShowApprovedNotice: false,
        customerType: approvedCustomer.wholesale_customer_type,
        firstPurchaseRequirement: null,
      };
    }
    const requirement = await getFirstPurchaseRequirement(approvedCustomer);
    const isExisting = approvedCustomer.wholesale_customer_type === "existing";
    return {
      kind: "approved",
      title: "Mayorista aprobado",
      message: isExisting
        ? "Cuenta mayorista aprobada. Puedes acceder a precios mayoristas sin requisito de primera compra mínima."
        : "Cuenta mayorista aprobada. Para tu primera compra mayorista, el monto mínimo requerido es de L 10,000. Después de esa primera compra, podrás comprar cualquier monto.",
      canEnterCode: false,
      account: toAccount(approvedCustomer, requirement),
      // Approval notices are now delivered by the private, server-backed
      // customer_portal_notifications contract on /cuenta.
      shouldShowApprovedNotice: false,
      customerType: approvedCustomer.wholesale_customer_type,
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
  const { customers, error: customerError } = await getWholesaleCustomersForPortalUser(user.id);

  if (customerError) {
    return { ok: false, message: "No pudimos revisar tu estado mayorista. Intenta nuevamente." };
  }

  if (customers.some((customer) => getWholesaleStatus(customer) === "approved")) {
    const approvedCustomer = customers.find((customer) => getWholesaleStatus(customer) === "approved")!;
    if (approvedCustomer.user_id !== user.id) {
      return {
        ok: false,
        message:
          "La solicitud comercial ya fue aprobada. Falta que un usuario autorizado vincule manualmente tu cuenta web con el cliente operativo.",
        state: {
          kind: "approved",
          title: "Solicitud comercial aprobada",
          message:
            "La cuenta web sigue sin cliente vinculado y todavía no puede acceder a precios ni datos privados del customer.",
          canEnterCode: false,
          account: null,
          shouldShowApprovedNotice: false,
          customerType: approvedCustomer.wholesale_customer_type,
          firstPurchaseRequirement: null,
        },
      };
    }
    const requirement = await getFirstPurchaseRequirement(approvedCustomer);
    await writeRegisteredWholesaleAudit({
      action: "public_form.wholesale.overwrite_blocked",
      customerId: approvedCustomer.id,
      email,
      phone: approvedCustomer.phone ?? userProfile.phone ?? "",
      outcome: "approved",
      context: requestContext,
    });
    return {
      ok: false,
      message: "Tu cuenta mayorista ya está aprobada. Inicia sesión para comprar con precio mayorista.",
      state: {
        kind: "approved",
        title: "Ya tienes acceso mayorista.",
        message: "Los precios mayoristas se aplicarán automáticamente cuando inicies sesión.",
        canEnterCode: false,
        account: toAccount(approvedCustomer, requirement),
        shouldShowApprovedNotice: false,
        customerType: approvedCustomer.wholesale_customer_type,
        firstPurchaseRequirement: requirement,
      },
    };
  }

  if (customers.some((customer) => getWholesaleStatus(customer) === "pending")) {
    const pendingCustomer = customers.find((customer) => getWholesaleStatus(customer) === "pending")!;
    await ensureRegisteredWholesaleFollowup({
      customerId: pendingCustomer.id,
      userId: user.id,
      phone: pendingCustomer.phone ?? userProfile.phone ?? "",
      note: "Solicitud mayorista pendiente confirmada desde cuenta registrada.",
    });
    await writeRegisteredWholesaleAudit({
      action: "public_form.wholesale.duplicate_pending",
      customerId: pendingCustomer.id,
      email,
      phone: pendingCustomer.phone ?? userProfile.phone ?? "",
      outcome: "pending",
      context: requestContext,
    });
    return { ok: false, message: "Tu solicitud ya está pendiente de revisión.", state: pendingWholesaleState() };
  }

  if (customers.some((customer) => getWholesaleStatus(customer) === "suspended")) {
    const suspendedCustomer = customers.find((customer) => getWholesaleStatus(customer) === "suspended")!;
    await writeRegisteredWholesaleAudit({
      action: "public_form.wholesale.overwrite_blocked",
      customerId: suspendedCustomer.id,
      email,
      phone: suspendedCustomer.phone ?? userProfile.phone ?? "",
      outcome: "suspended",
      context: requestContext,
    });
    return { ok: false, message: "Tu acceso mayorista está suspendido. Contacta al servicio al cliente.", state: suspendedWholesaleState() };
  }

  const rejectedCustomer = customers.find((customer) => getWholesaleStatus(customer) === "rejected");
  if (rejectedCustomer) {
    const rejectedName = rejectedCustomer.contact_name || userProfile.full_name || email || "Cliente registrado";
    const rejectedPhone = rejectedCustomer.phone || userProfile.phone || "";
    const rejectedNote = [
      "[SOLICITUD_MAYOREO]",
      "Origen: Cuenta registrada",
      `Fecha: ${requestContext.submittedAt}`,
      "El cliente solicitó revisión manual después de un rechazo.",
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
      comment: "El cliente solicitó revisión manual después de un rechazo.",
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
  const targetCustomer = customers[0] ?? null;
  const contactName = targetCustomer?.contact_name || userProfile.full_name || email || "Cliente registrado";
  const phone = targetCustomer?.phone || userProfile.phone || "";
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

  const customerQuery = targetCustomer
    ? admin
        .from("customers")
        .update(payload)
        .eq("id", targetCustomer.id)
        .or(`user_id.is.null,user_id.eq.${user.id}`)
        .select("id")
        .single<{ id: string }>()
    : admin
        .from("customers")
        .insert({
          ...payload,
          user_id: null,
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
      portal_account_linked: Boolean(targetCustomer?.user_id === user.id),
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
