"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function markCustomerCreditNotificationReadAction(notificationId: string) {
  const profile = await requireSession();
  const id = notificationId.trim();

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
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
