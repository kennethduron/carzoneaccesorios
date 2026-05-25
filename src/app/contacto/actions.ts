"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkRateLimit, getRateLimitMessage } from "@/lib/rate-limit";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { optionalText, requireText, validateHondurasPhone } from "@/utils/validation";

type WholesaleRequestInput = {
  businessName: string;
  contactName: string;
  phone: string;
  email: string;
  city: string;
  taxId: string;
  comment: string;
};

type GeneralContactInput = {
  name: string;
  email: string;
  phone: string;
  message: string;
};

type ContactActionResult = {
  ok: boolean;
  message: string;
  status?: "pending" | "approved" | "rejected" | "suspended";
};

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function findExistingCustomerId(supabase: SupabaseClient, email: string, normalizedPhone: string) {
  const localPhone = normalizedPhone.startsWith("+504") ? normalizedPhone.slice(4) : normalizedPhone;
  const phoneCandidates = Array.from(new Set([normalizedPhone, localPhone, `504${localPhone}`].filter(Boolean)));

  const { data: emailMatch } = await supabase
    .from("customers")
    .select("id")
    .ilike("email", email)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (emailMatch?.id) {
    return emailMatch.id;
  }

  const { data: phoneMatch } = await supabase
    .from("customers")
    .select("id")
    .in("phone", phoneCandidates)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>();

  return phoneMatch?.id ?? null;
}

