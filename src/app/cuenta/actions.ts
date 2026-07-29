"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function markCustomerCreditNotificationReadAction(notificationId: string) {
  const profile = await requireSession();
  const id = notificationId.trim();

  if (!uuidPattern.test(id)) {
    return { ok: false };
  }

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

  if (error) {
    return { ok: false };
  }

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
