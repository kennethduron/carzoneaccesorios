"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { customerCommercialProfileSchema } from "@/lib/validation/customer-commercial-profile";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const requestSchema = z.object({
  requestKey: z.string().uuid(),
  field: z.enum(["businessName", "taxId", "city"]),
  value: z.string().max(200),
});

export type CustomerCommercialField = z.infer<typeof requestSchema>["field"];

export type CustomerCommercialProfileActionResult = {
  ok: boolean;
  code?: string;
  message: string;
  field?: CustomerCommercialField;
};

export async function setMyCustomerCommercialFieldOnceAction(
  input: unknown,
): Promise<CustomerCommercialProfileActionResult> {
  await requireSession();
  const request = requestSchema.safeParse(input);
  if (!request.success) {
    return { ok: false, code: "INVALID_INPUT", message: "Revisa el dato e inténtalo nuevamente." };
  }

  const commercialInput = customerCommercialProfileSchema.safeParse({
    businessName: request.data.field === "businessName" ? request.data.value : null,
    taxId: request.data.field === "taxId" ? request.data.value : null,
    city: request.data.field === "city" ? request.data.value : null,
  });
  if (!commercialInput.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      field: request.data.field,
      message: commercialInput.error.issues[0]?.message ?? "Revisa el dato e inténtalo nuevamente.",
    };
  }

  const requestedValue = commercialInput.data[request.data.field];
  if (!requestedValue) {
    return {
      ok: false,
      code: "FIELD_REQUIRED",
      field: request.data.field,
      message: "Escribe un valor antes de guardar.",
    };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_my_customer_profile_fields_once_v1", {
    p_request_key: request.data.requestKey,
    p_tax_id: request.data.field === "taxId" ? requestedValue : null,
    p_city: request.data.field === "city" ? requestedValue : null,
    p_business_name: request.data.field === "businessName" ? requestedValue : null,
  });

  if (error) {
    return { ok: false, code: "SAVE_FAILED", field: request.data.field, message: "No fue posible guardar el dato. Inténtalo nuevamente." };
  }

  const result = data as { ok?: boolean; code?: string; message?: string; field?: CustomerCommercialField } | null;
  if (!result?.ok) {
    return {
      ok: false,
      code: result?.code ?? "SAVE_FAILED",
      field: result?.field ?? request.data.field,
      message: result?.message ?? "No fue posible guardar el dato. Inténtalo nuevamente.",
    };
  }

  revalidatePath("/cuenta");
  return {
    ok: true,
    code: result.code,
    field: request.data.field,
    message: result.message ?? "Dato comercial guardado correctamente.",
  };
}

export async function markCustomerCreditNotificationReadAction(notificationId: string) {
  const profile = await requireSession();
  const id = notificationId.trim();

  if (!uuidPattern.test(id)) return { ok: false };

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase
    .from("internal_notifications")
    .update({
      read_state: "read",
      read_at: new Date().toISOString(),
      status: "resolved",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", profile.id)
    .eq("notification_type", "commercial_credit.enabled");

  if (error) return { ok: false };
  revalidatePath("/cuenta");
  return { ok: true };
}

export async function claimCustomerWholesaleToastAction(notificationId: string): Promise<{
  ok: boolean;
  notification?: { id: string; title: string; message: string; wholesaleCustomerType: "new" | "existing"; createdAt: string };
}> {
  await requireSession();
  const id = notificationId.trim();
  if (!uuidPattern.test(id)) return { ok: false };

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("mark_customer_portal_notification_toast_shown_v1", { p_notification_id: id });
  if (error) return { ok: false };
  const result = data as unknown as { ok: boolean; notification?: { id: string; title: string; message: string; wholesaleCustomerType: "new" | "existing"; createdAt: string } };
  revalidatePath("/cuenta");
  return result;
}

export async function markCustomerPortalNotificationReadAction(notificationId: string): Promise<{ ok: boolean }> {
  await requireSession();
  const id = notificationId.trim();
  if (!uuidPattern.test(id)) return { ok: false };

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("mark_customer_portal_notification_read_v1", { p_notification_id: id });
  if (error) return { ok: false };
  const result = data as unknown as { ok: boolean };
  if (result.ok) revalidatePath("/cuenta");
  return { ok: result.ok };
}