export async function submitGeneralContactAction(input: GeneralContactInput): Promise<ContactActionResult> {
  const contactLimit = await checkRateLimit({
    route: "/contacto",
    limit: 5,
    windowSeconds: 10 * 60,
    key: input.email.trim().toLowerCase() || input.phone.trim(),
  });

  if (!contactLimit.ok) {
    return { ok: false, message: getRateLimitMessage(contactLimit.retryAfter) };
  }

  const name = requireText(input.name, "Nombre");
  const phone = validateHondurasPhone(input.phone);
  const message = requireText(input.message, "Mensaje", 1200);
  const email = normalizeEmail(input.email);

  for (const result of [name, phone, message]) {
    if (!result.ok) {
      return { ok: false, message: "Completa los campos requeridos." };
    }
  }

  const normalizedPhone = phone.ok ? phone.value : "";
  if (!isValidEmail(email)) {
    return { ok: false, message: "Completa los campos requeridos." };
  }

  const supabase = getSupabaseAdminClient();
  const note = ["[CONTACTO_GENERAL]", `Correo: ${email}`, `Mensaje: ${message.value}`].join("\n");
  const existingCustomerId = await findExistingCustomerId(supabase, email, normalizedPhone);

  if (existingCustomerId) {
    const { data: existingCustomer } = await supabase
      .from("customers")
      .select("id, wholesale_status, is_wholesale, active, status")
      .eq("id", existingCustomerId)
      .maybeSingle<{
        id: string;
        wholesale_status: "none" | "pending" | "approved" | "rejected" | "suspended" | null;
        is_wholesale: boolean;
        active: boolean;
        status: string;
      }>();

    const currentStatus =
      existingCustomer?.wholesale_status ??
      (existingCustomer?.is_wholesale && existingCustomer.active && existingCustomer.status === "active" ? "approved" : "none");

    if (currentStatus === "pending") {
      return { ok: false, message: "Tu solicitud mayorista está en revisión.", status: "pending" };
    }

    if (currentStatus === "approved") {
      return { ok: false, message: "Ya tienes acceso mayorista.", status: "approved" };
    }

    if (currentStatus === "suspended") {
      return { ok: false, message: "Tu acceso mayorista está suspendido. Contacta al equipo para más información.", status: "suspended" };
    }

    if (currentStatus === "rejected") {
      return { ok: false, message: "Tu solicitud mayorista fue revisada. Puedes contactar al equipo para más información.", status: "rejected" };
    }
  }

  const customerPayload = {
    contact_name: name.value,
    email,
    phone: normalizedPhone,
    notes: note,
    lead_status: "prospecto",
    estimated_value: 0,
    monthly_amount: 0,
    is_wholesale: false,
    status: "active",
    active: true,
  };

  const customerQuery = existingCustomerId
    ? supabase
        .from("customers")
        .update({
          contact_name: name.value,
          email,
          phone: normalizedPhone,
          notes: note,
          lead_status: "prospecto",
          active: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingCustomerId)
        .select("id")
        .single<{ id: string }>()
    : supabase.from("customers").insert(customerPayload).select("id").single<{ id: string }>();

  const { data: customer, error: customerError } = await customerQuery;

  if (customerError) {
    return { ok: false, message: "No pudimos guardar tu mensaje. Intenta nuevamente." };
  }

  const { error: followupError } = await supabase.from("crm_followups").insert({
    customer_id: customer.id,
    title: "Contacto general desde la web",
    interaction_type: "contacto_general",
    next_action: "Responder consulta del cliente.",
    priority: "media",
    phone: normalizedPhone,
    notes: note,
    estimated_value: 0,
    monthly_amount: 0,
    status: "pending",
  });

  if (followupError) {
    return { ok: false, message: "El mensaje se recibio, pero no pudimos crear el seguimiento CRM." };
  }

  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");

  return {
    ok: true,
    message: "Mensaje enviado correctamente. Nuestro equipo te contactara pronto.",
  };
}

export async function submitWholesaleRequestAction(input: WholesaleRequestInput): Promise<ContactActionResult> {
  const wholesaleRequestLimit = await checkRateLimit({
    route: "/contacto/mayoreo",
    limit: 4,
    windowSeconds: 15 * 60,
    key: input.email.trim().toLowerCase() || input.phone.trim(),
  });

  if (!wholesaleRequestLimit.ok) {
    return { ok: false, message: getRateLimitMessage(wholesaleRequestLimit.retryAfter) };
  }

  const businessName = requireText(input.businessName, "Nombre del negocio");
  const contactName = requireText(input.contactName, "Nombre de contacto");
  const phone = validateHondurasPhone(input.phone);
  const city = requireText(input.city, "Ciudad");
  const email = normalizeEmail(input.email);

  for (const result of [businessName, contactName, phone, city]) {
    if (!result.ok) {
      return { ok: false, message: "Completa los campos requeridos." };
    }
  }

  const normalizedPhone = phone.ok ? phone.value : "";
  if (!isValidEmail(email)) {
    return { ok: false, message: "Completa los campos requeridos." };
  }

  const supabase = getSupabaseAdminClient();
  const note = [
    "[SOLICITUD_MAYOREO]",
    `Ciudad: ${city.value}`,
    input.taxId.trim() ? `RTN: ${input.taxId.trim()}` : null,
    input.comment.trim() ? `Comentario: ${input.comment.trim()}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const existingCustomerId = await findExistingCustomerId(supabase, email, normalizedPhone);

  const customerPayload = {
    business_name: businessName.value,
    company_name: businessName.value,
    contact_name: contactName.value,
    email,
    phone: normalizedPhone,
    tax_id: optionalText(input.taxId),
    city: city.value,
    notes: note,
    lead_status: "prospecto",
    estimated_value: 0,
    monthly_amount: 0,
    is_wholesale: false,
    wholesale_status: "pending",
    wholesale_requested_at: new Date().toISOString(),
    wholesale_request_source: "formulario_publico",
    wholesale_approved_notice_seen: false,
    status: "pending_account",
    active: true,
  };

  const customerQuery = existingCustomerId
    ? supabase
        .from("customers")
        .update({
          business_name: businessName.value,
          company_name: businessName.value,
          contact_name: contactName.value,
          email,
          phone: normalizedPhone,
          tax_id: optionalText(input.taxId),
          city: city.value,
          notes: note,
          lead_status: "prospecto",
          wholesale_status: "pending",
          wholesale_requested_at: new Date().toISOString(),
          wholesale_request_source: "formulario_publico",
          wholesale_approved_notice_seen: false,
          status: "pending_account",
          active: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingCustomerId)
        .select("id")
        .single<{ id: string }>()
    : supabase.from("customers").insert(customerPayload).select("id").single<{ id: string }>();

  const { data: customer, error: customerError } = await customerQuery;

  if (customerError) {
    return { ok: false, message: "No pudimos guardar tu solicitud. Intenta nuevamente." };
  }

  const { data: existingFollowup } = await supabase
    .from("crm_followups")
    .select("id")
    .eq("customer_id", customer.id)
    .eq("interaction_type", "solicitud_mayorista")
    .eq("status", "pending")
    .limit(1)
    .maybeSingle<{ id: string }>();

  const { error: followupError } = existingFollowup?.id
    ? { error: null }
    : await supabase.from("crm_followups").insert({
        customer_id: customer.id,
        title: "Solicitud de cuenta mayorista",
        interaction_type: "solicitud_mayorista",
        next_action: "Revisar solicitud, validar datos y aprobar si corresponde.",
        priority: "alta",
        phone: normalizedPhone,
        notes: note,
        estimated_value: 0,
        monthly_amount: 0,
        status: "pending",
      });

  if (followupError) {
    return { ok: false, message: "La solicitud se recibio, pero no pudimos crear el seguimiento CRM." };
  }

  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");

  return {
    ok: true,
    message:
      "Recibimos tu solicitud. Nuestro equipo revisara tu cuenta y te notificaremos cuando tengas acceso a precios mayoristas.",
    status: "pending",
  };
}
