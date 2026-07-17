"use server";

import { revalidatePath } from "next/cache";
import { writeErrorLog } from "@/lib/error-logging";
import { notifyPublicFormSubmission, getPublicRequestContext } from "@/lib/public-form-support";
import { checkRateLimit, getRateLimitMessage } from "@/lib/rate-limit";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { requireText, validateHondurasPhone } from "@/utils/validation";

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
