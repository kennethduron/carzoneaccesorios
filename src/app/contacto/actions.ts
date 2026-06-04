"use server";

import { revalidatePath } from "next/cache";
import { writeErrorLog } from "@/lib/error-logging";
import { notifyPublicFormSubmission, getPublicRequestContext } from "@/lib/public-form-support";
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

type GeneralContactRpcRow = {
  customer_id: string;
  followup_id: string;
  assigned_user_id: string | null;
  due_at: string;
};

type WholesaleRequestRpcRow = GeneralContactRpcRow & {
  outcome: "created" | "pending" | "approved" | "suspended" | "rejected_review";
};

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function sanitizePublicText(value: unknown) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function revalidatePublicFormAdminPaths() {
  revalidatePath("/admin");
  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");
  revalidatePath("/admin/clientes-mayoristas");
}

export async function submitGeneralContactAction(input: GeneralContactInput): Promise<ContactActionResult> {
  const email = normalizeEmail(input.email);
  const rawPhone = sanitizePublicText(input.phone);
  const contactLimit = await checkRateLimit({
    route: "/contacto",
    limit: 5,
    windowSeconds: 10 * 60,
    key: email || rawPhone,
  });

  if (!contactLimit.ok) {
    return { ok: false, message: getRateLimitMessage(contactLimit.retryAfter) };
  }

  const name = requireText(sanitizePublicText(input.name), "Nombre");
  const phone = validateHondurasPhone(rawPhone);
  const message = requireText(sanitizePublicText(input.message), "Mensaje", 1200);

  if (!name.ok || !phone.ok || !message.ok) {
    return { ok: false, message: "Completa los campos requeridos." };
  }

  if (!isValidEmail(email)) {
    return { ok: false, message: "Completa los campos requeridos." };
  }

  const context = await getPublicRequestContext();
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("submit_public_general_contact", {
      p_contact_name: name.value,
      p_email: email,
      p_phone: phone.value,
      p_message: message.value,
      p_ip_address: context.ipAddress,
      p_user_agent: context.userAgent,
    });
  const result = (data as GeneralContactRpcRow[] | null)?.[0];

  if (error || !result) {
    await writeErrorLog({
      route: "/contacto",
      action: "public_forms.contact_general_save_failed",
      errorMessage: error?.message ?? "No se obtuvo confirmación del formulario.",
      userEmail: email,
      metadata: { origin: "contacto_general", phone: phone.value },
    });
    return { ok: false, message: "No pudimos guardar tu mensaje. Intenta nuevamente." };
  }

  await notifyPublicFormSubmission({
    kind: "contact_general",
    customerId: result.customer_id,
    followupId: result.followup_id,
    name: name.value,
    email,
    phone: phone.value,
    message: message.value,
    context,
  });
  revalidatePublicFormAdminPaths();

  return {
    ok: true,
    message: "Mensaje enviado correctamente. Nuestro equipo te responderá pronto.",
  };
}

export async function submitWholesaleRequestAction(input: WholesaleRequestInput): Promise<ContactActionResult> {
  const email = normalizeEmail(input.email);
  const rawPhone = sanitizePublicText(input.phone);
  const wholesaleRequestLimit = await checkRateLimit({
    route: "/contacto/mayoreo",
    limit: 4,
    windowSeconds: 15 * 60,
    key: email || rawPhone,
  });

  if (!wholesaleRequestLimit.ok) {
    return { ok: false, message: getRateLimitMessage(wholesaleRequestLimit.retryAfter) };
  }

  const businessName = requireText(sanitizePublicText(input.businessName), "Nombre del negocio");
  const contactName = requireText(sanitizePublicText(input.contactName), "Nombre de contacto");
  const phone = validateHondurasPhone(rawPhone);
  const city = requireText(sanitizePublicText(input.city), "Ciudad");
  const taxId = optionalText(sanitizePublicText(input.taxId));
  const comment = optionalText(sanitizePublicText(input.comment));

  if (!businessName.ok || !contactName.ok || !phone.ok || !city.ok) {
    return { ok: false, message: "Completa los campos requeridos." };
  }

  if (!isValidEmail(email)) {
    return { ok: false, message: "Completa los campos requeridos." };
  }

  const context = await getPublicRequestContext();
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("submit_public_wholesale_request", {
      p_business_name: businessName.value,
      p_contact_name: contactName.value,
      p_email: email,
      p_phone: phone.value,
      p_city: city.value,
      p_tax_id: taxId,
      p_comment: comment,
      p_ip_address: context.ipAddress,
      p_user_agent: context.userAgent,
    });
  const result = (data as WholesaleRequestRpcRow[] | null)?.[0];

  if (error || !result) {
    await writeErrorLog({
      route: "/contacto/mayoreo",
      action: "public_forms.wholesale_save_failed",
      errorMessage: error?.message ?? "No se obtuvo confirmación de la solicitud.",
      userEmail: email,
      metadata: { origin: "formulario_publico", phone: phone.value },
    });
    return { ok: false, message: "No pudimos guardar tu solicitud. Intenta nuevamente." };
  }

  if (result.outcome === "approved") {
    return {
      ok: false,
      message: "Tu cuenta mayorista ya está aprobada. Inicia sesión para comprar con precio mayorista.",
      status: "approved",
    };
  }

  if (result.outcome === "suspended") {
    return {
      ok: false,
      message: "Tu acceso mayorista está suspendido. Contacta a servicio al cliente.",
      status: "suspended",
    };
  }

  await notifyPublicFormSubmission({
    kind: "wholesale",
    customerId: result.customer_id,
    followupId: result.followup_id,
    name: contactName.value,
    email,
    phone: phone.value,
    businessName: businessName.value,
    taxId,
    city: city.value,
    comment,
    outcome: result.outcome,
    context,
  });
  revalidatePublicFormAdminPaths();

  if (result.outcome === "pending") {
    return { ok: true, message: "Tu solicitud ya está pendiente de revisión.", status: "pending" };
  }

  if (result.outcome === "rejected_review") {
    return { ok: true, message: "Recibimos tu mensaje. Nuestro equipo revisará tu caso.", status: "rejected" };
  }

  return {
    ok: true,
    message: "Solicitud enviada correctamente. Revisaremos tu información.",
    status: "pending",
  };
}
