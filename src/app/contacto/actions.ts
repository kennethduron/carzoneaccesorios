"use server";

import { revalidatePath } from "next/cache";
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

type WholesaleRequestResult = {
  ok: boolean;
  message: string;
};

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function submitWholesaleRequestAction(input: WholesaleRequestInput): Promise<WholesaleRequestResult> {
  const businessName = requireText(input.businessName, "Nombre del negocio");
  const contactName = requireText(input.contactName, "Nombre de contacto");
  const phone = validateHondurasPhone(input.phone);
  const city = requireText(input.city, "Ciudad");
  const email = normalizeEmail(input.email);

  for (const result of [businessName, contactName, phone, city]) {
    if (!result.ok) {
      return { ok: false, message: result.message };
    }
  }

  if (!isValidEmail(email)) {
    return { ok: false, message: "Ingresa un correo electrónico válido." };
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

  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .insert({
      business_name: businessName.value,
      company_name: businessName.value,
      contact_name: contactName.value,
      email,
      phone: phone.value,
      tax_id: optionalText(input.taxId),
      city: city.value,
      notes: note,
      lead_status: "prospecto",
      estimated_value: 0,
      monthly_amount: 0,
      is_wholesale: false,
      status: "pending_account",
      active: false,
    })
    .select("id")
    .single<{ id: string }>();

  if (customerError) {
    return { ok: false, message: "No pudimos guardar tu solicitud. Intenta nuevamente." };
  }

  const { error: followupError } = await supabase.from("crm_followups").insert({
    customer_id: customer.id,
    title: "Solicitud de cuenta mayorista",
    interaction_type: "prospecto",
    next_action: "Revisar solicitud, validar datos y aprobar si corresponde.",
    priority: "alta",
    phone: phone.value,
    notes: note,
    estimated_value: 0,
    monthly_amount: 0,
    status: "pending",
  });

  if (followupError) {
    return { ok: false, message: "La solicitud se recibió, pero no pudimos crear el seguimiento CRM." };
  }

  revalidatePath("/admin/crm");
  revalidatePath("/admin/clientes");

  return {
    ok: true,
    message: "Solicitud enviada correctamente. Nuestro equipo revisará tu información antes de aprobar precios mayoristas.",
  };
}
